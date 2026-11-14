// Ollama: local daemon status over HTTP only (never the `ollama` CLI, which can
// start the app), and the cloud balance from ollama.com/api/balance, signed
// with the device key or OLLAMA_API_KEY. Errors carry status codes only.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { windowOf, nowS, toEpochS, errText } from "../util.mjs";
import { msg } from "../messages.mjs";
import { ollamaAuthHeader } from "./ollama-sign.mjs";

const LOCAL = process.env.HERDR_USAGE_OLLAMA_LOCAL || "http://127.0.0.1:11434";
const CLOUD = process.env.HERDR_USAGE_OLLAMA_CLOUD || "https://ollama.com";

async function getJson(url, { headers = {}, timeoutMs = 1500 } = {}) {
  const r = await fetch(url, { headers, signal: AbortSignal.timeout(timeoutMs) });
  let body = null;
  if (r.ok) { try { body = await r.json(); } catch { body = null; } }
  else { try { await r.body?.cancel(); } catch {} }
  return { status: r.status, retryAfter: r.headers.get("retry-after"), body };
}

export async function localStatus() {
  try {
    const v = await getJson(`${LOCAL}/api/version`);
    if (v.status !== 200) return { daemon: "stopped", models: [] };
    let models = [];
    try {
      const ps = await getJson(`${LOCAL}/api/ps`);
      models = (ps.body?.models ?? []).map((m) => String(m.name ?? m.model ?? "").slice(0, 60)).filter(Boolean).slice(0, 8);
    } catch {}
    return { daemon: "running", models };
  } catch {
    return { daemon: "stopped", models: [] };
  }
}

/** Both documented response shapes -> group. */
export function groupFromBalance(b, observed) {
  const inc = b?.included ?? {};
  const windows = [];
  for (const [id, label, dur] of [["session", "세션", null], ["weekly", "주간", 10080]]) {
    const w = inc[id];
    if (w && typeof w === "object") windows.push(windowOf({ id, label, duration_min: dur, remaining: w.remaining_percent, resets_at: w.resets_at }));
  }
  if (inc.allowance_usd != null || inc.balance_usd != null) {
    const allow = Number(inc.allowance_usd), bal = Number(inc.balance_usd);
    const remaining = Number.isFinite(allow) && allow > 0 && Number.isFinite(bal) ? (bal / allow) * 100 : null;
    const w = windowOf({ id: "included", label: "포함 크레딧", remaining, resets_at: inc.period?.until ?? null });
    if (Number.isFinite(bal)) w.balance_usd = bal;
    if (Number.isFinite(allow)) w.allowance_usd = allow;
    windows.push(w);
  }
  const pb = Number(b?.purchased?.balance_usd);
  return { key: "ollama-cloud", label: "Ollama Cloud", plan: windows.some((w) => w.id === "session") ? "legacy" : null, observed_at: observed, windows, credits: null, balance_usd: Number.isFinite(pb) ? pb : null };
}

function authHeader(ts) {
  if (process.env.OLLAMA_API_KEY) return `Bearer ${process.env.OLLAMA_API_KEY}`;
  const key = process.env.HERDR_USAGE_OLLAMA_KEY || path.join(os.homedir(), ".ollama", "id_ed25519");
  if (!fs.existsSync(key)) return null;
  return ollamaAuthHeader("GET", "/api/balance", ts, key);
}

/** Returns a source result; `retry_until` is set on 429. */
export async function collectOllamaCloud() {
  const ts = nowS();
  let auth;
  try { auth = authHeader(ts); } catch (e) { return { status: "connect_needed", method: "device-key", groups: [], ...msg(["ollama_login"]), last_error: errText(e) }; }
  if (!auth) return { status: "connect_needed", method: "device-key", groups: [], ...msg(["ollama_signin"]), last_error: "no key" };
  const method = auth.startsWith("Bearer ") ? "api-key" : "device-key";
  try {
    const r = await getJson(`${CLOUD}/api/balance?ts=${ts}`, { headers: { Authorization: auth }, timeoutMs: 15000 });
    auth = null;
    if (r.status === 200 && r.body) return { status: "ok", method, groups: [groupFromBalance(r.body, nowS())], ...msg(["live"]), last_error: null };
    if (r.status === 401 || r.status === 403) return { status: "connect_needed", method, groups: [], ...msg(["ollama_auth"]), last_error: `HTTP ${r.status}` };
    if (r.status === 429) {
      const ra = toRetry(r.retryAfter);
      return { status: "error", method, groups: [], ...msg(["rate_limited"]), last_error: "HTTP 429", retry_until: nowS() + ra };
    }
    return { status: "error", method, groups: [], ...msg(["ollama_failed"]), last_error: `HTTP ${r.status}` };
  } catch (e) {
    return { status: "error", method, groups: [], ...msg(["ollama_failed"]), last_error: errText(e) };
  }
}

function toRetry(v) {
  const n = Number(v);
  if (Number.isFinite(n) && n > 0) return Math.min(3600, Math.ceil(n));
  const t = toEpochS(v);
  return t ? Math.max(60, Math.min(3600, t - nowS())) : 300;
}
