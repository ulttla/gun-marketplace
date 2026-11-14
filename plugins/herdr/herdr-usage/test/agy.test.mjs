import test from "node:test";
import assert from "node:assert/strict";
import { collectAgy, parseAgyQuota } from "../lib/sources/agy.mjs";
const response = (buckets) => ({ status: "SUCCESS", conversation_id: "", num_turns: 0,
  usage: { input_tokens: 0, output_tokens: 0, total_tokens: 0 },
  command: { name: "usage", data: { groups: [{ buckets }] } } });

test("quota API keeps exact buckets including zero and actual observation", () => {
  const groups = parseAgyQuota(response([
    { id: "3p-5h", remaining_fraction: 1, reset_time: "2026-11-13T21:00:00Z" },
    { id: "gemini-weekly", remaining_fraction: 0 },
    { id: "gemini-argon-wtu-weekly", remaining_amount: 8 },
  ]), 123);
  assert.equal(groups[0].observed_at, 123);
  assert.equal(groups[0].windows[0].used_percent, 0);
  assert.equal(groups[0].windows[1].remaining_percent, 0);
  assert.equal(groups[0].windows[2].remaining_percent, null);
  assert.equal(groups[0].windows[2].remaining_amount, 8);
  assert.equal(groups[0].windows[2].label, "Argon 주간");
  assert.equal(groups[0].windows[0].observed_at, 123);
});

test("missing buckets never invent Gemini quota and malformed fractions are rejected", () => {
  assert.deepEqual(parseAgyQuota({}), []);
  assert.deepEqual(parseAgyQuota(response([null, { id: "../token" },
    { id: "gemini-weekly", remaining_fraction: "1" },
    { id: "gemini-5h", remaining_fraction: 2 }])), []);
});

test("only read-only command output is accepted, never an inference response", () => {
  const r = response([{ id: "gemini-weekly", remaining_fraction: 1 }]);
  assert.deepEqual(parseAgyQuota({ ...r, num_turns: 1 }), []);
  assert.deepEqual(parseAgyQuota({ ...r, conversation_id: "conversation" }), []);
  assert.deepEqual(parseAgyQuota({ ...r, usage: { input_tokens: 1 } }), []);
  assert.deepEqual(parseAgyQuota({ ...r, command: { name: "model", data: r.command.data } }), []);
});

test("rate limits honor backoff without producing a fresh quota", async () => {
  const r = await collectAgy({ platform: "win32", now: () => 100,
    read: async () => ({ error: "http_429", retry_seconds: 600 }) });
  assert.equal(r.status, "error");
  assert.equal(r.retry_until, 700);
  assert.deepEqual(r.groups, []);
});

test("expired login and missing helper fail honestly", async () => {
  assert.equal((await collectAgy({ platform: "win32", read: async () => ({ error: "http_401" }) })).status, "connect_needed");
  const r = await collectAgy({ platform: "win32", read: async () => { throw new Error("secret data"); } });
  assert.equal(r.status, "error");
  assert.equal(r.last_error, "quota_command_failed");
  assert.ok(!JSON.stringify(r).includes("secret data"));
});

test("reads quota without a conversation on the current platform", async () => {
  let reads = 0;
  const r = await collectAgy({ now: () => 123, read: async () => {
    reads++;
    return response([{ id: "gemini-weekly", remaining_fraction: 0.5 }]);
  } });
  assert.equal(reads, 1);
  assert.equal(r.status, "ok");
  assert.equal(r.groups[0].windows[0].remaining_percent, 50);
});
