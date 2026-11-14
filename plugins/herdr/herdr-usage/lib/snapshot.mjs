// Build the normalized snapshot. Account usage sources are polled
// at most every POLL_S; statusline captures and local Ollama are read every run.
// A failed poll keeps the last good groups and their original observed_at.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { readCaptures } from "./capture.mjs";
import { WRAP_RE } from "./settings.mjs";
import { groupsFromCaptures, contextsFromCaptures } from "./merge.mjs";
import { collectCodex } from "./sources/codex.mjs";
import { collectClaude } from "./sources/claude.mjs";
import { collectAgy } from "./sources/agy.mjs";
import { collectOllamaCloud, localStatus } from "./sources/ollama.mjs";
import { msg, koText } from "./messages.mjs";
import { snapshotPath, collectorStatePath, writeAtomic, readJson, nowS, withLock, installInfo } from "./util.mjs";

export const POLL_S = 300;
const MIN_FORCED_S = 60; // even a manual refresh waits this long between network reads
const STALE = { codex: 900, claude: 1800, agy: 1800, ollama: 900 };

// Settings files: an explicit override, else the file the installer recorded
// (the collector runs from Herdr, whose environment may lack CLAUDE_CONFIG_DIR),
// else the CLI's own default location.
export function claudeSettingsPath({ recorded = true } = {}) {
  if (process.env.HERDR_USAGE_CLAUDE_SETTINGS) return process.env.HERDR_USAGE_CLAUDE_SETTINGS;
  const rec = recorded && installInfo().settings?.claude;
  if (typeof rec === "string" && rec) return rec;
  return path.join(process.env.CLAUDE_CONFIG_DIR || path.join(os.homedir(), ".claude"), "settings.json");
}
export function agySettingsPath({ recorded = true } = {}) {
  if (process.env.HERDR_USAGE_AGY_SETTINGS) return process.env.HERDR_USAGE_AGY_SETTINGS;
  const rec = recorded && installInfo().settings?.agy;
  if (typeof rec === "string" && rec) return rec;
  return path.join(os.homedir(), ".gemini", "antigravity-cli", "settings.json");
}

function wrapperInstalled(file) {
  const s = readJson(file);
  const sl = s?.statusLine;
  return Boolean(sl && typeof sl.command === "string" && WRAP_RE.test(sl.command) && sl.enabled !== false);
}

/** Merge a fresh poll result with the previous state for one network source. */
export function applyPoll(prevSrc, res, now) {
  const lastGood = res.groups?.length ? { groups: res.groups, method: res.method, observed_at: Math.max(...res.groups.map((g) => g.observed_at ?? 0)) || null } : prevSrc?.last_good ?? null;
  return {
    fetched_at: now,
    status: res.groups?.length ? res.status : res.status === "connect_needed" ? "connect_needed" : "error",
    method: res.method,
    message_codes: Array.isArray(res.message_codes) ? res.message_codes : null,
    message_ko: res.message_ko,
    last_error: res.last_error ?? null,
    retry_until: res.retry_until ?? null,
    last_good: lastGood,
  };
}

/** Add codes to a message. State written before message_codes existed keeps its Korean text only. */
function withNotes(codes, ko, notes, name) {
  if (!notes.length) return { message_codes: codes ?? null, message_ko: ko };
  return { message_codes: codes ? [...codes, ...notes] : null, message_ko: [ko, koText(notes, name)].filter(Boolean).join(" · ") };
}

function networkSource(name, st, now) {
  const s = st[name];
  if (!s) return { status: "unavailable", ...msg(["not_polled"], name), method: null, observed_at: null, fetched_at: null, stale_after_s: STALE[name], last_error: null, groups: [] };
  const groups = s.last_good?.groups ?? [];
  const status = s.status;
  return {
    status,
    ...withNotes(s.message_codes, s.message_ko, status !== "ok" && groups.length ? ["showing_last"] : [], name),
    method: s.last_good?.method ?? s.method,
    observed_at: s.last_good?.observed_at ?? null,
    fetched_at: s.fetched_at,
    stale_after_s: STALE[name],
    last_error: s.last_error,
    groups,
  };
}

function statuslineSource(name, captures, installed) {
  const groups = groupsFromCaptures(captures);
  let status = "ok", code = "session_value";
  if (!installed && !groups.length) { status = "connect_needed"; code = "statusline_connect"; }
  else if (!groups.length) { status = "unavailable"; code = "statusline_waiting"; }
  return {
    status,
    ...msg([code], name),
    method: "statusline",
    observed_at: Math.max(0, ...groups.map((g) => g.observed_at ?? 0)) || null,
    fetched_at: Math.max(0, ...captures.map((c) => c.seen_at ?? 0)) || null,
    stale_after_s: STALE[name],
    last_error: null,
    groups,
  };
}

/** Direct account queries are authoritative; session captures remain a fallback. */
export function accountSource(name, st, captures, installed, now = nowS()) {
  const direct = networkSource(name, st, now);
  const fallback = statuslineSource(name, captures, installed);
  if (direct.groups.length) {
    let partial = false;
    const groups = direct.groups.map((g) => {
      const old = fallback.groups.find((c) => c.key === g.key);
      const ids = new Set(g.windows.map((w) => w.id));
      const missing = (old?.windows ?? []).filter((w) => !ids.has(w.id));
      if (!missing.length) return g;
      partial = true;
      const windows = [
        ...g.windows.map((w) => ({ ...w, observed_at: w.observed_at ?? g.observed_at })),
        ...missing.map((w) => ({ ...w, observed_at: w.observed_at ?? old.observed_at })),
      ];
      return { ...g, windows, observed_at: Math.min(...windows.map((w) => w.observed_at ?? 0)) || null };
    });
    return partial ? { ...direct, groups,
      observed_at: Math.min(...groups.map((g) => g.observed_at ?? 0)) || null,
      ...withNotes(direct.message_codes, direct.message_ko, ["partial_session"], name),
    } : direct;
  }
  if (!st[name]) return fallback;
  return {
    ...direct,
    groups: fallback.groups,
    observed_at: fallback.observed_at,
    method: fallback.groups.length ? "statusline" : direct.method,
    ...withNotes(direct.message_codes, direct.message_ko, fallback.groups.length ? ["showing_last_session"] : [], name),
  };
}

export async function buildSnapshot({ mode = "due" } = {}) {
  const now = nowS();
  const st = readJson(collectorStatePath(), {}) ?? {};
  const due = (name) => {
    const s = st[name];
    if (s?.retry_until && s.retry_until > now) return false;
    const age = now - (s?.fetched_at ?? 0);
    return mode === "refresh" ? age >= MIN_FORCED_S : mode === "due" ? age >= POLL_S : false;
  };
  const jobs = [];
  if (due("codex")) jobs.push(collectCodex().then((r) => { st.codex = applyPoll(st.codex, r, nowS()); }));
  if (due("claude")) jobs.push(collectClaude({ settingsPath: claudeSettingsPath() }).then((r) => { st.claude = applyPoll(st.claude, r, nowS()); }));
  if (due("agy")) jobs.push(collectAgy().then((r) => { st.agy = applyPoll(st.agy, r, nowS()); }));
  if (due("ollama")) jobs.push(collectOllamaCloud().then((r) => { st.ollama = applyPoll(st.ollama, r, nowS()); }));
  const localP = localStatus();
  await Promise.all(jobs);
  if (jobs.length) writeAtomic(collectorStatePath(), JSON.stringify(st) + "\n");

  const cc = readCaptures("claude");
  const ac = readCaptures("agy");
  const snap = {
    schema: 1,
    generated_at: nowS(),
    poll_s: POLL_S,
    sources: {
      codex: networkSource("codex", st, now),
      claude: accountSource("claude", st, cc, wrapperInstalled(claudeSettingsPath()), now),
      agy: accountSource("agy", st, ac, wrapperInstalled(agySettingsPath()), now),
      ollama: networkSource("ollama", st, now),
    },
    contexts: [...contextsFromCaptures("claude", cc, now), ...contextsFromCaptures("agy", ac, now)],
    local: { ollama: await localP },
  };
  writeAtomic(snapshotPath(), JSON.stringify(snap) + "\n");
  return snap;
}

/** Single-flight: a concurrent run waits for the running one, then returns its snapshot. */
export async function snapshotCommand(mode) {
  const r = await withLock("collector", 90_000, () => buildSnapshot({ mode }));
  if (r) return r;
  const lock = path.join(path.dirname(collectorStatePath()), "collector.lock");
  for (let i = 0; i < 120 && fs.existsSync(lock); i++) await new Promise((res) => setTimeout(res, 250));
  return readJson(snapshotPath()) ?? { schema: 1, generated_at: nowS(), busy: true, sources: {}, contexts: [], local: {} };
}
