// herdr-files: the Files panel with folder navigation (parent, system picker,
// typed path, back to the project folder) and local Markdown/text editing with
// an explicit, conflict-guarded Save.
//
// This file is a modified version of the `files` mod shipped with the Herdr app
// (mods/files/main.js, Herdr 0.1.15), which is licensed under the Apache License,
// Version 2.0; see ../../LICENSES/Apache-2.0.txt and ../../THIRD-PARTY-NOTICES.md.
// Changes from the original, made for herdr-files: a per-space manual root
// (parent folder, picker, typed path, reset), absolute paths with a "/" root,
// no folder watch for "/" or the home folder, the open document moved to
// core.js's DocController (editable state, guarded Save, conflict and deleted
// handling, unsaved-changes prompt, stale-load tokens), header buttons and
// banners, Cmd-S/Ctrl-S, and the save and selftest commands.
import { View, div, svg } from "gpui-kit";
import { v_flex, h_flex, Editor, EditorState, InputState, Input } from "gpui-base";
import { spaces, panes, focused, exec, readTextFile, writeTextFile, watchFolder, pickFolder, home, theme, settings, window, nextCommand, notify } from "herdr";
import { DocController, rememberedFile, keepsDoc, joinPath, parentDir, baseName, resolveInput, trimSlash, extension, READONLY_LABEL } from "./core.js";
import { selftest } from "./selftest.js";

// Where the focused pane is (the "project folder"), as the shipped panel does it.
function paneLocation() {
  const space = spaces().find(s => s.active), f = focused();
  const pane = f?.pane ? panes().find(p => p.pane === f.pane) : null;
  const on = f?.pane === null ? (f.terminal?.includes("/") ? f.terminal.split("/")[0] : null) : space?.machine ?? null;
  return { cwd: pane?.cwd || f?.cwd || space?.folder, on, space: space?.id };
}
const LANG = { ts: "js", tsx: "js", mts: "js", cts: "js", jsx: "js", mjs: "js", toml: "yaml", jsonc: "json", svelte: "html", vue: "html", markdown: "md", mdx: "md", text: "txt" };
const PER_FOLDER = 500, TOTAL = 5000;

export function makeEditorState({ value, readonly, path }) {
  const t = theme(), ext = extension(path);
  return EditorState.new({ language: LANG[ext] ?? ext, readonly, value, soft_wrap: !readonly,
    font_family: settings().font_family, font_size: 12,
    syntax: { keyword: t.ansi5, string: t.ansi2, comment: t.dim, function: t.ansi4, type: t.ansi3, number: t.ansi1, constant: t.ansi6 } });
}

async function directory(path, on) {
  const windowsDirectory = async () => {
    // Windows PowerShell otherwise uses the console code page; exec decodes UTF-8.
    // Links keep directory attributes even when dangling; check their target.
    // Other reparse points (OneDrive's folders) have no LinkType and are folders.
    // PowerShell reads curly single quotes as quotes too, so they're doubled like '.
    const r = await exec("powershell", ["-NoProfile", "-Command", "[Console]::OutputEncoding = [System.Text.UTF8Encoding]::new($false); & { param($p) @(Get-ChildItem -LiteralPath $p -Force -ErrorAction Stop | Where-Object Name -ne '.git' | Select-Object -First 501 | ForEach-Object { @{ name=$_.Name; dir=($_.PSIsContainer -and (-not ($_.Attributes -band [IO.FileAttributes]::ReparsePoint) -or -not $_.LinkType -or ($_.Target -and [IO.Directory]::Exists(([IO.Path]::Combine([IO.Path]::GetDirectoryName($_.FullName), $_.Target[0])))))) } }) | ConvertTo-Json -Compress } '" + path.replace(/['‘’‚‛]/g, "$&$&") + "'"], { on });
    if (r.code !== 0) throw new Error(r.stderr || "Cannot list this folder");
    const result = JSON.parse(r.stdout || "[]");
    return Array.isArray(result) ? result : [result];
  };
  if (!on && window()?.platform === "windows") return windowsDirectory();
  const script = 'n=0; for p in "$1"/* "$1"/.[!.]* "$1"/..?*; do [ -e "$p" ] || [ -L "$p" ] || continue; name=${p##*/}; [ "$name" = .git ] && continue; if [ -d "$p" ]; then kind=d; else kind=f; fi; printf "%s\\0%s\\0" "$kind" "$name"; n=$((n+1)); [ "$n" -gt 500 ] && break; done; test -d "$1"';
  let r;
  try { r = await exec("sh", ["-c", script, "files", path], { on }); }
  catch (e) {
    if (on && String(e).includes("cannot start sh: program not found")) return windowsDirectory();
    throw e;
  }
  if (r.code !== 0) throw new Error(r.stderr || "Cannot list this folder");
  const fields = r.stdout.split("\0"), out = [];
  for (let i = 0; i + 1 < fields.length; i += 2) out.push({ name: fields[i + 1], dir: fields[i] === "d" });
  return out;
}

export default class Files extends View {
  init(_props, cx) {
    this.saved = new Map();
    this.entries = new Map(); this.folders = new Set(); this.pending = new Set(); this.marks = {};
    // Per-space manual root: space id -> { cwd, on }. Absent: follow the focused pane.
    this.roots = new Map();
    try { for (const [k, v] of JSON.parse(localStorage.getItem("roots") || "[]")) if (v?.cwd) this.roots.set(k, v); } catch {}
    this.docs = new DocController({
      read: (path, on) => readTextFile(path, { on }),
      write: (path, text, expected) => writeTextFile(path, text, expected),
      makeState: makeEditorState,
    });
    this.pathInput = InputState.new({ placeholder: "Folder path (spaces OK, ~ and relative)" });
    this.pathInput.on("submit", (_e, cx) => this.goPath(cx));
    this.refresh(cx);
    cx.timer.every(10000, cx => this.refresh(cx));
    cx.spawn(async cx => {
      for (;;) {
        const c = await nextCommand();
        if (c === "save") this.save("normal", cx);
        else if (c === "selftest") await selftest(cx, makeEditorState).catch(e => notify({ title: "herdr-files selftest", body: String(e), level: "error" }));
        cx.notify();
      }
    });
  }

  async close() { this.docs.close(); this.pathInput?.release(); }

  location() {
    const base = paneLocation(), manual = base.space ? this.roots.get(base.space) : null;
    if (manual && (manual.on ?? null) === (base.on ?? null)) return { ...base, cwd: manual.cwd, manual: true };
    return { ...base, manual: false };
  }
  key() { const { cwd, on, space } = this.location(); return JSON.stringify({ cwd, on, space }); }

  watch(root, cx) {
    // A whole disk or home is too much to watch; the 10 s timer still refreshes.
    if (this.on || this.watched === root || root === "/" || root === home()) return;
    this.watched = root;
    const context = this.context;
    cx.spawn(async cx => {
      try { while (this.context === context) { await watchFolder(root); if (this.current(context)) this.refresh(cx); } }
      catch { if (this.context === context) this.watched = null; }
    });
  }

  current(context) {
    return this.context === context && this.key() === context.key;
  }

  async loadFolder(path, context) {
    const { on, cwd: root } = context;
    const entries = await directory(joinPath(root, path), on);
    if (!this.current(context) || (path && !this.folders.has(path))) return;
    const used = [...this.entries.entries()].filter(([p]) => p !== path).reduce((n, [, e]) => n + e.length, 0);
    this.entries.set(path, entries.slice(0, Math.max(0, Math.min(PER_FOLDER, TOTAL - used))).sort((a, b) => Number(b.dir) - Number(a.dir) || a.name.localeCompare(b.name)));
    if (entries.length > PER_FOLDER || used + entries.length > TOTAL) this.limited = true;
  }

  refresh(cx) {
    const { cwd, on, manual } = this.location(), next = this.key();
    if (next !== this.context?.key) {
      const doc = this.docs.doc;
      if (this.context) this.saved.set(this.context.key, { folders: this.folders, file: rememberedFile(doc, this.docOrigin, this.context.key) });
      const saved = this.saved.get(next);
      this.context = { key: next, cwd, on }; this.root = cwd; this.on = on; this.manual = manual; this.entries = new Map(); this.folders = new Set(saved?.folders);
      this.pending = new Set(); this.marks = {}; this.watched = null; this.error = null; this.limited = false;
      this.loading = false; this.pathOpen = false; this.pathError = null; this.pathSeq = (this.pathSeq ?? 0) + 1;
      // An unsaved, saving or conflicted document stays open across space and folder changes,
      // and the file this context remembers is not reopened if it is already open.
      if (keepsDoc(this.docs.held, doc, saved?.file)) {
        if (saved?.file && doc?.path === saved.file.path) this.docOrigin = next;
      } else {
        this.docs.close();
        if (saved?.file) this.openFile(saved.file.path, saved.file.on, cx);
      }
    }
    if (!cwd || this.loading) return;
    const context = this.context;
    this.loading = true;
    this.limited = false;
    cx.spawn(async cx => {
      try {
        for (const path of ["", ...this.folders]) {
          if (!this.current(context)) return;
          await this.loadFolder(path, context);
        }
        const top = await exec("git", ["rev-parse", "--show-toplevel"], { cwd, on }).catch(() => null);
        const marks = {};
        if (top?.code === 0) {
          // Writes nothing under .git (index lock, fsmonitor cookie): the folder watch would refresh again.
          const status = await exec("git", ["--no-optional-locks", "-c", "core.fsmonitor=false", "status", "--porcelain=v1", "-z", "--no-renames", "--untracked-files=all"], { cwd, on }).catch(() => null);
          if (status?.code === 0) for (const entry of status.stdout.split("\0").filter(Boolean).slice(0, TOTAL)) {
            const xy = entry.slice(0, 2);
            marks[joinPath(top.stdout.trim(), entry.slice(3))] = xy === "??" || xy.includes("A") ? "A" : xy.includes("U") ? "U" : xy.includes("D") ? "D" : "M";
          }
        }
        if (!this.current(context)) return;
        this.marks = marks; this.error = null; this.watch(cwd, cx);
      } catch (e) { if (this.current(context)) this.error = String(e); }
      finally { if (this.context === context) this.loading = false; cx.notify(); }
    });
  }

  toggle(path, cx) {
    if (this.folders.has(path)) {
      for (const folder of [...this.folders]) if (folder === path || folder.startsWith(path + "/")) {
        this.folders.delete(folder);
        this.entries.delete(folder);
      }
    } else {
      this.folders.add(path);
      if (!this.entries.has(path) && !this.pending.has(path)) {
        const context = this.context;
        this.pending.add(path);
        cx.spawn(async cx => {
          try { await this.loadFolder(path, context); }
          catch (e) { if (this.current(context)) this.error = String(e); }
          finally { if (this.context === context) this.pending.delete(path); cx.notify(); }
        });
      }
    }
    cx.notify();
  }

  // ---- folder navigation ----

  setRoot(cwd, cx) {
    const space = paneLocation().space, on = paneLocation().on ?? null;
    if (!space) return;
    if (cwd == null) this.roots.delete(space); else this.roots.set(space, { cwd: trimSlash(cwd), on });
    try { localStorage.setItem("roots", JSON.stringify([...this.roots])); } catch {}
    this.refresh(cx);
    cx.notify();
  }

  pick(cx) {
    if (this.picking || this.on) return;
    this.picking = true;
    const space = paneLocation().space;
    cx.spawn(async cx => {
      try {
        const folder = await pickFolder({ prompt: "Show in Files" });
        if (folder && paneLocation().space === space && !this.docs.doc) this.setRoot(folder, cx);
      } catch (e) { if (paneLocation().space === space) this.error = String(e); }
      finally { this.picking = false; cx.notify(); }
    });
  }

  openPath(cx) {
    this.pathSeq = (this.pathSeq ?? 0) + 1;
    this.pathOpen = true; this.pathError = null;
    this.pathInput.set_value(this.root ?? "");
    this.pathInput.focus();
    cx.notify();
  }

  goPath(cx) {
    const on = this.on ?? null, space = paneLocation().space;
    const target = resolveInput(this.pathInput.value(), this.root, on ? null : home());
    if (!target) { this.pathError = "Enter a folder path"; cx.notify(); return; }
    this.pathError = null;
    const seq = this.pathSeq = (this.pathSeq ?? 0) + 1;
    cx.spawn(async cx => {
      const r = await exec("test", ["-d", target], { on }).catch(() => null);
      // Dropped if anything moved on meanwhile: another Go, the bar closed, a new root, a file opened.
      if (seq !== this.pathSeq || !this.pathOpen || this.docs.doc || paneLocation().space !== space || (this.on ?? null) !== on) return;
      if (r?.code === 0) { this.pathOpen = false; this.setRoot(target, cx); }
      else this.pathError = `Not a folder: ${target}`;
      cx.notify();
    });
  }

  // ---- the document ----

  openFile(path, on, cx) {
    this.pathSeq = (this.pathSeq ?? 0) + 1;
    this.docOrigin = this.context?.key;
    this.docs.close();
    cx.spawn(async cx => { await this.docs.open(path, on ?? null); cx.notify(); });
  }

  // Close or switch files only when nothing unsaved would be lost; otherwise ask.
  navigate(nav, cx) {
    if (this.docs.request(nav)) this.runNav(nav, cx);
    cx.notify();
  }

  runNav(nav, cx) {
    if (nav.kind === "open") this.openFile(nav.path, nav.on, cx);
    else this.docs.close();
  }

  resolve(choice, cx) {
    const p = this.docs.resolve(choice);
    cx.notify();
    cx.spawn(async cx => { const nav = await p; if (nav) this.runNav(nav, cx); cx.notify(); });
  }

  save(mode, cx) {
    if (!this.docs.editable || this.docs.doc.saving) return;
    const p = this.docs.save(mode);
    cx.notify();
    cx.spawn(async cx => { await p; cx.notify(); });
  }

  reload(cx) {
    const d = this.docs.doc;
    if (!d || d.saving) return;
    this.openFile(d.path, d.on, cx);
    cx.notify();
  }

  // ---- drawing ----

  button(id, label, onClick, t, { primary = false, dim = false, danger = false } = {}) {
    return h_flex().id(id).flex_none().px(7).h(22).rounded(6).items_center().justify_center().cursor_pointer().text_size(12)
      .bg(primary && !dim ? t.solid : t.surface).text_color(primary && !dim ? t.solid_foreground : danger ? t.ansi1 : dim ? t.dim : t.foreground)
      .border_1().border_color(t.border).hover(s => s.bg(primary && !dim ? t.solid : t.hover))
      .on_mouse_down("left", (_e, cx) => cx.stop_propagation())
      .on_click((_e, cx) => onClick(cx)).child(label);
  }

  banner(id, text, buttons, t, color) {
    return v_flex().id(id).flex_none().gap(6).px(12).py(8).border_b(1).border_color(t.border).bg(t.raised)
      .child(div().text_size(12).text_color(color ?? t.foreground).child(text))
      .child(h_flex().gap(6).flex_wrap().children(buttons));
  }

  rows(prefix, depth, out, t) {
    if (out.length >= TOTAL || depth > 40) return out;
    for (const entry of this.entries.get(prefix) ?? []) {
      if (out.length >= TOTAL) break;
      const path = prefix ? `${prefix}/${entry.name}` : entry.name, open = this.folders.has(path), mark = this.marks[joinPath(this.root, path)];
      out.push(h_flex().id(`file-${path}`).h(28).flex_none().pl(8 + depth * 18).pr(8).gap(7).items_center().rounded(7).cursor_pointer().hover(s => s.bg(t.hover))
        .on_click((_e, cx) => entry.dir ? this.toggle(path, cx) : this.navigate({ kind: "open", path: joinPath(this.root, path), on: this.on ?? null }, cx))
        .child(entry.dir ? svg(`mods/herdr-files/chevron-${open ? "down" : "right"}.svg`).size(12).flex_none().text_color(t.dim) : div().w(12).flex_none())
        .child(svg(`mods/herdr-files/${entry.dir ? "folder" : "file"}.svg`).size(14).flex_none().text_color(t.muted))
        .child(div().flex_1().min_w(0).truncate().child(entry.name))
        .when(Boolean(mark), el => el.child(div().text_size(11).text_color(mark === "A" ? t.ansi2 : mark === "D" || mark === "U" ? t.ansi1 : t.blocked).child(mark))));
      if (entry.dir && open) this.rows(path, depth + 1, out, t);
    }
    return out;
  }

  treeView(el, t) {
    const parent = this.root ? parentDir(this.root) : null;
    return el
      .child(h_flex().h(42).flex_none().px(12).gap(6).items_center().border_b(1).border_color(t.border)
        .child(div().font_semibold().child("Files"))
        .child(div().flex_1().min_w(0).truncate().text_size(12).text_color(t.dim).child(baseName(this.root ?? "") ?? ""))
        .when(Boolean(parent), el => el.child(this.button("gf-up", "↑", cx => this.setRoot(parent, cx), t)))
        .when(!this.on, el => el.child(this.button("gf-pick", this.picking ? "…" : "Open…", cx => this.pick(cx), t)))
        .child(this.button("gf-path", "Path", cx => { if (this.pathOpen) { this.pathOpen = false; this.pathSeq = (this.pathSeq ?? 0) + 1; cx.notify(); } else this.openPath(cx); }, t))
        .when(this.manual, el => el.child(this.button("gf-project", "Project", cx => this.setRoot(null, cx), t))))
      .child(h_flex().h(24).flex_none().px(12).gap(6).items_center().border_b(1).border_color(t.border).text_size(11).text_color(t.dim)
        .when(Boolean(this.on), el => el.child(div().flex_none().text_color(t.blocked).child(`${this.on}:`)))
        .child(div().flex_1().min_w(0).truncate().child(this.root ?? "No folder"))
        .when(this.manual, el => el.child(div().flex_none().text_color(t.accent).child("manual"))))
      .when(this.pathOpen, el => el.child(v_flex().flex_none().gap(4).px(10).py(6).border_b(1).border_color(t.border)
        .child(h_flex().gap(6).items_center()
          .child(div().flex_1().min_w(0).h(26).px(6).rounded(6).border_1().border_color(t.input).bg(t.surface).child(Input.new(this.pathInput)))
          .child(this.button("gf-go", "Go", cx => this.goPath(cx), t, { primary: true })))
        .when(Boolean(this.pathError), el => el.child(div().text_size(11).text_color(t.ansi1).child(this.pathError)))))
      .child(v_flex().id("files-tree").flex_1().min_h(0).overflow_y_scrollbar().p(6).children(this.rows("", 0, [], t))
        .when(Boolean(this.error) || !this.entries.get("")?.length, el => el.child(div().p(8).text_size(12).text_color(t.dim).child(this.error || (this.loading ? "Loading files…" : this.root ? "No files" : "No folder"))))
        .when(this.limited, el => el.child(div().p(8).text_size(11).text_color(t.dim).child("File list limited to 500 entries per folder and 5,000 total"))));
  }

  docView(el, t) {
    const d = this.docs.doc, name = baseName(d.path), editable = this.docs.editable;
    const status = d.loading ? "Loading…" : d.saving ? "Saving…" : d.readonly ? READONLY_LABEL[d.readonly] : editable ? (d.dirty ? "Modified" : "Saved") : "";
    const copyMine = this.button("gf-copy", "Copy mine", cx => { cx.write_to_clipboard(d.state.value()); }, t);
    return el
      .child(h_flex().h(42).flex_none().px(12).gap(6).items_center().border_b(1).border_color(t.border)
        .child(div().id("files-back").w(20).flex_none().cursor_pointer().text_color(t.muted).on_click((_e, cx) => this.navigate({ kind: "close" }, cx)).child("←"))
        .child(div().flex_1().min_w(0).truncate().font_semibold().child(name))
        .when(d.dirty, el => el.child(div().flex_none().text_color(t.blocked).child("●")))
        .child(div().flex_none().text_size(11).text_color(d.readonly ? t.blocked : t.dim).child(status))
        .when(editable && d.dirty && !d.saving, el => el.child(this.button("gf-revert", "Revert", cx => { this.docs.revert(); cx.notify(); }, t)))
        .when(editable, el => el.child(this.button("gf-save", "Save", cx => this.save("normal", cx), t, { primary: true, dim: !d.dirty || d.saving }))))
      .child(h_flex().h(24).flex_none().px(12).items_center().border_b(1).border_color(t.border).text_size(11).text_color(t.dim)
        .child(div().flex_1().min_w(0).truncate().child(d.on ? `${d.on}:${d.path}` : d.path)))
      .when(Boolean(this.docs.pendingNav), el => el.child(this.banner("gf-pending", d.saving ? `Saving ${name}…` : `Unsaved changes to ${name}.`, [
        this.button("gf-p-save", "Save", cx => this.resolve("save", cx), t, { primary: true, dim: d.saving }),
        this.button("gf-p-discard", "Discard", cx => this.resolve("discard", cx), t, { danger: !d.saving, dim: d.saving }),
        this.button("gf-p-cancel", "Cancel", cx => this.resolve("cancel", cx), t)], t)))
      .when(typeof d.conflict?.disk === "string", el => el.child(this.banner("gf-conflict", "Changed on disk since it was opened. Not saved.", [
        this.button("gf-c-reload", "Discard mine, reload", cx => this.reload(cx), t, { danger: !d.saving, dim: d.saving }),
        this.button("gf-c-overwrite", "Overwrite disk", cx => this.save("overwrite", cx), t, { dim: d.saving }),
        copyMine], t, t.blocked)))
      .when(Boolean(d.conflict?.deleted), el => el.child(this.banner("gf-deleted", "Deleted on disk. Not saved.", [
        this.button("gf-d-recreate", "Recreate", cx => this.save("recreate", cx), t),
        copyMine], t, t.blocked)))
      .when(Boolean(d.saveError), el => el.child(this.banner("gf-error", `Save failed: ${d.saveError}`, [], t, t.ansi1)))
      .child(d.state
        ? v_flex().id("gf-editor").flex_1().min_h(0)
            .on_key_down((e, cx) => { if (e.keystroke === "cmd-s" || e.keystroke === "ctrl-s") { this.save("normal", cx); cx.stop_propagation(); } })
            .child(Editor.new(d.state).flex_1().min_h(0))
        : div().p(12).text_color(t.dim).child(d.message || "Loading file…"));
  }

  render(cx) {
    if (this.key() !== this.context?.key) this.refresh(cx);
    const t = theme();
    const el = v_flex().id("files").size_full().min_h(0).rounded(10).overflow_hidden().bg(t.background).border_1().border_color(t.border).text_color(t.foreground).text_size(13);
    return this.docs.doc ? this.docView(el, t) : this.treeView(el, t);
  }
}
