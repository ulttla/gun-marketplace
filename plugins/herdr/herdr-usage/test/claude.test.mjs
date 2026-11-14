import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { collectClaude, claudeLogin, groupsFromUsage, retryAt } from "../lib/sources/claude.mjs";

function account(t, oauth) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "herdr-claude-test-"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const file = path.join(dir, ".credentials.json");
  fs.writeFileSync(file, JSON.stringify({ untouched: { enabled: true }, claudeAiOauth: oauth }));
  return { file, settingsPath: path.join(dir, "settings.json") };
}
const response = (body, status = 200, headers = {}) => new Response(JSON.stringify(body), { status, headers });

test("quota excludes absent windows and keeps missing usage unknown", () => {
  const [g] = groupsFromUsage({ five_hour: null, seven_day: { utilization: 25, resets_at: "2026-11-20T00:00:00Z" }, seven_day_sonnet: { resets_at: "2026-11-20T00:00:00Z" } }, { dir: "account", observed: 123 });
  assert.equal(g.observed_at, 123);
  assert.equal(g.windows.length, 2);
  assert.equal(g.windows[0].remaining_percent, 75);
  assert.equal(g.windows[1].used_percent, null);
  assert.deepEqual(groupsFromUsage({}, { dir: "account" }), []);
});

test("expired credentials renew once, preserve metadata and persist rotating token", async (t) => {
  const a = account(t, { accessToken: "old", refreshToken: "refresh", expiresAt: 1, subscriptionType: "max" });
  const calls = [];
  const r = await collectClaude({ settingsPath: a.settingsPath, fetcher: async (url, options) => {
    calls.push(url);
    if (url.includes("/v1/oauth/token")) {
      assert.equal(JSON.parse(options.body).grant_type, "refresh_token");
      return response({ access_token: "new", refresh_token: "rotated", expires_in: 3600 });
    }
    assert.equal(options.headers.authorization, "Bearer new");
    return response({ seven_day: { utilization: 25 } });
  } });
  assert.equal(r.status, "ok");
  assert.equal(calls.length, 2);
  const saved = JSON.parse(fs.readFileSync(a.file));
  assert.equal(saved.claudeAiOauth.refreshToken, "rotated");
  assert.equal(saved.claudeAiOauth.subscriptionType, "max");
  assert.deepEqual(saved.untouched, { enabled: true });
  assert.equal(fs.existsSync(`${a.file}.herdr-usage-refresh.lock`), false);
});

test("a concurrent CLI login is never overwritten", async (t) => {
  const a = account(t, { accessToken: "old", refreshToken: "refresh", expiresAt: 1 });
  const r = await collectClaude({ settingsPath: a.settingsPath, fetcher: async (url, options) => {
    if (url.includes("/v1/oauth/token")) {
      fs.writeFileSync(a.file, JSON.stringify({ claudeAiOauth: { accessToken: "cli-token", refreshToken: "cli-refresh" }, added: true }));
      return response({ access_token: "collector-token", refresh_token: "collector-refresh", expires_in: 3600 });
    }
    assert.equal(options.headers.authorization, "Bearer cli-token");
    return response({ seven_day: { utilization: 25 } });
  } });
  assert.equal(r.status, "ok");
  assert.equal(JSON.parse(fs.readFileSync(a.file)).claudeAiOauth.refreshToken, "cli-refresh");
  assert.equal(JSON.parse(fs.readFileSync(a.file)).added, true);
});

test("rate limit returns retry deadline, no raw server text", async (t) => {
  const a = account(t, { accessToken: "token" });
  const r = await collectClaude({ settingsPath: a.settingsPath, fetcher: async () => response({ secret: "never log" }, 429, { "retry-after": "600" }) });
  assert.equal(r.status, "error");
  assert.equal(r.last_error, "http 429");
  assert.ok(r.retry_until >= Math.floor(Date.now() / 1000) + 599);
  assert.equal(JSON.stringify(r).includes("never log"), false);
  assert.equal(retryAt(response({}, 429, { "retry-after": "Wed, 21 Oct 2015 07:28:00 GMT" }), 100), 86500);
});

test("failed refresh preserves credentials and returns login status", async (t) => {
  const a = account(t, { accessToken: "old", refreshToken: "refresh", expiresAt: 1 });
  const before = fs.readFileSync(a.file, "utf8");
  const r = await collectClaude({ settingsPath: a.settingsPath, fetcher: async () => response({}, 401) });
  assert.equal(r.status, "connect_needed");
  assert.equal(fs.readFileSync(a.file, "utf8"), before);
});

test("network exception never exposes its message", async (t) => {
  const a = account(t, { accessToken: "token" });
  const r = await collectClaude({ settingsPath: a.settingsPath, fetcher: async () => { throw new Error("Bearer secret-token"); } });
  assert.equal(r.last_error, "network_error");
});

test("abandoned refresh lock recovers, a recent lock prevents a second renewal", async (t) => {
  const a = account(t, { accessToken: "old", refreshToken: "refresh", expiresAt: 1 });
  const lock = `${a.file}.herdr-usage-refresh.lock`;
  fs.mkdirSync(lock);
  let calls = 0;
  const fetcher = async (url) => {
    calls++;
    return response(url.includes("/v1/oauth/token") ? { access_token: "new", expires_in: 3600 } : { seven_day: { utilization: 25 } });
  };
  const busy = await collectClaude({ settingsPath: a.settingsPath, fetcher });
  assert.equal(busy.last_error, "refresh_busy");
  assert.equal(calls, 0);
  const old = new Date(Date.now() - 120000);
  fs.utimesSync(lock, old, old);
  assert.equal((await collectClaude({ settingsPath: a.settingsPath, fetcher })).status, "ok");
  assert.equal(calls, 2);
});

test("401 after proactive renewal does not rotate credentials twice", async (t) => {
  const a = account(t, { accessToken: "old", refreshToken: "refresh", expiresAt: 1 });
  let calls = 0;
  const r = await collectClaude({ settingsPath: a.settingsPath, fetcher: async (url) => {
    calls++;
    return url.includes("/v1/oauth/token") ? response({ access_token: "new", expires_in: 3600 }) : response({}, 401);
  } });
  assert.equal(r.status, "connect_needed");
  assert.equal(calls, 2);
});


test("macOS default login prefers Keychain over a stale credential file", async () => {
  const file = path.join(os.homedir(), ".claude", ".credentials.json");
  const oauth = { accessToken: "current-keychain-token" };
  const result = await claudeLogin(file, { platform: "darwin", keychain: async () => oauth });
  assert.deepEqual(result, { oauth, keychain: true });
});

test("custom config never reads the default account Keychain", async (t) => {
  const a = account(t, { accessToken: "custom-token" });
  const result = await claudeLogin(a.file, { platform: "darwin", keychain: async () => assert.fail("wrong account") });
  assert.equal(result.oauth.accessToken, "custom-token");
  assert.equal(result.keychain, false);
});

test("Keychain credentials are queried without rotating or copying them", async (t) => {
  const a = account(t, { accessToken: "stale-file-token" });
  const before = fs.readFileSync(a.file, "utf8");
  let calls = 0;
  const result = await collectClaude({ settingsPath: a.settingsPath,
    login: async () => ({ keychain: true, oauth: { accessToken: "current-token", refreshToken: "secret", expiresAt: 1 } }),
    fetcher: async (url, options) => {
      calls++;
      assert.ok(url.endsWith("/api/oauth/usage"));
      assert.equal(options.headers.authorization, "Bearer current-token");
      return response({}, 401);
    } });
  assert.equal(result.status, "connect_needed");
  assert.equal(calls, 1);
  assert.equal(fs.readFileSync(a.file, "utf8"), before);
});
