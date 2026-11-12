// Statusline capture for Claude Code and Antigravity (agy).
// Called by bin/statusline-wrap with the statusline JSON on stdin. Keeps only a
// whitelist, one file per session. Quota `observed_at` advances only when the
// quota values change: a statusline re-run repeats what the CLI last received,
// so the time is "session received", never a fresh backend read.
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { capturesDir, writeAtomic, readJson, hash, nowS, windowOf, windowLabel, toEpochS, pct, readStdin } from "./util.mjs";

const TERMINAL_RE = /^[A-Za-z0-9._\/-]{1,64}$/;
const str = (v, n = 80) => (typeof v === "string" && v ? v.slice(0, n) : null);

/** Claude statusline payload -> { quota, context } (whitelisted). */
export function parseClaude(p, _now = nowS()) {
  const rl = p?.rate_limits;
  const windows = [];
  if (rl && typeof rl === "object") {
    for (const [id, dur] of [["five_hour", 300], ["seven_day", 10080]]) {
      const w = rl[id];
      if (w && typeof w === "object" && (w.used_percentage != null || w.resets_at != null)) {
        windows.push(windowOf({ id, duration_min: dur, used: w.used_percentage, resets_at: w.resets_at }));
      }
    }
  }
  let spend = null;
  const s = rl?.spend_limit;
  if (s && typeof s === "object") {
    spend = {
      used_percent: pct(s.used_percentage),
      resets_at: toEpochS(s.resets_at),
      used_usd: Number.isFinite(Number(s.used_usd)) && s.used_usd != null ? Number(s.used_usd) : null,
      limit_usd: Number.isFinite(Number(s.limit_usd)) && s.limit_usd != null ? Number(s.limit_usd) : null,
      period: str(s.period, 20),
    };
  }
  const quota = windows.length || spend ? { windows, spend } : null;
  return { quota, raw_sig: quota ? hash(JSON.stringify(quota)) : null, context: contextOf(p) };
}

/** agy statusline payload -> { quota, context }. A missing fraction stays unknown. */
export function parseAgy(p, now = nowS()) {
  const q = p?.quota;
  const windows = [];
  if (q && typeof q === "object") {
    for (const [id, b] of Object.entries(q)) {
      if (!b || typeof b !== "object" || !/^[A-Za-z0-9._-]{1,64}$/.test(id)) continue;
      const frac = b.remaining_fraction;
      const remaining = frac == null || frac === "" ? null : Number(frac) * 100;
      const resets = b.reset_time ?? (b.reset_in_seconds != null ? now + Number(b.reset_in_seconds) : null);
      const { label, dur } = agyWindow(id);
      const w = windowOf({ id, label, duration_min: dur, remaining, resets_at: resets });
      if (b.remaining_amount != null && Number.isFinite(Number(b.remaining_amount))) w.remaining_amount = Number(b.remaining_amount);
      if (b.disabled === true) w.disabled = true;
      windows.push(w);
    }
    windows.sort((a, b) => a.id.localeCompare(b.id));
  }
  const quota = windows.length ? { windows, plan: str(p?.plan_tier, 40) } : null;
  // Signature of the raw (pre-derivation) fields, so a relative reset_in_seconds
  // repeated by a cached payload is recognised as the same observation.
  const raw = quota ? Object.entries(q).filter(([id, b]) => b && typeof b === "object" && /^[A-Za-z0-9._-]{1,64}$/.test(id)).sort(([a], [b]) => a.localeCompare(b))
    .map(([id, b]) => [id, b.remaining_fraction ?? null, b.remaining_amount ?? null, b.reset_time ?? null, b.reset_in_seconds ?? null, b.disabled ?? null]) : null;
  return { quota, raw_sig: raw ? hash(JSON.stringify([raw, quota.plan])) : null, context: contextOf(p) };
}

/** Bucket id -> "<prefix> <duration>" ("gemini-weekly" -> "Gemini 주간", "3p-5h" -> "3p 5시간"); unknown ids stay as is. */
export function agyWindow(id) {
  let m = id.match(/^(.*?)[-_]?(\d+)h$/i);
  let prefix = null, dur = null;
  if (m) { prefix = m[1]; dur = Number(m[2]) * 60; }
  else if ((m = id.match(/^(.*?)[-_]?(weekly|week)$/i))) { prefix = m[1]; dur = 10080; }
  else if ((m = id.match(/^(.*?)[-_]?(daily|day)$/i))) { prefix = m[1]; dur = 1440; }
  if (dur == null) return { label: id, dur: null };
  const lp = (prefix ?? "").toLowerCase();
  const p = lp === "gemini" ? "Gemini" : lp === "3p" ? "Claude·GPT" : /argon/.test(lp) ? "Argon" : prefix ?? "";
  return { label: `${p} ${windowLabel(null, dur)}`.trim(), dur };
}

function contextOf(p) {
  const c = p?.context_window;
  if (!c || typeof c !== "object") return null;
  const used = c.used_percentage != null ? pct(c.used_percentage) : c.remaining_percentage != null ? pct(100 - Number(c.remaining_percentage)) : null;
  if (used == null) return null;
  return {
    used_percent: used,
    window_tokens: Number.isFinite(Number(c.context_window_size)) && c.context_window_size != null ? Number(c.context_window_size) : null,
    model: str(p?.model?.display_name, 60) ?? str(p?.model?.id, 60),
  };
}

/** Which account a capture belongs to: CLAUDE_CONFIG_DIR for Claude (label only). */
export function accountOf(src, env) {
  if (src === "claude") {
    const def = path.join(os.homedir(), ".claude");
    const dir = env.CLAUDE_CONFIG_DIR ? path.resolve(env.CLAUDE_CONFIG_DIR) : def;
    return { key: `claude-${hash(dir, 8)}`, label: dir === def ? "기본" : path.basename(dir).slice(0, 30) };
  }
  return { key: `${src}-default`, label: "기본" };
}

/** Per-session key: session_id, else the herdr terminal + account; null = don't capture. */
export function sessionKey(src, payload, env) {
  const sid = payload?.session_id ?? payload?.conversation_id;
  if (typeof sid === "string" && sid) return hash(sid);
  const term = env.HC_TERMINAL_ID && TERMINAL_RE.test(env.HC_TERMINAL_ID) ? env.HC_TERMINAL_ID : null;
  return term ? hash(`term:${term}:${accountOf(src, env).key}`) : null;
}

/** Build the capture record, keeping the previous quota time when values did not change. */
export function buildCapture(src, payload, env, prev, now = nowS()) {
  const parsed = src === "claude" ? parseClaude(payload, now) : parseAgy(payload, now);
  const term = env.HC_TERMINAL_ID && TERMINAL_RE.test(env.HC_TERMINAL_ID) ? env.HC_TERMINAL_ID : null;
  const cwd = payload?.workspace?.current_dir ?? payload?.cwd ?? null;
  const acct = accountOf(src, env);
  const sameQuota = Boolean(prev && parsed.quota && prev.quota_sig === parsed.raw_sig);
  // Same raw values: keep the earlier derived reset times (relative resets), labels from this version.
  const quota = sameQuota ? withResets(parsed.quota, prev.quota) : parsed.quota ?? prev?.quota ?? null;
  return {
    v: 1,
    source: src,
    session: sessionKey(src, payload, env),
    account: acct.key,
    account_label: acct.label,
    terminal: term,
    cwd_name: typeof cwd === "string" && cwd ? path.basename(cwd).slice(0, 60) : null,
    version: str(payload?.version, 20),
    seen_at: now,
    quota,
    quota_sig: parsed.quota ? parsed.raw_sig : prev?.quota_sig ?? null,
    // Time this session first reported these exact quota values.
    quota_observed_at: parsed.quota ? (sameQuota ? prev.quota_observed_at : now) : prev?.quota_observed_at ?? null,
    context: parsed.context,
    context_observed_at: parsed.context ? now : prev?.context_observed_at ?? null,
  };
}

function withResets(q, prevQ) {
  const old = new Map((prevQ?.windows ?? []).map((w) => [w.id, w.resets_at]));
  return { ...q, windows: q.windows.map((w) => (old.has(w.id) ? { ...w, resets_at: old.get(w.id) } : w)) };
}

/** Remove wrapper temp files left by cancelled statusline runs (older than 2 minutes). */
export function pruneWrapperTemps(dir = os.tmpdir(), maxAgeMs = 120_000) {
  let names = [];
  try { names = fs.readdirSync(dir); } catch { return; }
  for (const n of names) {
    if (!n.startsWith("herdr-usage-sl.")) continue;
    const f = path.join(dir, n);
    try { if (Date.now() - fs.statSync(f).mtimeMs > maxAgeMs) fs.unlinkSync(f); } catch {}
  }
}

export function captureFromStdin(src) {
  return capturePayload(src, readStdin());
}

export function capturePayload(src, text) {
  if (src !== "claude" && src !== "agy") return 2;
  pruneWrapperTemps();
  if (!text.trim()) return 0;
  let payload;
  try { payload = JSON.parse(text); } catch { return 0; }
  const key = sessionKey(src, payload, process.env);
  if (!key) return 0;
  const file = path.join(capturesDir(), `${src}-${key}.json`);
  const prev = readJson(file);
  const rec = buildCapture(src, payload, process.env, prev);
  if (!rec.quota && !rec.context) return 0;
  writeAtomic(file, JSON.stringify(rec) + "\n");
  return 0;
}

export function readCaptures(src, maxAgeS = 14 * 86400) {
  const dir = capturesDir();
  const out = [];
  let names = [];
  try { names = fs.readdirSync(dir); } catch { return out; }
  const now = nowS();
  for (const n of names) {
    if (!n.startsWith(`${src}-`) || !n.endsWith(".json")) continue;
    const f = path.join(dir, n);
    const r = readJson(f);
    if (!r || r.source !== src) continue;
    if (now - (r.seen_at ?? 0) > maxAgeS) { try { fs.unlinkSync(f); } catch {} continue; }
    out.push(r);
  }
  return out;
}
