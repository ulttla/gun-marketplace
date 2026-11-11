import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { wrapperCommand } from "../lib/settings.mjs";

const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const fixture = fs.readFileSync(path.join(repo, "test", "fixtures", "claude-statusline.json"));
const tmp = () => fs.mkdtempSync(path.join(process.env.TMPDIR || os.tmpdir(), "hu-test-"));
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function usageHome() {
  const h = tmp();
  fs.symlinkSync(path.join(repo, "bin"), path.join(h, "bin"));
  fs.symlinkSync(path.join(repo, "lib"), path.join(h, "lib"));
  fs.writeFileSync(path.join(h, "package.json"), '{"type":"module"}');
  return h;
}

const ORIGINALS = [
  `printf '\\033[1;32mline1\\033[0m\\nline two  \\n'; printf 'warn\\n' >&2`,
  `cat >/dev/null; exit 1`,
  `nonexistent-command-xyz-123`,
  `wc -c | tr -d ' '`,
  `payload=$(cat); case "$payload" in *rate_limits*) ;; *) exit 0;; esac; [ -z "\${ORCA_PANE_KEY-}" ] && exit 0; echo never`,
  `exit 0`,
];

test("wrapper: stdout, stderr and exit code identical to the original", async () => {
  const home = usageHome();
  const ownTmp = tmp(); // live statusline wrappers share the real TMPDIR
  const env = { ...process.env, HERDR_USAGE_HOME: home, HERDR_USAGE_NODE: process.execPath, HC_TERMINAL_ID: "t9", TMPDIR: ownTmp };
  delete env.ORCA_PANE_KEY;
  const big = Buffer.concat([fixture, Buffer.alloc(1024 * 1024, 0x20)]);
  for (const orig of ORIGINALS) {
    for (const input of [fixture, big, Buffer.alloc(0)]) {
      const a = spawnSync("/bin/sh", ["-c", orig], { input, env });
      const b = spawnSync("/bin/sh", ["-c", wrapperCommand(path.join(home, "bin", "statusline-wrap"), "claude", orig)], { input, env });
      assert.equal(b.status, a.status, `rc for ${orig}`);
      assert.ok(Buffer.compare(a.stdout, b.stdout) === 0, `stdout for ${orig}`);
      assert.equal(b.stderr.toString(), a.stderr.toString().replace(/^\/bin\/sh: line \d+: /m, "/bin/sh: line 1: "), `stderr for ${orig}`);
    }
  }
  // The background capture lands one sanitized file for the fixture session.
  for (let i = 0; i < 40 && !fs.existsSync(path.join(home, "cache", "captures")); i++) await sleep(50);
  await sleep(300);
  const files = fs.readdirSync(path.join(home, "cache", "captures"));
  assert.equal(files.length, 1);
  const text = fs.readFileSync(path.join(home, "cache", "captures", files[0]), "utf8");
  assert.ok(!text.includes("/Users/") && !text.includes("sess-aaaa"));
  assert.equal(JSON.parse(text).terminal, "t9");
  assert.equal(fs.statSync(path.join(home, "cache", "captures", files[0])).mode & 0o777, 0o600);
  const left = () => fs.readdirSync(ownTmp).filter((n) => n.startsWith("herdr-usage-sl.")).length;
  for (let i = 0; i < 60 && left() > 0; i++) await sleep(100);
  assert.equal(left(), 0, "background capture removes its temp files");
});

test("wrapper: capture-only (no original) prints nothing, exits 0", () => {
  const home = usageHome();
  const r = spawnSync("/bin/sh", ["-c", wrapperCommand(path.join(home, "bin", "statusline-wrap"), "agy", "")], { input: fixture, env: { ...process.env, HERDR_USAGE_HOME: home, HERDR_USAGE_NODE: process.execPath } });
  assert.equal(r.status, 0);
  assert.equal(r.stdout.length, 0);
});

test("wrapper: unwritable usage home still behaves like the original", () => {
  const r = spawnSync("/bin/sh", ["-c", wrapperCommand(path.join(repo, "bin", "statusline-wrap"), "claude", "printf ok; exit 3")], { input: fixture, env: { ...process.env, HERDR_USAGE_HOME: "/nonexistent/dir", HERDR_USAGE_NODE: process.execPath } });
  assert.equal(r.status, 3);
  assert.equal(r.stdout.toString(), "ok");
});

function installEnv() {
  const d = tmp();
  const app = path.join(d, "app");
  fs.mkdirSync(path.join(app, "mods"), { recursive: true });
  const claude = path.join(d, "claude-settings.json");
  const agy = path.join(d, "agy-settings.json");
  fs.writeFileSync(claude, JSON.stringify({ env: { A: "1" }, statusLine: { type: "command", command: "printf 'orig'; exit 0", padding: 1 }, zzz: [1, 2] }, null, 2) + "\n", { mode: 0o644 });
  fs.writeFileSync(agy, JSON.stringify({ model: "x", statusLine: { type: "", command: "", enabled: false } }, null, 2) + "\n", { mode: 0o600 });
  const stub = path.join(d, "herdr-app"); // only `check` is called with --skip-layout
  fs.writeFileSync(stub, "#!/bin/sh\nexit 0\n", { mode: 0o755 });
  const env = { ...process.env, HERDR_APP_HOME: app, HERDR_APP_BIN: stub, HERDR_USAGE_HOME: path.join(app, "usage"), HERDR_USAGE_CLAUDE_SETTINGS: claude, HERDR_USAGE_AGY_SETTINGS: agy, HERDR_USAGE_NODE: process.execPath };
  return { d, app, claude, agy, env };
}
const run = (script, env, args = []) => spawnSync(process.execPath, [path.join(repo, script), "--skip-layout", ...args], { env, encoding: "utf8" });

test("install: key-only, idempotent, wrapper runs the original; uninstall restores bytes", () => {
  const e = installEnv();
  const before = { c: fs.readFileSync(e.claude, "utf8"), a: fs.readFileSync(e.agy, "utf8") };
  assert.equal(run("install.mjs", e.env).status, 0);
  const c1 = JSON.parse(fs.readFileSync(e.claude, "utf8"));
  assert.deepEqual(c1.env, { A: "1" });
  assert.deepEqual(c1.zzz, [1, 2]);
  assert.equal(c1.statusLine.padding, 1);
  assert.match(c1.statusLine.command, /usage\/bin\/statusline-wrap' claude /);
  assert.equal(fs.statSync(e.claude).mode & 0o777, 0o644);
  const a1 = JSON.parse(fs.readFileSync(e.agy, "utf8"));
  assert.equal(a1.statusLine.enabled, true);
  assert.equal(a1.statusLine.stack_with_default, true);
  assert.match(a1.statusLine.command, /statusline-wrap' agy$/);
  assert.equal(fs.statSync(path.join(e.app, "usage", "state", "claude-statusline.orig.json")).mode & 0o777, 0o600);
  assert.ok(fs.existsSync(path.join(e.app, "mods", "gun-usage-bar", "fmt.js")));
  assert.ok(!fs.readFileSync(path.join(e.app, "mods", "gun-usage-bar", "fmt.js"), "utf8").includes("@NODE@"));

  // Installed wrapper produces exactly the original's output.
  const r = spawnSync("/bin/sh", ["-c", c1.statusLine.command], { input: fixture, env: e.env });
  assert.equal(r.stdout.toString(), "orig");
  assert.equal(r.status, 0);

  // Double install never wraps the wrapper.
  const once = fs.readFileSync(e.claude, "utf8");
  assert.equal(run("install.mjs", e.env).status, 0);
  assert.equal(fs.readFileSync(e.claude, "utf8"), once);

  // Unrelated concurrent edit after install survives uninstall.
  const c2 = JSON.parse(once); c2.newKey = true;
  fs.writeFileSync(e.claude, JSON.stringify(c2, null, 2) + "\n");
  assert.equal(run("uninstall.mjs", e.env).status, 0);
  const c3 = JSON.parse(fs.readFileSync(e.claude, "utf8"));
  assert.equal(c3.newKey, true);
  delete c3.newKey;
  assert.equal(JSON.stringify(c3, null, 2) + "\n", before.c);
  assert.equal(fs.readFileSync(e.agy, "utf8"), before.a);
  assert.ok(!fs.existsSync(path.join(e.app, "usage")));
  assert.ok(!fs.existsSync(path.join(e.app, "mods", "gun-usage-bar")));
});

test("uninstall: leaves a statusLine the user changed after install", () => {
  const e = installEnv();
  run("install.mjs", e.env);
  const c = JSON.parse(fs.readFileSync(e.claude, "utf8"));
  c.statusLine = { type: "command", command: "echo mine" };
  fs.writeFileSync(e.claude, JSON.stringify(c, null, 2) + "\n");
  run("uninstall.mjs", e.env);
  assert.equal(JSON.parse(fs.readFileSync(e.claude, "utf8")).statusLine.command, "echo mine");
  assert.ok(fs.existsSync(path.join(e.app, "usage", "state", "claude-statusline.orig.json")));
});

test("install: absent statusLine is restored as absent", () => {
  const e = installEnv();
  fs.writeFileSync(e.claude, JSON.stringify({ env: {} }, null, 2) + "\n");
  run("install.mjs", e.env);
  assert.ok(JSON.parse(fs.readFileSync(e.claude, "utf8")).statusLine.command.includes("statusline-wrap"));
  run("uninstall.mjs", e.env);
  assert.equal(fs.readFileSync(e.claude, "utf8"), JSON.stringify({ env: {} }, null, 2) + "\n");
});

test("uninstall: lost state file recovers the original from argv, else keeps the wrapper files", () => {
  const e = installEnv();
  run("install.mjs", e.env);
  const state = path.join(e.app, "usage", "state");
  fs.writeFileSync(path.join(state, "claude-statusline.orig.json"), "{corrupt");
  fs.rmSync(path.join(state, "agy-statusline.orig.json"));
  const r = run("uninstall.mjs", e.env);
  // Claude: command recovered from the wrapper argv.
  assert.equal(JSON.parse(fs.readFileSync(e.claude, "utf8")).statusLine.command, "printf 'orig'; exit 0");
  // agy wrapper had no original in argv: left in place, files kept, nonzero exit.
  assert.match(JSON.parse(fs.readFileSync(e.agy, "utf8")).statusLine.command, /statusline-wrap' agy$/);
  assert.notEqual(r.status, 0);
  assert.ok(fs.existsSync(path.join(e.app, "usage", "bin", "statusline-wrap")));
  assert.ok(fs.existsSync(path.join(e.app, "usage", "lib", "capture.mjs")));
});

test("collector: concurrent runs both return a real snapshot (no busy placeholder)", async () => {
  const home = usageHome();
  const env = { ...process.env, HERDR_USAGE_HOME: home, HERDR_USAGE_CLAUDE_SETTINGS: "/nonexistent", HERDR_USAGE_AGY_SETTINGS: "/nonexistent", HERDR_USAGE_OLLAMA_LOCAL: "http://127.0.0.1:9" };
  const { spawn } = await import("node:child_process");
  const runOne = () => new Promise((res) => {
    const c = spawn(process.execPath, [path.join(home, "bin", "herdr-usage"), "snapshot", "--cached"], { env });
    let out = ""; c.stdout.on("data", (d) => (out += d)); c.on("close", () => res(JSON.parse(out)));
  });
  const snaps = await Promise.all([runOne(), runOne(), runOne()]);
  for (const s of snaps) { assert.equal(s.busy, undefined); assert.ok(s.sources.claude); }
});
