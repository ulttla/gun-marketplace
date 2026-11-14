// Pure logic for herdr-files: paths, file classification and the open document.
// No herdr/gpui imports, so Node tests can drive it with fake IO.

// Marks this folder as installed by the herdr-files package (install/uninstall check it).
export const PACKAGE = "herdr-files";

export const EDITABLE = new Set(["md", "markdown", "mdx", "txt", "text"]);
export const MAX_CHARS = 400000;
// readTextFile reads at most 1 MiB; text this close to it may be cut short.
export const MAX_BYTES = 1048576 - 4;

export function trimSlash(p) {
  if (!p) return p;
  const t = p.replace(/\/+$/, "");
  return t || "/";
}

export function joinPath(root, rel) {
  if (!rel) return root;
  return root === "/" ? `/${rel}` : `${root}/${rel}`;
}

export function parentDir(p) {
  const t = trimSlash(p);
  if (!t || t === "/" || !t.startsWith("/")) return null;
  const i = t.lastIndexOf("/");
  return i <= 0 ? "/" : t.slice(0, i);
}

export function baseName(p) {
  const t = trimSlash(p ?? "");
  return t === "/" ? "/" : t.split("/").pop();
}

// Typed or pasted path -> absolute normalized path, or null.
// Accepts spaces, surrounding quotes, shell-escaped spaces ("Work\ Dir"), ~ and relative paths.
export function resolveInput(input, base, home) {
  let s = String(input ?? "").trim();
  if (s.length >= 2 && (s[0] === '"' || s[0] === "'") && s[s.length - 1] === s[0]) s = s.slice(1, -1);
  s = s.replace(/\\ /g, " ");
  if (!s) return null;
  if (s === "~" || s.startsWith("~/")) {
    if (!home) return null;
    s = home + s.slice(1);
  } else if (!s.startsWith("/")) {
    if (!base) return null;
    s = joinPath(base, s);
  }
  const out = [];
  for (const part of s.split("/")) {
    if (!part || part === ".") continue;
    if (part === "..") out.pop(); else out.push(part);
  }
  return "/" + out.join("/");
}

export function utf8Bytes(text) {
  let n = 0;
  for (let i = 0; i < text.length; i++) {
    const c = text.charCodeAt(i);
    if (c < 0x80) n += 1;
    else if (c < 0x800) n += 2;
    else if (c >= 0xd800 && c <= 0xdbff) { n += 4; i++; }
    else n += 3;
  }
  return n;
}

export function extension(path) {
  const name = baseName(path) ?? "";
  return name.includes(".") ? name.split(".").pop().toLowerCase() : "txt";
}

// What the panel may do with a read result. `text`: readTextFile's result (null = missing).
export function classify(path, text, on) {
  if (text === null || text === undefined) return { kind: "missing", message: "This file is no longer available" };
  if (text.includes("\0")) return { kind: "binary", message: "Binary file · no text preview" };
  if (text.length > MAX_CHARS || utf8Bytes(text) >= MAX_BYTES)
    return { kind: "text", readonly: "truncated", value: text.slice(0, MAX_CHARS) + "\n… (file truncated)" };
  if (on) return { kind: "text", readonly: "remote", value: text };
  if (!EDITABLE.has(extension(path))) return { kind: "text", readonly: "preview", value: text };
  return { kind: "text", readonly: null, value: text };
}

// Which file a context should remember when it is left: only a document opened in it.
export function rememberedFile(doc, originKey, leavingKey) {
  return doc && originKey === leavingKey ? { path: doc.path, on: doc.on ?? null } : null;
}

// Entering a context: keep the open document if it is held, or if it is the file that context remembers.
export function keepsDoc(held, doc, file) {
  return Boolean(held || (doc && file && doc.path === file.path && (doc.on ?? null) === (file.on ?? null)));
}

export const READONLY_LABEL = {
  remote: "Read-only · remote",
  truncated: "Read-only · truncated",
  preview: "Read-only · preview",
};

// The one open document. io: { read(path, on), write(path, text, expected), makeState({ value, readonly, path }) }.
// makeState returns an EditorState-like object: value(), set_value(), on("change", fn), release().
export class DocController {
  constructor(io) {
    this.io = io;
    this.doc = null;
    this.seq = 0;
    this.pendingNav = null;
  }

  get dirty() { return Boolean(this.doc?.dirty); }
  // A document that must not be closed without the person deciding.
  get held() { const d = this.doc; return Boolean(d && (d.dirty || d.saving || d.conflict)); }

  close() {
    this.seq++;
    this.doc?.state?.release();
    this.doc = null;
    this.pendingNav = null;
  }

  // Loads a file. Resolves false when a newer open/close superseded it.
  async open(path, on) {
    this.close();
    const seq = this.seq;
    const doc = { path, on: on ?? null, loading: true, state: null, saved: null, dirty: false,
      saving: false, conflict: null, saveError: null, readonly: null, message: null };
    this.doc = doc;
    let text, failed = false;
    try { text = await this.io.read(path, on ?? null); } catch { failed = true; }
    if (seq !== this.seq || this.doc !== doc) return false;
    doc.loading = false;
    if (failed) { doc.message = "Cannot preview this file (binary, larger than 1 MiB, or unreadable)"; return true; }
    const c = classify(path, text, on);
    if (c.kind !== "text") { doc.message = c.message; return true; }
    doc.readonly = c.readonly;
    const editable = !c.readonly;
    doc.saved = c.value;
    doc.state = this.io.makeState({ value: c.value, readonly: !editable, path });
    if (editable) doc.state.on("change", (_e, cx) => this.changed(doc, cx));
    return true;
  }

  get editable() { const d = this.doc; return Boolean(d && d.state && !d.readonly); }

  changed(doc, cx) {
    if (this.doc !== doc || !doc.state) return;
    const was = doc.dirty;
    doc.dirty = doc.state.value() !== doc.saved;
    if (was !== doc.dirty || doc.saveError) { doc.saveError = null; cx?.notify?.(); }
  }

  // mode: "normal" | "overwrite" (replace what's on disk now) | "recreate" (file was deleted).
  // Resolves "saved", "clean", "busy", "conflict", "deleted" or "failed".
  async save(mode = "normal") {
    const d = this.doc;
    if (!d || !d.state || d.readonly || d.loading) return "failed";
    if (d.saving) return "busy";
    const text = d.state.value();
    let expected = d.saved;
    if (mode === "overwrite") {
      if (typeof d.conflict?.disk !== "string") return "failed";
      expected = d.conflict.disk;
    } else if (mode === "recreate") {
      if (!d.conflict?.deleted) return "failed";
      expected = null;
    } else if (text === d.saved && !d.conflict) return "clean";
    d.saving = true; d.saveError = null;
    try {
      await this.io.write(d.path, text, expected);
      // Closed meanwhile: its editor may be released, nothing left to update.
      if (this.doc !== d) return "saved";
      d.saved = text; d.conflict = null;
      d.dirty = d.state ? d.state.value() !== d.saved : false;
      return "saved";
    } catch (e) {
      let latest;
      try { latest = await this.io.read(d.path, null); } catch { latest = undefined; }
      if (this.doc !== d) return "failed";
      if (latest === null) { d.conflict = { deleted: true }; return "deleted"; }
      if (typeof latest === "string" && latest !== expected) { d.conflict = { disk: latest }; return "conflict"; }
      d.saveError = String(e?.message ?? e ?? "Save failed");
      return "failed";
    } finally {
      d.saving = false;
    }
  }

  // Throws away unsaved text, keeping the file open.
  revert() {
    const d = this.doc;
    if (!d?.state || d.saving) return false;
    d.state.set_value(d.saved);
    d.dirty = false; d.conflict = null; d.saveError = null;
    return true;
  }

  // Navigation that would close the document. Returns true when it may run now;
  // otherwise it is kept in pendingNav for the person to Save, Discard or Cancel.
  request(nav) {
    if (this.doc?.saving) return false;
    if (!this.held) { this.pendingNav = null; return true; }
    this.pendingNav = nav;
    return false;
  }

  // choice: "save" | "discard" | "cancel". Resolves the nav to run now, or null.
  async resolve(choice) {
    const nav = this.pendingNav;
    if (!nav) return null;
    // While a save is writing, nothing may close the document.
    if (this.doc?.saving) return null;
    if (choice === "cancel") { this.pendingNav = null; return null; }
    if (choice === "save") {
      const r = await this.save();
      if ((r !== "saved" && r !== "clean") || this.held || this.pendingNav !== nav) return null;
    } else if (choice !== "discard") return null;
    this.pendingNav = null;
    return nav;
  }
}
