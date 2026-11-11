// Shared by gun-usage-bar and gun-usage-detail (the installer copies it into both).
// Pure formatting: no host calls at module scope.

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

export function ago(sec, t = now()) {
  if (!sec) return "기록 없음";
  const d = Math.max(0, t - sec);
  if (d < 60) return "방금";
  if (d < 3600) return `${Math.floor(d / 60)}분 전`;
  if (d < 86400) return `${Math.floor(d / 3600)}시간 전`;
  return `${Math.floor(d / 86400)}일 전`;
}

export function until(sec, t = now()) {
  const d = sec - t;
  if (d <= 0) return "지남";
  if (d < 3600) return `${Math.max(1, Math.round(d / 60))}분 후`;
  if (d < 86400) {
    const h = Math.floor(d / 3600), m = Math.floor((d % 3600) / 60);
    return m ? `${h}시간 ${m}분 후` : `${h}시간 후`;
  }
  const days = Math.floor(d / 86400), h = Math.floor((d % 86400) / 3600);
  return h ? `${days}일 ${h}시간 후` : `${days}일 후`;
}

const two = (n) => String(n).padStart(2, "0");
export function clock(sec, withDate = true) {
  if (!sec) return "—";
  const d = new Date(sec * 1000);
  const hm = `${two(d.getHours())}:${two(d.getMinutes())}`;
  return withDate ? `${d.getMonth() + 1}/${d.getDate()} ${hm}` : hm;
}

/** What a window can honestly show now. */
export function windowState(w, t = now()) {
  if (w.resets_at && w.resets_at <= t) return { kind: "expired", text: "리셋됨 · 새 값 대기" };
  if (w.used_percent == null) return { kind: "unknown", text: "알 수 없음" };
  const remaining = w.remaining_percent ?? 100 - w.used_percent;
  return { kind: "ok", used: w.used_percent, remaining, text: `${fmtPct(remaining)} 남음 · ${fmtPct(w.used_percent)} 사용` };
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
export function shortLabel(w) {
  const l = w.label ?? w.id;
  return l.replace("포함 크레딧", "크레딧").replace(/(\d+)시간/, "$1h").replace("주간", "주").replace("일간", "일");
}

export const STATUS_KO = { ok: "정상", unavailable: "대기", connect_needed: "연결 필요", error: "오류" };

export function methodKo(m) {
  return { "app-server": "실시간 조회", rollout: "Codex 턴 기록", statusline: "세션 수신", "device-key": "실시간 조회", "api-key": "실시간 조회" }[m] ?? (m ?? "");
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
