// Subscription quota only: no model invocation. Use the installed account's
// existing OAuth credentials, renewing expired credentials when needed.
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { installInfo, readJson, writeAtomic, hash, nowS, windowOf } from "../util.mjs";

const USAGE_URL = "https://api.anthropic.com/api/oauth/usage";
const TOKEN_URL = "https://platform.claude.com/v1/oauth/token";
// Public Claude Code OAuth client ID, verified against the installed CLI.
const CLIENT_ID = "9d1c250a-e61b-44d9-88ed-5944d1962f5e";

export function claudeCredentialPath(settingsPath) {
  const recorded = settingsPath || process.env.HERDR_USAGE_CLAUDE_SETTINGS || installInfo().settings?.claude;
  const dir = recorded ? path.dirname(recorded) : process.env.CLAUDE_CONFIG_DIR || path.join(os.homedir(), ".claude");
  return path.join(dir, ".credentials.json");
}

export function groupsFromUsage(data, { dir, plan = null, observed = nowS() }) {
  const windows = [];
  for (const [id, dur, label] of [
    ["five_hour", 300, "5시간"], ["seven_day", 10080, "주간"],
    ["seven_day_opus", 10080, "Opus 주간"], ["seven_day_sonnet", 10080, "Sonnet 주간"],
    ["seven_day_oauth_apps", 10080, "OAuth 앱 주간"],
  ]) {
    const w = data?.[id];
    if (!w || typeof w !== "object") continue;
    // Missing usage is unknown, including a reset-only response.
    if (w.utilization == null && w.resets_at == null) continue;
    windows.push(windowOf({ id, duration_min: dur, label, used: w.utilization, resets_at: w.resets_at }));
  }
  if (!windows.length) return [];
  return [{ key: `claude-${hash(dir, 8)}`, label: path.basename(dir), plan, observed_at: observed,
    windows, credits: null, balance_usd: null, spend: null }];
}

export function retryAt(response, now = nowS()) {
  const value = response.headers?.get("retry-after");
  const seconds = value && /^\d+$/.test(value) ? Number(value) : null;
  const date = value && seconds == null ? Date.parse(value) / 1000 : null;
  return now + Math.min(86400, Math.max(60, seconds ?? (Number.isFinite(date) ? date - now : 300)));
}

function failure(status, response) {
  const auth = status === 401 || status === 403;
  return { status: auth ? "connect_needed" : "error", method: "oauth-api", groups: [],
    message_ko: auth ? "Claude 로그인 갱신 필요" : status === 429 ? "Claude 조회 제한 · 잠시 후 재시도" : "Claude 사용량 조회 실패",
    last_error: `http ${status}`, retry_until: status === 429 ? retryAt(response) : null };
}

async function renew(file, original, fetcher) {
  // Separate collectors cannot rotate the same refresh token concurrently.
  const lock = `${file}.herdr-usage-refresh.lock`;
  try { fs.mkdirSync(lock); } catch {
    // A killed collector may leave an empty lock directory behind.
    try {
      if (Date.now() - fs.statSync(lock).mtimeMs < 60000) throw new Error("refresh_busy");
      fs.rmdirSync(lock);
      fs.mkdirSync(lock);
    } catch { throw new Error("refresh_busy"); }
  }
  try {
    const current = readJson(file);
    const oauth = current?.claudeAiOauth;
    if (!oauth) throw new Error("credentials_missing");
    if (oauth.accessToken !== original.accessToken || oauth.refreshToken !== original.refreshToken) return oauth;
    const res = await fetcher(TOKEN_URL, { method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ grant_type: "refresh_token", refresh_token: oauth.refreshToken, client_id: CLIENT_ID }),
      signal: AbortSignal.timeout(10000) });
    if (!res.ok) return { failure: failure(res.status, res) };
    const body = await res.json();
    if (typeof body.access_token !== "string" || !body.access_token || !Number.isFinite(body.expires_in)) throw new Error("refresh_invalid");
    // Re-read immediately before writing; never overwrite a login or CLI renewal.
    const latest = readJson(file);
    const latestOauth = latest?.claudeAiOauth;
    if (!latestOauth) throw new Error("credentials_missing");
    if (latestOauth.accessToken !== oauth.accessToken || latestOauth.refreshToken !== oauth.refreshToken) return latestOauth;
    const updated = { ...latestOauth, accessToken: body.access_token,
      refreshToken: typeof body.refresh_token === "string" && body.refresh_token ? body.refresh_token : latestOauth.refreshToken,
      expiresAt: Date.now() + body.expires_in * 1000 };
    if (typeof body.scope === "string") updated.scopes = body.scope.split(" ").filter(Boolean);
    writeAtomic(file, JSON.stringify({ ...latest, claudeAiOauth: updated }));
    return updated;
  } finally { try { fs.rmdirSync(lock); } catch {} }
}

export async function collectClaude({ settingsPath, fetcher = fetch } = {}) {
  const file = claudeCredentialPath(settingsPath);
  let oauth = readJson(file)?.claudeAiOauth;
  if (!oauth?.accessToken) return { ...failure(401), last_error: "credentials_missing" };
  try {
    let renewed = false;
    if (oauth.expiresAt && oauth.expiresAt <= Date.now() + 60000 && oauth.refreshToken) {
      oauth = await renew(file, oauth, fetcher);
      if (oauth.failure) return oauth.failure;
      renewed = true;
    }
    const get = (token) => fetcher(USAGE_URL, { headers: { authorization: `Bearer ${token}`, "anthropic-beta": "oauth-2025-04-20" }, signal: AbortSignal.timeout(10000) });
    let res = await get(oauth.accessToken);
    if (res.status === 401 && oauth.refreshToken && !renewed) {
      oauth = await renew(file, oauth, fetcher);
      if (oauth.failure) return oauth.failure;
      res = await get(oauth.accessToken);
    }
    if (!res.ok) return failure(res.status, res);
    const groups = groupsFromUsage(await res.json(), { dir: path.dirname(file), plan: oauth.subscriptionType });
    if (!groups.length) return { status: "error", method: "oauth-api", groups: [], message_ko: "Claude 사용량 응답이 비어 있음", last_error: "empty" };
    return { status: "ok", method: "oauth-api", groups, message_ko: "실시간 조회", last_error: null };
  } catch (e) {
    // Error text and API bodies can contain credentials. Only fixed codes escape.
    const code = ["refresh_busy", "refresh_invalid", "credentials_missing"].includes(e?.message) ? e.message : e?.name === "TimeoutError" ? "timeout" : "network_error";
    return { status: "error", method: "oauth-api", groups: [], message_ko: "Claude 사용량 조회 실패", last_error: code };
  }
}
