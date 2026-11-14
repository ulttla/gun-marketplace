// Display language for gun-usage-bar and gun-usage-detail (English and Korean).
// The installer fills in the language it saved in install.json; an unfilled
// copy (tests, a hand copy) shows English. Pure: no host calls at module scope.
//
// Labels and messages are rebuilt from the locale-neutral parts of the snapshot
// (source, window id, duration, message codes), so snapshots and collector
// state written by older versions (Korean labels, message_ko only) still show
// in the chosen language. Strings the person or a provider named (account
// folders, Codex limit names, unknown bucket ids) are shown as they are.

export const LANGS = ["en", "ko"];
const BAKED = "@LANG@";
export const LANG = LANGS.includes(BAKED) ? BAKED : "en";
const pick = (lang) => (lang === "ko" ? "ko" : "en");

const S = {
  en: {
    never: "never",
    justNow: "just now",
    ago: (n, u) => `${n} ${u} ago`,
    passed: "passed",
    until: (parts) => `in ${parts.join(" ")}`,
    unit: { min: "min", h: "h", d: "d" },
    left: (r, u) => `${r} left · ${u} used`,
    expired: "Reset · awaiting data",
    expiredShort: "reset",
    unknown: "Unknown",
    status: { ok: "OK", unavailable: "Waiting", connect_needed: "Connect needed", error: "Error" },
    method: { "app-server": "Live query", rollout: "Codex turn log", statusline: "Session data", "device-key": "Live query", "api-key": "Live query", "oauth-api": "Live query", "quota-api": "Live query" },
    // bar
    labelLeft: (l) => `${l} left`,
    labelLeftLowest: (l) => `${l} left (lowest)`,
    context: "Context",
    loading: "Loading usage…",
    waitingUsage: "Waiting for usage",
    // detail
    title: "Subscription usage",
    updated: (c, a, m) => `Updated ${c} (${a}) · network check every ${m} min`,
    notCollected: "Not collected yet",
    refresh: "Refresh",
    refreshing: "Refreshing…",
    refreshFailed: "Refresh failed",
    close: "Close",
    resetPassed: (c) => `Reset ${c} passed`,
    resetAt: (c, u) => `Resets ${c} · ${u}`,
    noReset: "No reset time reported",
    balance: (b, a) => ` · balance $${b}${a != null ? ` / $${a}` : ""}`,
    disabled: " · disabled",
    stale: "Stale",
    observed: { statusline: "Session data", rollout: "Codex log", other: "Fetched" },
    lastTry: (c) => `Last try ${c}`,
    error: (e) => `Error: ${e}`,
    srcWaiting: (name) => `Waiting for ${name}`,
    plan: (p) => `Plan ${p}`,
    sessions: (n) => (n === 1 ? "1 session" : `${n} sessions`),
    noWindows: "No usage windows reported",
    spend: (used, reset) => `Spend limit ${used != null ? `${used} used` : "unknown"}${reset ? ` · resets ${reset}` : ""}`,
    credits: (c) => `Credits ${c.unlimited ? "unlimited" : c.has_credits ? c.balance ?? "available" : "none"}`,
    purchased: (b) => `Purchased balance $${b}`,
    localUnknown: "Local status unknown",
    localRunning: (models) => `Local running · ${models.length ? `loaded: ${models.join(", ")}` : "no models loaded"} (local models have no limits)`,
    localStopped: "Local stopped",
    ctxTitle: "Focused terminal context",
    ctxUsed: (p) => `${p} used`,
    tokens: (k) => `${k}k tokens`,
    received: (a) => `received ${a}`,
    ctxNone: "No statusline data for the focused Claude/Antigravity terminal (Codex context is not shown)",
    footer: "Remaining and used are the values each service reports. When a direct read fails, the last received value is shown. Terminal context comes from the session.",
    defaultAccount: "Default",
  },
  ko: {
    never: "기록 없음",
    justNow: "방금",
    ago: (n, u) => `${n}${u} 전`,
    passed: "지남",
    until: (parts) => `${parts.join(" ")} 후`,
    unit: { min: "분", h: "시간", d: "일" },
    left: (r, u) => `${r} 남음 · ${u} 사용`,
    expired: "리셋됨 · 새 값 대기",
    expiredShort: "리셋됨",
    unknown: "알 수 없음",
    status: { ok: "정상", unavailable: "대기", connect_needed: "연결 필요", error: "오류" },
    method: { "app-server": "실시간 조회", rollout: "Codex 턴 기록", statusline: "세션 수신", "device-key": "실시간 조회", "api-key": "실시간 조회", "oauth-api": "실시간 조회", "quota-api": "실시간 조회" },
    labelLeft: (l) => `${l} 남음`,
    labelLeftLowest: (l) => `${l} 남음 (최저)`,
    context: "컨텍스트",
    loading: "사용량 불러오는 중…",
    waitingUsage: "사용량 대기",
    title: "구독 사용량",
    updated: (c, a, m) => `업데이트 ${c} (${a}) · 네트워크 조회 ${m}분 간격`,
    notCollected: "아직 수집 전",
    refresh: "새로고침",
    refreshing: "조회 중…",
    refreshFailed: "새로고침 실패",
    close: "닫기",
    resetPassed: (c) => `리셋 ${c} 지남`,
    resetAt: (c, u) => `리셋 ${c} · ${u}`,
    noReset: "리셋 시간 정보 없음",
    balance: (b, a) => ` · 잔액 $${b}${a != null ? ` / $${a}` : ""}`,
    disabled: " · 비활성",
    stale: "오래됨",
    observed: { statusline: "세션 수신", rollout: "Codex 기록", other: "조회" },
    lastTry: (c) => `마지막 시도 ${c}`,
    error: (e) => `오류: ${e}`,
    srcWaiting: (name) => `${name} 대기`,
    plan: (p) => `플랜 ${p}`,
    sessions: (n) => `세션 ${n}개`,
    noWindows: "보고된 사용량 창 없음",
    spend: (used, reset) => `지출 한도 ${used != null ? `${used} 사용` : "알 수 없음"}${reset ? ` · 리셋 ${reset}` : ""}`,
    credits: (c) => `크레딧 ${c.unlimited ? "무제한" : c.has_credits ? c.balance ?? "있음" : "없음"}`,
    purchased: (b) => `구매 잔액 $${b}`,
    localUnknown: "로컬 상태 모름",
    localRunning: (models) => `로컬 실행 중 · ${models.length ? `로드됨: ${models.join(", ")}` : "로드된 모델 없음"} (로컬 모델은 한도 없음)`,
    localStopped: "로컬 꺼짐",
    ctxTitle: "선택한 터미널 컨텍스트",
    ctxUsed: (p) => `${p} 사용`,
    tokens: (k) => `${k}k 토큰`,
    received: (a) => `수신 ${a}`,
    ctxNone: "선택한 Claude/Antigravity 터미널의 statusline 값이 없습니다 (Codex 컨텍스트는 표시하지 않음)",
    footer: "남음/사용은 각 서비스가 보고한 값입니다. 직접 조회 실패 시 마지막 수신값을 표시합니다. 터미널 컨텍스트는 세션에서 받은 값입니다.",
    defaultAccount: "기본",
  },
};

/** The string table for a language (English unless "ko"). */
export const strings = (lang = LANG) => S[pick(lang)];

// ---- Collector messages ------------------------------------------------------
// Codes the collector writes in message_codes. The Korean text must stay equal
// to lib/messages.mjs (a test checks it): it is also how message_ko written by
// older versions is read back.
const MSG = {
  en: {
    not_polled: "Not checked yet",
    showing_last: "showing the last value",
    session_value: "Session value (as of the last response)",
    statusline_connect: (n) => `${n} statusline not connected`,
    statusline_waiting: (n) => `${n}: waiting for a session (shown after its first response)`,
    partial_session: "some limits are from the last session",
    showing_last_session: "showing the last session value",
    live: "Live query",
    agy_live: "Live query (no terminal needed)",
    agy_login: "Check the Antigravity sign-in",
    agy_failed: "Antigravity usage query failed",
    agy_no_quota: "The usage response had no subscription limits",
    codex_rollout: "Last Codex turn log",
    codex_failed: "Codex query failed",
    claude_auth: "Claude sign-in needs a refresh",
    claude_rate_limited: "Claude query rate-limited · retrying later",
    claude_failed: "Claude usage query failed",
    claude_empty: "Claude usage response was empty",
    ollama_login: "Ollama sign-in needed",
    ollama_signin: "Ollama sign-in needed (ollama signin)",
    ollama_auth: "Ollama authentication needed",
    rate_limited: "Request limit reached, retrying later",
    ollama_failed: "Ollama query failed",
  },
  ko: {
    not_polled: "아직 조회 전",
    showing_last: "마지막 값 표시",
    session_value: "세션 수신값 (마지막 응답 기준)",
    statusline_connect: (n) => `${n} statusline 연결 필요`,
    statusline_waiting: (n) => `${n} 세션 대기 중 (첫 응답 후 표시)`,
    partial_session: "일부 한도는 마지막 세션 값",
    showing_last_session: "마지막 세션 값 표시",
    live: "실시간 조회",
    agy_live: "실시간 조회 (터미널 실행 불필요)",
    agy_login: "Antigravity 로그인 확인 필요",
    agy_failed: "Antigravity 사용량 조회 실패",
    agy_no_quota: "사용량 조회 응답에 구독 한도 없음",
    codex_rollout: "마지막 Codex 턴 기록",
    codex_failed: "Codex 조회 실패",
    claude_auth: "Claude 로그인 갱신 필요",
    claude_rate_limited: "Claude 조회 제한 · 잠시 후 재시도",
    claude_failed: "Claude 사용량 조회 실패",
    claude_empty: "Claude 사용량 응답이 비어 있음",
    ollama_login: "Ollama 로그인 필요",
    ollama_signin: "Ollama 로그인 필요 (ollama signin)",
    ollama_auth: "Ollama 인증 필요",
    rate_limited: "요청 한도 초과, 잠시 후 재시도",
    ollama_failed: "Ollama 조회 실패",
  },
};
export const MESSAGE_CODES = Object.keys(MSG.en);

/** The product name a statusline message speaks of. */
const cliName = (sourceId) => (sourceId === "claude" ? "Claude Code" : sourceId === "agy" ? "Antigravity" : sourceId);

function msgText(code, sourceId, lang) {
  const v = MSG[pick(lang)][code];
  return typeof v === "function" ? v(cliName(sourceId)) : v;
}

/** Older collectors wrote only Korean text: split it back into codes, or null when any part is unknown. */
export function codesFromKorean(text, sourceId) {
  if (typeof text !== "string" || !text) return null;
  const known = MESSAGE_CODES.map((c) => [c, msgText(c, sourceId, "ko")]).sort((a, b) => b[1].length - a[1].length);
  const codes = [];
  let rest = text;
  while (rest) {
    const hit = known.find(([, ko]) => rest === ko || rest.startsWith(`${ko} · `));
    if (!hit) return null;
    codes.push(hit[0]);
    rest = rest.slice(hit[1].length + (rest.length > hit[1].length ? 3 : 0));
  }
  return codes;
}

/** A source's message in the given language, or null when it has none. */
export function sourceMessage(sourceId, s, lang = LANG) {
  if (!s) return null;
  const valid = (cs) => Array.isArray(cs) && cs.length > 0 && cs.every((c) => MESSAGE_CODES.includes(c));
  const codes = valid(s.message_codes) ? s.message_codes : codesFromKorean(s.message_ko, sourceId);
  if (codes) return codes.map((c) => msgText(c, sourceId, lang)).join(" · ");
  if (pick(lang) === "ko" && s.message_ko) return s.message_ko;
  // Unknown text from somewhere else: say what the status means instead.
  return s.status ? strings(lang).status[s.status] ?? null : null;
}

// ---- Window and group labels -------------------------------------------------

const WORDS = {
  en: { long: { weekly: "Weekly", daily: "Daily", monthly: "Monthly", session: "Session", included: "Included credits" },
    short: { weekly: "wk", daily: "day", monthly: "mo", session: "session", included: "credits" },
    hours: (n, short) => (short ? `${n}h` : `${n}-hour`), days: (n, short) => (short ? `${n}d` : `${n}-day`), mins: (n, short) => (short ? `${n}m` : `${n}-min`),
    lowerAfterPrefix: true },
  ko: { long: { weekly: "주간", daily: "일간", monthly: "월간", session: "세션", included: "포함 크레딧" },
    short: { weekly: "주", daily: "일", monthly: "월간", session: "세션", included: "크레딧" },
    hours: (n, short) => (short ? `${n}h` : `${n}시간`), days: (n) => `${n}일`, mins: (n) => `${n}분`,
    lowerAfterPrefix: false },
};

const CLAUDE_WINDOWS = {
  five_hour: [null, 300], seven_day: [null, 10080],
  seven_day_opus: ["Opus", 10080], seven_day_sonnet: ["Sonnet", 10080],
  seven_day_oauth_apps: [{ en: "OAuth apps", ko: "OAuth 앱" }, 10080],
};

/** agy bucket id -> { prefix, dur }, the same reading as lib/capture.mjs agyWindow. */
function agyParts(id) {
  let m = id.match(/^(.*?)[-_]?(\d+)h$/i);
  let prefix = null, dur = null;
  if (m) { prefix = m[1]; dur = Number(m[2]) * 60; }
  else if ((m = id.match(/^(.*?)[-_]?(weekly|week)$/i))) { prefix = m[1]; dur = 10080; }
  else if ((m = id.match(/^(.*?)[-_]?(daily|day)$/i))) { prefix = m[1]; dur = 1440; }
  if (dur == null || !(dur > 0)) return null;
  const lp = (prefix ?? "").toLowerCase();
  return { prefix: lp === "gemini" ? "Gemini" : lp === "3p" ? "Claude·GPT" : /argon/.test(lp) ? "Argon" : prefix || null, dur };
}

/** Which kind of window this is: { prefix?, dur } or { word }, or null when only its own name fits. */
function windowParts(sourceId, w) {
  const id = String(w?.id ?? "");
  if (sourceId === "claude" && CLAUDE_WINDOWS[id]) return { prefix: CLAUDE_WINDOWS[id][0], dur: CLAUDE_WINDOWS[id][1] };
  if (sourceId === "ollama") {
    if (id === "session") return { word: "session" };
    if (id === "included") return { word: "included" };
  }
  if (sourceId === "agy") return agyParts(id);
  const m = w?.duration_min;
  if (typeof m === "number" && m > 0) return { dur: m };
  const s = id.toLowerCase();
  if (/five_hour|5h/.test(s)) return { dur: 300 };
  if (/seven_day|weekly|week/.test(s)) return { dur: 10080 };
  if (/daily|day/.test(s)) return { dur: 1440 };
  if (/monthly|month/.test(s)) return { word: "monthly" };
  if (s === "session") return { word: "session" };
  return null;
}

function durWord(min, L, short) {
  if (min === 10080) return (short ? L.short : L.long).weekly;
  if (min === 1440) return (short ? L.short : L.long).daily;
  if (min % 1440 === 0) return L.days(min / 1440, short);
  if (min % 60 === 0) return L.hours(min / 60, short);
  return L.mins(min, short);
}

function render(parts, lang, short) {
  const L = WORDS[pick(lang)];
  const word = parts.word ? (short ? L.short : L.long)[parts.word] : durWord(parts.dur, L, short);
  const prefix = parts.prefix && typeof parts.prefix === "object" ? parts.prefix[pick(lang)] : parts.prefix;
  if (!prefix) return word;
  return `${prefix} ${L.lowerAfterPrefix && !short ? word.charAt(0).toLowerCase() + word.slice(1) : word}`;
}

/** The label is one this package generated (in either language, or an older
 *  version's form without the prefix), or there is none beyond the id. */
function generatedLabel(w, parts) {
  const label = w?.label;
  if (label == null || label === "" || label === w.id) return true;
  const bare = { ...parts, prefix: null };
  return [render(parts, "ko"), render(parts, "en"), render(bare, "ko"), render(bare, "en")].includes(label);
}

/** A window's name in the given language; `short` is the compact bar form.
 *  A label that is not one of ours (a provider's or the person's) is kept. */
export function windowName(sourceId, w, lang = LANG, short = false) {
  const parts = windowParts(sourceId, w);
  if (!parts || !generatedLabel(w, parts)) return String(w?.label || w?.id || "?");
  return render(parts, lang, short);
}

const DEFAULT_LABELS = [S.en.defaultAccount, S.ko.defaultAccount];

/** A group (account) name: the default account's generated name is translated, any other name is kept. */
export function groupName(g, lang = LANG) {
  const marked = g?.label_key === "default" || g?.key === "agy-default";
  if (marked && (g.label == null || DEFAULT_LABELS.includes(g.label))) return strings(lang).defaultAccount;
  return g?.label ?? null;
}

// ---- Times -------------------------------------------------------------------

export function agoText(d, lang = LANG) {
  const L = strings(lang);
  if (d < 60) return L.justNow;
  if (d < 3600) return L.ago(Math.floor(d / 60), L.unit.min);
  if (d < 86400) return L.ago(Math.floor(d / 3600), L.unit.h);
  return L.ago(Math.floor(d / 86400), L.unit.d);
}

export function untilText(d, lang = LANG) {
  const L = strings(lang);
  const u = L.unit;
  const sep = pick(lang) === "ko" ? "" : " ";
  const p = (n, unit) => `${n}${sep}${unit}`;
  if (d <= 0) return L.passed;
  if (d < 3600) return L.until([p(Math.max(1, Math.round(d / 60)), u.min)]);
  if (d < 86400) {
    const h = Math.floor(d / 3600), m = Math.floor((d % 3600) / 60);
    return L.until(m ? [p(h, u.h), p(m, u.min)] : [p(h, u.h)]);
  }
  const days = Math.floor(d / 86400), h = Math.floor((d % 86400) / 3600);
  return L.until(h ? [p(days, u.d), p(h, u.h)] : [p(days, u.d)]);
}
