import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { fileURLToPath } from "node:url";
import { parseClaude, parseAgy, buildCapture, sessionKey, agyWindow } from "../lib/capture.mjs";
import { mergeWindows, groupsFromCaptures, contextsFromCaptures } from "../lib/merge.mjs";
import { parseAppServerResult, groupFromRolloutLine } from "../lib/sources/codex.mjs";
import { groupFromBalance } from "../lib/sources/ollama.mjs";
import { toEpochS, windowOf } from "../lib/util.mjs";
import { applyPoll } from "../lib/snapshot.mjs";
import { windowState, fmtPct } from "../mod/shared/fmt.js";

const fx = (n) => JSON.parse(fs.readFileSync(path.join(path.dirname(fileURLToPath(import.meta.url)), "fixtures", n), "utf8"));
const env = { HC_TERMINAL_ID: "t5k" };

test("claude: windows, epoch seconds, context", () => {
  const r = parseClaude(fx("claude-statusline.json"));
  assert.deepEqual(r.quota.windows.map((w) => [w.id, w.label, w.used_percent, w.remaining_percent, w.resets_at]),
    [["five_hour", "5시간", 12.4, 87.6, 1900000000], ["seven_day", "주간", 40, 60, 1900400000]]);
  assert.equal(r.context.used_percent, 42.5);
  assert.equal(r.context.window_tokens, 200000);
});

test("claude: missing rate_limits is no quota, not 0%", () => {
  const r = parseClaude(fx("claude-statusline-nolimits.json"));
  assert.equal(r.quota, null);
  assert.equal(r.context.used_percent, 3);
});

test("claude: null window is absent, not 100%", () => {
  const p = fx("claude-statusline.json");
  p.rate_limits = { five_hour: null, seven_day: { used_percentage: null, resets_at: 1900400000 } };
  const r = parseClaude(p);
  assert.equal(r.quota.windows.length, 1);
  assert.equal(r.quota.windows[0].used_percent, null);
  assert.equal(r.quota.windows[0].remaining_percent, null);
});

test("agy: remaining_fraction -> percent, missing fraction unknown, ISO reset", () => {
  const r = parseAgy(fx("agy-statusline.json"), 1_000_000);
  const weekly = r.quota.windows.find((w) => w.id === "gemini-weekly");
  assert.equal(weekly.label, "Gemini 주간");
  assert.equal(weekly.duration_min, 10080);
  assert.equal(weekly.remaining_percent, 75);
  assert.equal(weekly.used_percent, 25);
  assert.equal(weekly.resets_at, toEpochS("2030-03-17T12:00:00Z"));
  const daily = r.quota.windows.find((w) => w.id === "flash-daily");
  assert.equal(daily.used_percent, null);
  assert.equal(daily.resets_at, 1_000_000 + 7200);
  assert.equal(r.quota.plan, "pro");
});

test("agy: bucket labels", () => {
  assert.deepEqual(["3p-5h", "3p-weekly", "gemini-5h", "gemini-argon-wtu-weekly", "odd"].map((id) => agyWindow(id).label),
    ["Claude·GPT 5시간", "Claude·GPT 주간", "Gemini 5시간", "Argon 주간", "odd"]);
});

test("agy: repeated relative-only reset keeps quota_observed_at", () => {
  const p = { session_id: "s1", quota: { "gemini-weekly": { remaining_fraction: 0.5, reset_in_seconds: 3600 } } };
  const a = buildCapture("agy", p, env, null, 1000);
  const b = buildCapture("agy", p, env, a, 1600);
  assert.equal(b.quota_observed_at, 1000);
  assert.equal(b.quota.windows[0].resets_at, 1000 + 3600);
  assert.equal(b.seen_at, 1600);
  const c = buildCapture("agy", { ...p, quota: { "gemini-weekly": { remaining_fraction: 0.4, reset_in_seconds: 3000 } } }, env, b, 2000);
  assert.equal(c.quota_observed_at, 2000);
});

test("capture: unchanged values do not advance observed time; changed values do", () => {
  const p = fx("claude-statusline.json");
  const a = buildCapture("claude", p, env, null, 1000);
  const b = buildCapture("claude", p, env, a, 1000 + 6 * 3600);
  assert.equal(b.quota_observed_at, 1000);
  const p2 = structuredClone(p); p2.rate_limits.five_hour.used_percentage = 20;
  const c = buildCapture("claude", p2, env, b, 1000 + 7 * 3600);
  assert.equal(c.quota_observed_at, 1000 + 7 * 3600);
});

test("capture: whitelist only (no paths, ids, email, title, tokens, cost)", () => {
  for (const [src, f] of [["claude", "claude-statusline.json"], ["agy", "agy-statusline.json"]]) {
    const text = JSON.stringify(buildCapture(src, fx(f), { ...env, ORCA_AGENT_HOOK_TOKEN: "tok-xyz" }, null, 1000));
    for (const bad of ["/Users/", "transcript", "sess-aaaa", "conv-cccc", "someone@", "private title", "p-secret", "12345", "total_cost", "tok-xyz", "Bearer"]) {
      assert.ok(!text.includes(bad), `${src} capture leaks ${bad}`);
    }
    assert.ok(text.includes('"cwd_name":"demo"'));
  }
});

test("capture: no session id -> terminal+account key, or nothing", () => {
  const p = { rate_limits: { five_hour: { used_percentage: 1, resets_at: 1900000000 } } };
  const k1 = sessionKey("claude", p, { HC_TERMINAL_ID: "t1" });
  const k2 = sessionKey("claude", p, { HC_TERMINAL_ID: "t2" });
  assert.ok(k1 && k2 && k1 !== k2);
  assert.equal(sessionKey("claude", p, {}), null);
  assert.equal(sessionKey("claude", p, { HC_TERMINAL_ID: "bad id; rm" }), null);
});

test("merge: idle older session never pulls account usage backwards", () => {
  const w = (used, reset) => windowOf({ id: "five_hour", duration_min: 300, used, resets_at: reset });
  // Session A (fresh, 40%) and idle B (12%, same window) alternate writes.
  const m1 = mergeWindows([{ w: w(40, 1900000000), observed_at: 2000 }, { w: w(12, 1900000000), observed_at: 1000 }]);
  const m2 = mergeWindows([{ w: w(12, 1900000000), observed_at: 1000 }, { w: w(40, 1900000060), observed_at: 2000 }]);
  for (const m of [m1, m2]) { assert.equal(m[0].used_percent, 40); assert.equal(m[0].observed_at, 2000); }
  // A newer window (later reset) beats a higher value from the previous window.
  const m3 = mergeWindows([{ w: w(95, 1900000000), observed_at: 1000 }, { w: w(3, 1900018000), observed_at: 3000 }]);
  assert.equal(m3[0].used_percent, 3);
});

test("merge: groups by account and contexts by terminal", () => {
  const p = fx("claude-statusline.json");
  const a = buildCapture("claude", p, { HC_TERMINAL_ID: "t1" }, null, 1000);
  const b = buildCapture("claude", { ...p, session_id: "other" }, { HC_TERMINAL_ID: "t2", CLAUDE_CONFIG_DIR: "/tmp/alt-claude" }, null, 1100);
  const g = groupsFromCaptures([a, b]);
  assert.equal(g.length, 2);
  const ctx = contextsFromCaptures("claude", [a, b], 1200);
  assert.deepEqual(ctx.map((c) => c.terminal).sort(), ["t1", "t2"]);
  assert.equal(contextsFromCaptures("claude", [a], 1000 + 7 * 3600).length, 0);
});

test("codex app-server: weekly only, secondary null absent, no account id", () => {
  const g = parseAppServerResult(fx("codex-appserver-result.json"), 1234);
  assert.equal(g.length, 1);
  assert.deepEqual(g[0].windows.map((w) => [w.label, w.used_percent, w.resets_at]), [["주간", 32, 1900403806]]);
  assert.equal(g[0].plan, "prolite");
  assert.ok(!JSON.stringify(g).includes("acct-should-not-appear"));
  assert.ok(!JSON.stringify(g).includes("Upsell"));
});

test("codex rollout: observed_at is the event timestamp", () => {
  const line = JSON.stringify({ timestamp: "2030-01-01T00:00:00.000Z", type: "event_msg", payload: { type: "token_count", rate_limits: { limit_id: "codex", primary: { used_percent: 32, window_minutes: 10080, resets_at: 1900403806 }, secondary: null, credits: { has_credits: false, unlimited: false, balance: "0" }, plan_type: "prolite" } } });
  const g = groupFromRolloutLine(line);
  assert.equal(g.observed_at, toEpochS("2030-01-01T00:00:00Z"));
  assert.equal(g.windows.length, 1);
  assert.equal(groupFromRolloutLine(JSON.stringify({ payload: { rate_limits: null } })), null);
});

test("ollama: legacy and new balance shapes", () => {
  const a = groupFromBalance(fx("ollama-legacy.json"), 1);
  assert.deepEqual(a.windows.map((w) => [w.label, w.remaining_percent, w.used_percent]), [["세션", 97.3, 2.7], ["주간", 94.2, 5.8]]);
  assert.equal(a.balance_usd, 0);
  const b = groupFromBalance(fx("ollama-new.json"), 1);
  assert.equal(b.windows[0].remaining_percent, 75);
  assert.equal(b.windows[0].resets_at, toEpochS("2030-12-01T00:00:00Z"));
  assert.equal(b.balance_usd, 2.25);
  assert.equal(groupFromBalance({ included: { session: {} } }, 1).windows[0].used_percent, null);
});

test("units: seconds, ms and ISO all land on epoch seconds", () => {
  assert.equal(toEpochS(1900000000), 1900000000);
  assert.equal(toEpochS(1900000000000), 1900000000);
  assert.equal(toEpochS("2030-03-17T12:00:00Z"), Date.UTC(2030, 2, 17, 12) / 1000);
  assert.equal(toEpochS({ seconds: "1900000000" }), 1900000000);
  assert.equal(toEpochS(null), null);
});

test("ui: expired reset never shows the old percent; unknown stays unknown", () => {
  assert.equal(windowState({ used_percent: 80, resets_at: 100 }, 200).kind, "expired");
  assert.equal(windowState({ used_percent: null, resets_at: 300 }, 200).kind, "unknown");
  assert.equal(fmtPct(99.6), "99.6%");
  assert.equal(fmtPct(99.96), "100%");
  assert.equal(fmtPct(66), "66%");
  const ok = windowState({ used_percent: 30, remaining_percent: 70, resets_at: 300 }, 200);
  assert.equal(ok.remaining, 70);
});

test("poll failure keeps last good groups and their observed_at", () => {
  const good = applyPoll(null, { status: "ok", method: "app-server", groups: [{ observed_at: 500, windows: [] }] }, 500);
  const bad = applyPoll(good, { status: "error", method: "app-server", groups: [], last_error: "timeout" }, 900);
  assert.equal(bad.status, "error");
  assert.equal(bad.last_good.observed_at, 500);
  assert.equal(bad.fetched_at, 900);
});

test("agy: old cached labels are relabelled from the id at merge time", () => {
  const cached = { source: "agy", account: "agy-default", account_label: "기본", quota_observed_at: 100,
    quota: { plan: "Google AI Pro", windows: [{ id: "gemini-argon-wtu-weekly", label: "주간", duration_min: null, used_percent: 0.4, remaining_percent: 99.6, resets_at: 1900000000 }] } };
  const w = groupsFromCaptures([cached])[0].windows[0];
  assert.equal(w.label, "Argon 주간");
  assert.equal(w.remaining_percent, 99.6);
  assert.equal(w.resets_at, 1900000000);
});

test("capture: prunes only old wrapper temp files", async () => {
  const { pruneWrapperTemps } = await import("../lib/capture.mjs");
  const d = fs.mkdtempSync(path.join(os.tmpdir(), "hu-prune-"));
  for (const n of ["herdr-usage-sl.OLD", "herdr-usage-sl.NEW", "other.OLD"]) fs.writeFileSync(path.join(d, n), "x");
  const old = new Date(Date.now() - 600_000);
  fs.utimesSync(path.join(d, "herdr-usage-sl.OLD"), old, old);
  fs.utimesSync(path.join(d, "other.OLD"), old, old);
  pruneWrapperTemps(d);
  assert.deepEqual(fs.readdirSync(d).sort(), ["herdr-usage-sl.NEW", "other.OLD"]);
});
