import { test } from "node:test";
import assert from "node:assert/strict";
import { accountSource, applyPoll } from "../lib/snapshot.mjs";

const capture = {
  source: "claude", account: "claude-test", account_label: "개인",
  quota_observed_at: 100, seen_at: 110,
  quota: { windows: [{ id: "seven_day", used_percent: 90, remaining_percent: 10, resets_at: 10000 }] },
};
const fresh = { key: "claude-test", observed_at: 200, windows: [{ id: "seven_day", used_percent: 20, remaining_percent: 80, resets_at: 10000 }] };

test("direct quota supersedes older high-usage session values", () => {
  const state = { claude: applyPoll(null, { status: "ok", method: "oauth-api", message_ko: "실시간 조회", groups: [fresh] }, 200) };
  const result = accountSource("claude", state, [capture], true, 210);
  assert.equal(result.groups[0].windows[0].used_percent, 20);
  assert.equal(result.observed_at, 200);
});

test("failed query keeps original successful observation, without marking it fresh", () => {
  const good = applyPoll(null, { status: "ok", method: "oauth-api", groups: [fresh] }, 200);
  const state = { claude: applyPoll(good, { status: "error", method: "oauth-api", message_ko: "조회 실패", groups: [], last_error: "HTTP 429", retry_until: 600 }, 300) };
  const result = accountSource("claude", state, [capture], true, 310);
  assert.equal(result.observed_at, 200);
  assert.equal(result.fetched_at, 300);
  assert.equal(result.status, "error");
  assert.equal(state.claude.retry_until, 600);
});

test("first direct failure shows session fallback with explicit error", () => {
  const state = { claude: applyPoll(null, { status: "connect_needed", method: "oauth-api", message_ko: "로그인 필요", groups: [] }, 300) };
  const result = accountSource("claude", state, [capture], true, 310);
  assert.equal(result.observed_at, 100);
  assert.equal(result.method, "statusline");
  assert.equal(result.status, "connect_needed");
  assert.match(result.message_ko, /로그인 필요.*마지막 세션/);
});

test("partial API response preserves missing windows with their old observation", () => {
  const old = { ...capture, source: "agy", account: "agy-default",
    quota: { windows: [{ id: "gemini-weekly", used_percent: 10, remaining_percent: 90, resets_at: 10000 }] } };
  const state = { agy: applyPoll(null, { status: "ok", method: "quota-api", message_ko: "직접 조회", groups: [
    { key: "agy-default", observed_at: 200, windows: [{ id: "3p-5h", used_percent: 0, remaining_percent: 100 }] },
  ] }, 200) };
  const result = accountSource("agy", state, [old], true, 210);
  assert.equal(result.observed_at, 100);
  assert.deepEqual(result.groups[0].windows.map((w) => [w.id, w.observed_at]), [["3p-5h", 200], ["gemini-weekly", 100]]);
  assert.match(result.message_ko, /일부 한도/);
});
