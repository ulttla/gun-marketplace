// Shared by gun-usage-bar and gun-usage-detail (the installer copies it into both).
// Pure formatting: no host calls at module scope. Text comes from i18n.js.
import { LANG, strings, agoText, untilText, windowName } from "./i18n.js";

export const NODE = "@NODE@";
export const USAGE_HOME = "@USAGE_HOME@"; // the collector folder, filled in by the installer
export const SOURCES = [
  { id: "codex", name: "Codex", icon: "icons/codex.svg", tint: false, app: /codex/i },
  { id: "claude", name: "Claude", icon: "icons/claude.svg", tint: false, app: /claude/i },
  { id: "agy", name: "Antigravity", icon: "icons/antigravity.svg", tint: false, app: /antigravity|agy/i },
  { id: "ollama", name: "Ollama", icon: "icons/ollama.svg", tint: true, app: /ollama/i },
];
export const SHARED_KEY = "gun-usage.snapshot";

export const now = () => Math.floor(Date.now() / 1000);

export function ago(sec, t = now(), lang = LANG) {
  if (!sec) return strings(lang).never;
  return agoText(Math.max(0, t - sec), lang);
}

export function until(sec, t = now(), lang = LANG) {
  return untilText(sec - t, lang);
}

const two = (n) => String(n).padStart(2, "0");
export function clock(sec, withDate = true) {
  if (!sec) return "—";
  const d = new Date(sec * 1000);
  const hm = `${two(d.getHours())}:${two(d.getMinutes())}`;
  return withDate ? `${d.getMonth() + 1}/${d.getDate()} ${hm}` : hm;
}

/** What a window can honestly show now. */
export function windowState(w, t = now(), lang = LANG) {
  const L = strings(lang);
  if (w.resets_at && w.resets_at <= t) return { kind: "expired", text: L.expired };
  if (w.used_percent == null) return { kind: "unknown", text: L.unknown };
  const remaining = w.remaining_percent ?? 100 - w.used_percent;
  return { kind: "ok", used: w.used_percent, remaining, text: L.left(fmtPct(remaining), fmtPct(w.used_percent)) };
}

/** At most one decimal, so 99.6 is never shown as 100. */
export const fmtPct = (n) => `${Math.round(n * 10) / 10}%`;

export function isStale(observed, staleAfter, t = now()) {
  return !observed || t - observed > (staleAfter ?? 900);
}

export function usedColor(t, used) {
  if (used >= 90) return t.blocked;
  if (used >= 70) return t.ansi3 ?? t.working;
  return t.foreground;
}

export function barColor(t, used) {
  if (used >= 90) return t.blocked;
  if (used >= 70) return t.ansi3 ?? t.working;
  return t.accent;
}

/** Short window labels for the bar. */
export function shortLabel(sourceId, w, lang = LANG) {
  return windowName(sourceId, w, lang, true);
}

export const statusText = (status, lang = LANG) => strings(lang).status[status] ?? status;

export function methodText(m, lang = LANG) {
  return strings(lang).method[m] ?? (m ?? "");
}

/** Newest of several snapshots (by generated_at). */
export function newest(...snaps) {
  return snaps.filter((s) => s && s.schema === 1 && !s.busy && s.sources).sort((a, b) => (b.generated_at ?? 0) - (a.generated_at ?? 0))[0] ?? null;
}

/** The context of the focused terminal, only when its pane runs the matching agent. */
export function focusedContext(snap, focusedInfo, paneList) {
  const term = focusedInfo?.terminal;
  if (!snap || !term) return null;
  const pane = (paneList ?? []).find((p) => p.terminal === term);
  const progKey = `${pane?.app ?? ""} ${pane?.program?.key ?? ""} ${pane?.program?.name ?? ""}`;
  for (const c of snap.contexts ?? []) {
    if (c.terminal !== term) continue;
    const src = SOURCES.find((s) => s.id === c.source);
    if (src && src.app.test(progKey)) return { ...c, name: src.name, icon: src.icon, tint: src.tint };
  }
  return null;
}
