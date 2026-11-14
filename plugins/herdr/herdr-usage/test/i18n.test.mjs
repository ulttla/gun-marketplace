// Display language: English and Korean text in the mods, rebuilt from the
// locale-neutral parts of snapshots (new and older ones), and the installer's
// option parsing and language choice. Pure: runs on every platform.
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { LANG, LANGS, strings, windowName, groupName, sourceMessage, codesFromKorean, MESSAGE_CODES } from "../mod/shared/i18n.js";
import { ago, until, windowState, shortLabel, statusText, methodText } from "../mod/shared/fmt.js";
import { MESSAGES_KO, koText, msg } from "../lib/messages.mjs";
import { accountSource, applyPoll } from "../lib/snapshot.mjs";
import { groupsFromCaptures } from "../lib/merge.mjs";
import { parseClaude, parseAgy, accountOf } from "../lib/capture.mjs";
import { groupsFromUsage } from "../lib/sources/claude.mjs";
import { parseAgyQuota } from "../lib/sources/agy.mjs";
import { parseAppServerResult } from "../lib/sources/codex.mjs";
import { groupFromBalance } from "../lib/sources/ollama.mjs";
import { parseInstallArgs, chooseLanguage, existingInstall, LANGUAGES } from "../lib/setup.mjs";

const here = path.dirname(fileURLToPath(import.meta.url));
const fx = (n) => JSON.parse(fs.readFileSync(path.join(here, "fixtures", n), "utf8"));
const HANGUL = /[ㄱ-ㆎ가-힣]/;

test("i18n: an unfilled copy shows English; the installer and the mods agree on the languages", () => {
  assert.equal(LANG, "en");
  assert.deepEqual(LANGS, LANGUAGES);
});

test("i18n: times and window states in both languages", () => {
  const t = 1_900_000_000;
  assert.equal(ago(null, t, "en"), "never");
  assert.equal(ago(t - 10, t, "en"), "just now");
  assert.equal(ago(t - 300, t, "en"), "5 min ago");
  assert.equal(ago(t - 3 * 3600, t, "en"), "3 h ago");
  assert.equal(ago(t - 2 * 86400, t, "en"), "2 d ago");
  assert.equal(ago(t - 300, t, "ko"), "5분 전");
  assert.equal(ago(t - 3 * 3600, t, "ko"), "3시간 전");
  assert.equal(until(t + 3 * 3600 + 20 * 60, t, "en"), "in 3 h 20 min");
  assert.equal(until(t + 3 * 3600 + 20 * 60, t, "ko"), "3시간 20분 후");
  assert.equal(until(t + 2 * 86400, t, "ko"), "2일 후");
  assert.equal(until(t + 2 * 86400 + 4 * 3600, t, "en"), "in 2 d 4 h");
  assert.equal(until(t - 1, t, "en"), "passed");
  assert.equal(until(t - 1, t, "ko"), "지남");

  const ok = { used_percent: 32, remaining_percent: 68, resets_at: t + 60 };
  assert.equal(windowState(ok, t, "en").text, "68% left · 32% used");
  assert.equal(windowState(ok, t, "ko").text, "68% 남음 · 32% 사용");
  // Unknown stays unknown and a passed reset waits for new data, in both languages.
  assert.deepEqual(windowState({ used_percent: null, resets_at: t + 60 }, t, "en"), { kind: "unknown", text: "Unknown" });
  assert.equal(windowState({ used_percent: null }, t, "ko").text, "알 수 없음");
  assert.deepEqual(windowState({ ...ok, resets_at: t - 1 }, t, "en"), { kind: "expired", text: "Reset · awaiting data" });
  assert.equal(windowState({ ...ok, resets_at: t - 1 }, t, "ko").text, "리셋됨 · 새 값 대기");
  assert.equal(windowState({ used_percent: 99.6, remaining_percent: 0.4 }, t, "en").remaining, 0.4);

  assert.equal(statusText("connect_needed", "en"), "Connect needed");
  assert.equal(statusText("connect_needed", "ko"), "연결 필요");
  assert.equal(statusText("weird", "en"), "weird");
  assert.equal(methodText("statusline", "en"), "Session data");
  assert.equal(methodText("rollout", "ko"), "Codex 턴 기록");
  assert.equal(methodText("future-method", "en"), "future-method");
});

/** Every window the collector builds today, with its source. */
function collectorWindows() {
  const out = [];
  const add = (src, groups) => { for (const g of groups) for (const w of g.windows) out.push([src, w]); };
  add("claude", groupsFromUsage({
    five_hour: { utilization: 10, resets_at: 1 }, seven_day: { utilization: 20, resets_at: 1 },
    seven_day_opus: { utilization: 1, resets_at: 1 }, seven_day_sonnet: { utilization: 2, resets_at: 1 },
    seven_day_oauth_apps: { utilization: 3, resets_at: 1 },
  }, { dir: "/x/.claude", observed: 1 }));
  add("claude", [parseClaude(fx("claude-statusline.json")).quota]);
  add("agy", [parseAgy(fx("agy-statusline.json")).quota]);
  add("agy", parseAgyQuota({ status: "SUCCESS", conversation_id: "", num_turns: 0, usage: {},
    command: { name: "usage", data: { groups: [{ buckets: [
      { id: "3p-5h", remaining_fraction: 1 }, { id: "gemini-weekly", remaining_fraction: 0.5 },
      { id: "gemini-argon-wtu-weekly", remaining_fraction: 0.5 }, { id: "x_daily", remaining_fraction: 0.5 },
      { id: "odd", remaining_fraction: 0.5 },
    ] }] } } }, 1));
  add("codex", parseAppServerResult(fx("codex-appserver-result.json").result ?? fx("codex-appserver-result.json"), 1));
  add("ollama", [groupFromBalance(fx("ollama-legacy.json"), 1), groupFromBalance(fx("ollama-new.json"), 1)]);
  return out;
}

test("i18n: Korean window names are exactly the labels the collector writes; English ones have no Korean", () => {
  const all = collectorWindows();
  assert.ok(all.length >= 15, `fixtures cover the window kinds (${all.length})`);
  for (const [src, w] of all) {
    assert.equal(windowName(src, w, "ko"), w.label, `${src} ${w.id}`);
    assert.ok(!HANGUL.test(windowName(src, w, "en")), `${src} ${w.id}: ${windowName(src, w, "en")}`);
    assert.ok(!HANGUL.test(shortLabel(src, w, "en")), `${src} ${w.id} short`);
  }
});

test("i18n: windows cached by earlier versions (Korean labels) show in English", () => {
  const cases = [
    ["claude", { id: "five_hour", label: "5시간", duration_min: 300 }, "5-hour", "5h", "5h"],
    ["claude", { id: "seven_day", label: "주간", duration_min: 10080 }, "Weekly", "wk", "주"],
    ["claude", { id: "seven_day_opus", label: "Opus 주간", duration_min: 10080 }, "Opus weekly", "Opus wk", "Opus 주"],
    ["claude", { id: "seven_day_oauth_apps", label: "OAuth 앱 주간", duration_min: 10080 }, "OAuth apps weekly", "OAuth apps wk", "OAuth 앱 주"],
    // agy windows cached before the prefix was read from the id.
    ["agy", { id: "gemini-argon-wtu-weekly", label: "주간", duration_min: null }, "Argon weekly", "Argon wk", "Argon 주"],
    ["agy", { id: "3p-5h", label: "Claude·GPT 5시간", duration_min: 300 }, "Claude·GPT 5-hour", "Claude·GPT 5h", "Claude·GPT 5h"],
    ["codex", { id: "w300", label: "5시간", duration_min: 300 }, "5-hour", "5h", "5h"],
    ["codex", { id: "w10080", label: "주간", duration_min: 10080 }, "Weekly", "wk", "주"],
    ["codex", { id: "w43200", label: "30일", duration_min: 43200 }, "30-day", "30d", "30일"],
    ["codex", { id: "w90", label: "90분", duration_min: 90 }, "90-min", "90m", "90분"],
    ["ollama", { id: "session", label: "세션", duration_min: null }, "Session", "session", "세션"],
    ["ollama", { id: "included", label: "포함 크레딧", duration_min: null }, "Included credits", "credits", "크레딧"],
  ];
  for (const [src, w, en, enShort, koShort] of cases) {
    assert.equal(windowName(src, w, "en"), en, `${src} ${w.id}`);
    assert.equal(shortLabel(src, w, "en"), enShort, `${src} ${w.id} short`);
    assert.equal(shortLabel(src, w, "ko"), koShort, `${src} ${w.id} ko short`);
  }
});

test("i18n: names nobody translated (ids, provider and folder names) are kept as they are", () => {
  // Unknown bucket ids and window slots are identifiers.
  assert.equal(windowName("agy", { id: "odd", label: "odd" }, "en"), "odd");
  assert.equal(windowName("agy", { id: "odd", label: "odd" }, "ko"), "odd");
  assert.equal(windowName("codex", { id: "primary", label: "primary", duration_min: null }, "en"), "primary");
  assert.equal(shortLabel("codex", { id: "primary", label: "primary" }, "ko"), "primary");
  // A label that is not one of ours is shown in both languages, Korean or not.
  assert.equal(windowName("codex", { id: "custom-limit", label: "개인 한도" }, "en"), "개인 한도");
  assert.equal(windowName("agy", { id: "unicode_é", label: "unicode_é" }, "en"), "unicode_é");

  // A custom label on a window whose id or duration we know is still kept (review regressions).
  const custom = [
    ["claude", { id: "five_hour", label: "My Custom 5h", duration_min: 300 }],
    ["claude", { id: "five_hour", label: "My 5h", duration_min: 300 }],
    ["codex", { id: "w10080", label: "Spark Weekly", duration_min: 10080 }],
    ["codex", { id: "my-weekly", label: "Team Quota" }],
    ["codex", { id: "weekly", label: "My quota", duration_min: 10080 }],
    ["agy", { id: "gemini-weekly", label: "젬니 팀 한도" }],
    ["ollama", { id: "included", label: "Team credits" }],
  ];
  for (const [src, w] of custom) for (const lang of ["en", "ko"]) {
    assert.equal(windowName(src, w, lang), w.label, `${src} ${w.id} ${lang}`);
    assert.equal(shortLabel(src, w, lang), w.label, `${src} ${w.id} ${lang} short`);
  }
  // Without a label, or with the id as label, the name comes from the id.
  assert.equal(windowName("codex", { id: "w10080", duration_min: 10080 }, "en"), "Weekly");
  assert.equal(windowName("codex", { id: "my-weekly", label: "my-weekly" }, "en"), "Weekly");
  // A duration of zero or less is not a duration.
  assert.equal(windowName("codex", { id: "slot", label: "slot", duration_min: 0 }, "en"), "slot");
  assert.equal(windowName("codex", { id: "w0", label: "0일", duration_min: 0 }, "en"), "0일");
  assert.equal(windowName("agy", { id: "x-0h", label: "x-0h" }, "en"), "x-0h");
  assert.equal(windowName("codex", { id: "five_hour_slot", duration_min: -5 }, "en"), "5-hour");

  // Groups: the default account is translated, every other name kept.
  assert.equal(groupName({ key: "agy-default", label: "기본" }, "en"), "Default");
  assert.equal(groupName({ key: "claude-ab12cd34", label: "기본", label_key: "default" }, "en"), "Default");
  assert.equal(groupName({ key: "claude-ab12cd34", label: "기본", label_key: "default" }, "ko"), "기본");
  // Marked default but named by someone else: the name is kept.
  assert.equal(groupName({ key: "agy-default", label: "Team" }, "en"), "Team");
  assert.equal(groupName({ key: "claude-ab12cd34", label: "개인", label_key: "default" }, "en"), "개인");
  for (const label of ["개인", "주간", "기본", ".claude-work", "GPT-5 Codex", "한글 path"]) {
    assert.equal(groupName({ key: "claude-11111111", label }, "en"), label, label);
  }
});

test("i18n: the default account is marked from the capture key (older captures too); folder names are not", () => {
  const def = accountOf("claude", {});
  const dir = path.join(os.tmpdir(), "한글 path", "주간");
  const custom = accountOf("claude", { CLAUDE_CONFIG_DIR: dir });
  assert.equal(custom.label, "주간");
  const cap = (a, label) => ({ source: "claude", account: a.key, account_label: label, quota_observed_at: 1, seen_at: 1,
    quota: { windows: [{ id: "seven_day", label: "주간", duration_min: 10080, used_percent: 5, remaining_percent: 95, resets_at: 9 }] } });
  const agyCap = { ...cap(accountOf("agy", {}), "기본"), source: "agy" };
  const groups = groupsFromCaptures([cap(def, "기본"), cap(custom, custom.label), agyCap]);
  const byKey = Object.fromEntries(groups.map((g) => [g.key, g]));
  assert.equal(byKey[def.key].label_key, "default");
  assert.equal(groupName(byKey[def.key], "en"), "Default");
  assert.equal(byKey[custom.key].label_key, undefined);
  assert.equal(groupName(byKey[custom.key], "en"), "주간", "a folder named like a window is still a folder");
  assert.equal(groupName(byKey["agy-default"], "en"), "Default");
  // The default key with a custom account label is not marked.
  const relabeled = groupsFromCaptures([cap(def, "work")]);
  assert.equal(relabeled[0].label_key, undefined);
  assert.equal(groupName(relabeled[0], "en"), "work");
});

test("i18n: collector Korean text equals the mods' Korean table, so both readings agree", () => {
  assert.deepEqual(Object.keys(MESSAGES_KO).sort(), [...MESSAGE_CODES].sort());
  for (const src of ["codex", "claude", "agy", "ollama"]) {
    for (const code of MESSAGE_CODES) {
      const s = { status: "ok", ...msg([code], src) };
      assert.equal(sourceMessage(src, s, "ko"), s.message_ko, `${src} ${code}`);
      assert.ok(!HANGUL.test(sourceMessage(src, s, "en")), `${src} ${code} en`);
      // The Korean text alone reads back to the same code (older snapshots).
      assert.deepEqual(codesFromKorean(s.message_ko, src), [code], `${src} ${code} reverse`);
    }
  }
});

test("i18n: messages from codes, from older Korean-only state, and from unknown text", () => {
  assert.equal(sourceMessage("claude", { status: "connect_needed", message_codes: ["statusline_connect"] }, "en"), "Claude Code statusline not connected");
  assert.equal(sourceMessage("ollama", { status: "connect_needed", message_codes: ["ollama_signin"] }, "en"), "Ollama sign-in needed (ollama signin)", "the command stays as typed");
  // Korean-only text written by 0.1.4, with the notes the snapshot appends.
  const legacy = { status: "error", message_ko: "Claude 조회 제한 · 잠시 후 재시도 · 마지막 값 표시" };
  assert.equal(sourceMessage("claude", legacy, "en"), "Claude query rate-limited · retrying later · showing the last value");
  assert.equal(sourceMessage("claude", legacy, "ko"), legacy.message_ko);
  assert.equal(sourceMessage("agy", { status: "unavailable", message_ko: "Antigravity 세션 대기 중 (첫 응답 후 표시)" }, "en"), "Antigravity: waiting for a session (shown after its first response)");
  assert.equal(sourceMessage("claude", { status: "ok", message_ko: "실시간 조회 · 일부 한도는 마지막 세션 값" }, "en"), "Live query · some limits are from the last session");
  // Text we did not write: Korean UI shows it, English says what the status means.
  const odd = { status: "error", message_ko: "알 수 없는 메시지" };
  assert.equal(sourceMessage("codex", odd, "ko"), "알 수 없는 메시지");
  assert.equal(sourceMessage("codex", odd, "en"), "Error");
  assert.equal(sourceMessage("codex", { status: "error", message_codes: ["from_the_future"], message_ko: "실시간 조회" }, "en"), "Live query", "unknown codes fall back to the Korean reading");
  assert.equal(sourceMessage("codex", null, "en"), null);
});

test("i18n: snapshots carry codes for new state and keep message_ko; older state keeps its Korean text", () => {
  const cap = { source: "claude", account: "claude-test", account_label: "개인", quota_observed_at: 100, seen_at: 110,
    quota: { windows: [{ id: "seven_day", used_percent: 90, remaining_percent: 10, resets_at: 10000 }] } };
  const fresh = { key: "claude-test", observed_at: 200, windows: [{ id: "seven_day", used_percent: 20, remaining_percent: 80, resets_at: 10000 }] };
  const good = applyPoll(null, { status: "ok", method: "oauth-api", groups: [fresh], ...msg(["live"]) }, 200);
  const failed = { claude: applyPoll(good, { status: "error", method: "oauth-api", groups: [], last_error: "HTTP 429", ...msg(["claude_rate_limited"]) }, 300) };
  const r = accountSource("claude", failed, [cap], true, 310);
  assert.deepEqual(r.message_codes, ["claude_rate_limited", "showing_last"]);
  assert.equal(r.message_ko, "Claude 조회 제한 · 잠시 후 재시도 · 마지막 값 표시");
  assert.equal(r.observed_at, 200, "a failed fetch keeps the observation time");
  assert.equal(sourceMessage("claude", r, "en"), "Claude query rate-limited · retrying later · showing the last value");

  // collector.json written by 0.1.4: no message_codes.
  const old = { claude: { ...failed.claude } };
  delete old.claude.message_codes;
  old.claude.message_ko = "Claude 조회 제한 · 잠시 후 재시도";
  const r2 = accountSource("claude", old, [cap], true, 310);
  assert.equal(r2.message_codes, null);
  assert.equal(r2.message_ko, "Claude 조회 제한 · 잠시 후 재시도 · 마지막 값 표시");
  assert.equal(sourceMessage("claude", r2, "en"), "Claude query rate-limited · retrying later · showing the last value");

  // No direct read yet, session fallback only.
  const first = { claude: applyPoll(null, { status: "connect_needed", method: "oauth-api", groups: [], ...msg(["claude_auth"]) }, 300) };
  const r3 = accountSource("claude", first, [cap], true, 310);
  assert.deepEqual(r3.message_codes, ["claude_auth", "showing_last_session"]);
  assert.equal(koText(r3.message_codes, "claude"), r3.message_ko);
});

test("i18n: every English string the mods can show is free of Korean, and the mods hold no literal text", () => {
  const en = strings("en");
  const sample = (v) => (typeof v === "function" ? v("X", "Y", 3) : typeof v === "object" ? Object.values(v).map(sample).join(" ") : v);
  for (const [k, v] of Object.entries(en)) {
    const text = k === "credits" ? [v({ unlimited: true }), v({ has_credits: true }), v({})].join(" ") : k === "localRunning" ? v([]) + v(["m"]) : k === "until" ? v(["1 h"]) : sample(v);
    assert.ok(!HANGUL.test(text), `${k}: ${text}`);
  }
  for (const k of Object.keys(en)) assert.ok(k in strings("ko"), `ko has ${k}`);
  for (const m of ["gun-usage-bar", "gun-usage-detail"]) {
    const src = fs.readFileSync(path.join(here, "..", "mod", m, "main.js"), "utf8");
    assert.ok(!HANGUL.test(src), `${m}/main.js shows text through i18n.js only`);
  }
});

test("installer options: read in order, rejected before anything is written", () => {
  const K = ["--no-activate", "--skip-layout"];
  assert.deepEqual(parseInstallArgs([], K), { flags: new Set(), language: null });
  assert.deepEqual(parseInstallArgs(["--language", "ko", "--no-activate"], K), { flags: new Set(["--no-activate"]), language: "ko" });
  assert.deepEqual(parseInstallArgs(["--skip-layout", "--language=en"], K), { flags: new Set(["--skip-layout"]), language: "en" });
  for (const [argv, re] of [
    [["--language"], /needs a value/], [["--language", "--no-activate"], /needs a value/],
    [["--language", "fr"], /unsupported language "fr"/], [["--language="], /unsupported language ""/],
    [["--language", "EN"], /unsupported language/], [["--language", "en", "--language", "en"], /more than once/],
    [["ko"], /unknown option ko/], [["--frobnicate"], /unknown option/],
  ]) assert.throws(() => parseInstallArgs(argv, K), re, argv.join(" "));
});

test("installer language: option, else saved, else Korean for an earlier install, else English", () => {
  assert.equal(chooseLanguage({ explicit: null, prevInfo: {}, existing: false }).language, "en");
  assert.equal(chooseLanguage({ explicit: "ko", prevInfo: {}, existing: false }).language, "ko");
  assert.equal(chooseLanguage({ explicit: null, prevInfo: { package: "herdr-usage", version: "0.1.4" }, existing: true }).language, "ko");
  assert.equal(chooseLanguage({ explicit: null, prevInfo: { language: "en" }, existing: true }).language, "en");
  assert.equal(chooseLanguage({ explicit: null, prevInfo: { language: "xx" }, existing: true }).language, "ko");
  assert.equal(chooseLanguage({ explicit: "en", prevInfo: { language: "ko" }, existing: true }).language, "en");

  // Detection on disk, including installs from before install.json.
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "hu-lang '한글-"));
  try {
    const P = { usage: path.join(home, "usage"), mods: path.join(home, "mods") };
    assert.equal(existingInstall(P, {}), false);
    assert.equal(existingInstall(P, { package: "herdr-usage" }), true);
    fs.mkdirSync(path.join(P.mods, "gun-usage-bar"), { recursive: true });
    fs.writeFileSync(path.join(P.mods, "gun-usage-bar", "fmt.js"), "// someone else's\n");
    assert.equal(existingInstall(P, {}), false, "a foreign mod folder is not ours");
    fs.writeFileSync(path.join(P.mods, "gun-usage-bar", "fmt.js"), 'export const SHARED_KEY = "gun-usage.snapshot";\n');
    assert.equal(existingInstall(P, {}), true);
    fs.rmSync(P.mods, { recursive: true });
    fs.mkdirSync(path.join(P.usage, "bin"), { recursive: true });
    fs.writeFileSync(path.join(P.usage, "bin", "herdr-usage"), "#!/usr/bin/env node\n");
    assert.equal(existingInstall(P, {}), true);
  } finally { fs.rmSync(home, { recursive: true, force: true }); }
});
