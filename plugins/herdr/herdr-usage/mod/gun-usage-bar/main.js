// Status bar: the shipped workspace-status content (machine, branch, agents,
// palette hint) plus compact subscription usage. Click the usage to open the
// detail dialog. Data comes from ~/.config/herdr-app/usage (the collector).
import { View, div, svg, image } from "gpui-kit";
import { h_flex } from "gpui-base";
import { spaces, agents, theme, run, window, keys, exec, readTextFile, openOverlay, shared, setShared, focused, panes, nextCommand } from "herdr";
import { NODE, USAGE_HOME, SOURCES, SHARED_KEY, now, windowState, fmtPct, usedColor, shortLabel, statusText, isStale, newest, focusedContext } from "./fmt.js";
import { LANG, strings, windowName } from "./i18n.js";

const L = strings();
// English copy is wider, so the bar keeps every window name only from a wider width.
const FULL_W = LANG === "ko" ? 980 : 1100;

export default class GunUsageBar extends View {
  init(_props, cx) {
    this.snap = null;
    this.busy = false;
    this.width = 1200;
    cx.spawn(async (cx) => {
      try {
        const text = await readTextFile(`${USAGE_HOME}/cache/snapshot.json`);
        if (text) this.snap = JSON.parse(text);
      } catch {}
      cx.notify();
      await this.collect(cx, "--due");
    });
    cx.timer.every(60_000, (cx) => { cx.spawn(async (cx) => this.collect(cx, "--due")); });
    cx.spawn(async (cx) => {
      for (;;) {
        const c = await nextCommand();
        if (c === "open") this.openDetail();
        else if (c === "refresh") await this.collect(cx, "--refresh");
      }
    });
  }

  async collect(cx, mode) {
    if (this.busy) return;
    this.busy = true;
    try {
      const r = await exec(NODE, [`${USAGE_HOME}/bin/herdr-usage`, "snapshot", mode], { timeout: 45_000 });
      if (r.code === 0) {
        const s = JSON.parse(r.stdout);
        if (s?.schema === 1 && !s.busy && s.sources) { this.snap = s; setShared(SHARED_KEY, s); }
      }
    } catch {}
    this.busy = false;
    cx.notify();
  }

  openDetail() {
    openOverlay({ mod: "gun-usage-detail", kind: "dialog", width: 620, height: 600 });
  }

  hint() {
    const mac = window()?.platform === "macos";
    const mod = { cmd: mac ? "⌘" : "Ctrl+", ctrl: mac ? "⌃" : "Ctrl+", shift: mac ? "⇧" : "Shift+", alt: mac ? "⌥" : "Alt+", option: mac ? "⌥" : "Alt+" };
    const b = keys().find((k) => k.section === "global" && k.action === "app.palette");
    const parts = b && b.keys.endsWith("--") ? [...b.keys.slice(0, -2).split("-"), "-"] : b?.keys.split("-");
    const key = parts && parts.map((p) => mod[p.toLowerCase()] ?? p.toUpperCase()).join("");
    return key ? `${key}  commands` : "commands";
  }

  icon(src, t, dim) {
    const el = src.tint ? svg(src.icon).size(12).flex_none().text_color(dim ? t.dim : t.muted) : image(src.icon).w(12).h(12).flex_none();
    return dim && !src.tint ? el.opacity(0.5) : el;
  }

  /** One provider: icon + remaining per window (full) or its lowest remaining (compact). */
  chip(src, s, t, mode) {
    const n = now();
    const windows = (s?.groups ?? []).flatMap((g) => g.windows.map((w) => ({ w, observed: g.observed_at ?? s.observed_at })));
    const row = () => h_flex().id(`chip-${src.id}`).gap(5).items_center().flex_none();
    if (!s || !windows.length) {
      if (mode === "tiny") return null;
      const text = statusText(s?.status === "connect_needed" || s?.status === "error" ? s.status : "unavailable");
      return row().child(this.icon(src, t, true)).child(div().text_color(t.dim).child(mode === "full" ? `${src.name} ${text}` : text));
    }
    const stale = isStale(s.observed_at, s.stale_after_s, n);
    const parts = windows.map(({ w }) => ({ w, st: windowState(w, n) }));
    const many = parts.length > 2;
    const shown = mode === "full" && !many ? parts : [parts.filter((p) => p.st.kind === "ok").sort((a, b) => a.st.remaining - b.st.remaining)[0] ?? parts[0]];
    return row().child(this.icon(src, t, stale))
      .when(mode === "full", (el) => el.child(div().text_color(stale ? t.dim : t.muted).child(src.name)))
      .children(shown.map(({ w, st }) => {
      const color = stale ? t.dim : st.kind === "ok" ? usedColor(t, st.used) : t.dim;
      const val = st.kind === "ok" ? fmtPct(st.remaining) : st.kind === "expired" ? L.expiredShort : "?";
      return h_flex().gap(3).items_center()
        .child(div().text_color(t.dim).child(mode !== "full" ? shortLabel(src.id, w) : many ? L.labelLeftLowest(windowName(src.id, w)) : L.labelLeft(windowName(src.id, w))))
        .child(div().text_color(color).child(val));
    }));
  }

  render(cx) {
    const t = theme();
    const space = spaces().find((s) => s.active);
    const list = agents();
    const needs = list.filter((a) => a.status === "blocked").length;
    const w = this.width;
    const mode = w >= FULL_W ? "full" : w >= 620 ? "compact" : "tiny";
    const label = (icon, text) => h_flex().gap(6).items_center().flex_none().child(svg(`mods/workspace-chrome/${icon}.svg`).size(13)).child(text);
    const snap = newest(this.snap, shared(SHARED_KEY));
    const ctx = focusedContext(snap, focused(), panes());

    const items = [];
    if (ctx && mode !== "tiny") {
      items.push(h_flex().gap(4).items_center().child(div().text_color(t.dim).child(mode === "full" ? L.context : "ctx"))
        .child(div().text_color(usedColor(t, ctx.used_percent)).child(fmtPct(ctx.used_percent))));
      items.push(div().w(1).h(12).bg(t.border));
    }
    if (!snap) items.push(div().text_color(t.dim).child(this.busy ? L.loading : L.waitingUsage));
    else for (const src of SOURCES) { const c = this.chip(src, snap.sources?.[src.id], t, mode); if (c) items.push(c); }
    const usage = h_flex().id("usage").gap(mode === "full" ? 14 : 10).items_center().flex_none().cursor_pointer()
      .px(8).h(22).rounded(6).hover((s) => s.bg(t.hover))
      .on_click(() => this.openDetail()).children(items);

    return h_flex().id("root").on_size_change((size, cx) => { if (Math.abs(size.width - this.width) > 4) { this.width = size.width; cx.notify(); } })
      .size_full().px(14).gap(16).items_center().bg(t.chrome).border_t(1).border_color(t.border).text_size(11.8).text_color(t.muted).overflow_hidden()
      .when(mode !== "tiny", (el) => el.child(label(space?.machine ? "server" : "monitor", space?.machine ?? "This computer")))
      .when(mode === "full" && Boolean(space?.branch), (el) => el.child(label("branch", space.branch)))
      .child(h_flex().gap(6).items_center().flex_none().child(div().size(6).rounded(3).bg(t.dim)).child(`${list.length} agents`)
        .when(needs > 0, (el) => el.child(div().text_color(t.blocked).child(`· ${needs} needs you`))))
      .child(div().flex_1())
      .child(usage)
      .when(w >= 1180, (el) => el.child(div().id("palette").flex_none().text_color(t.dim).on_click(() => run("app.palette")).child(this.hint())));
  }
}
