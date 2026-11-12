// install / update / uninstall against a temporary HOME and a stub herdr-app.
// No real settings, no network, no running Herdr.
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const STUB = `#!/bin/sh
echo "$*" >> "$STUB_DIR/calls.log"
case "$1" in
  check)
    [ -f "$STUB_DIR/fail-check" ] && { echo "Error: stub check failed" >&2; exit 1; }
    [ -f "$2/main.js" ] || exit 1
    grep -q '@NODE@\\|@USAGE_HOME@' "$2/fmt.js" && exit 1
    exit 0 ;;
  status)
    [ -f "$STUB_DIR/no-window" ] && { echo "no window" >&2; exit 1; }
    printf '{"layout":"%s"}\\n' "$(cat "$STUB_DIR/layout" 2>/dev/null || echo main)" ;;
  do)
    if [ "$2" = layout.switch ]; then
      printf '%s' "$3" | sed 's/.*"name":"\\([^"]*\\)".*/\\1/' > "$STUB_DIR/layout"
      echo '{}'
    fi ;;
esac
exit 0
`;
const MAIN = { id: "root", type: "column", children: [{ id: "body", type: "block", content: { tab: "active" } }, { id: "status", type: "block", content: { mod: "workspace-status" } }] };

function sandbox({ claude = true, agy = true, claudeFile = true } = {}) {
  const home = fs.mkdtempSync(path.join(process.env.TMPDIR || os.tmpdir(), "hu-setup-"));
  const app = path.join(home, ".config", "herdr-app");
  fs.mkdirSync(path.join(app, "mods", "workspace-status"), { recursive: true });
  fs.mkdirSync(path.join(app, "layouts"));
  fs.writeFileSync(path.join(app, "layouts", "main.json"), JSON.stringify(MAIN, null, 2) + "\n");
  const stubDir = path.join(home, "stub");
  fs.mkdirSync(stubDir);
  const bin = path.join(stubDir, "herdr-app");
  fs.writeFileSync(bin, STUB, { mode: 0o755 });
  const files = { claude: path.join(home, ".claude", "settings.json"), agy: path.join(home, ".gemini", "antigravity-cli", "settings.json") };
  if (claude) {
    fs.mkdirSync(path.dirname(files.claude), { recursive: true });
    if (claudeFile) fs.writeFileSync(files.claude, JSON.stringify({ model: "x", statusLine: { type: "command", command: "printf 'orig'", padding: 0 } }, null, 2) + "\n");
  }
  if (agy) {
    fs.mkdirSync(path.dirname(files.agy), { recursive: true });
    fs.writeFileSync(files.agy, JSON.stringify({ theme: "dark" }, null, 2) + "\n");
  }
  const env = { ...process.env, HOME: home, HERDR_APP_BIN: bin, STUB_DIR: stubDir, HERDR_USAGE_NODE: process.execPath };
  for (const k of ["HERDR_APP_HOME", "HERDR_USAGE_HOME", "HERDR_USAGE_CLAUDE_SETTINGS", "HERDR_USAGE_AGY_SETTINGS", "CLAUDE_CONFIG_DIR", "CODEX_HOME"]) delete env[k];
  return { home, app, usage: path.join(app, "usage"), stubDir, files, env };
}
const run = (s, script, args = [], extraEnv = {}) => spawnSync(process.execPath, [path.join(repo, script), ...args], { env: { ...s.env, ...extraEnv }, encoding: "utf8" });
const read = (f) => (fs.existsSync(f) ? fs.readFileSync(f, "utf8") : null);
const shown = (s) => read(path.join(s.stubDir, "layout"))?.trim() ?? "main";
const calls = (s) => read(path.join(s.stubDir, "calls.log")) ?? "";

/** Every path under dir, with file contents, to prove "nothing changed". */
function tree(dir) {
  const out = {};
  (function walk(d) {
    for (const e of fs.readdirSync(d, { withFileTypes: true })) {
      const p = path.join(d, e.name);
      if (p.startsWith(path.join(dir, "stub"))) continue;
      if (e.isDirectory()) { out[p] = "dir"; walk(p); } else out[p] = fs.readFileSync(p, "utf8");
    }
  })(dir);
  return out;
}

test("setup: install, update, uninstall round trip in a fresh HOME", () => {
  const s = sandbox();
  const before = { c: read(s.files.claude), a: read(s.files.agy) };
  const layoutsMode = fs.statSync(path.join(s.app, "layouts")).mode;
  const r1 = run(s, "install.mjs");
  assert.equal(r1.status, 0, r1.stderr);
  assert.equal(shown(s), "gun-usage", "new layout is shown");
  const lay = JSON.parse(read(path.join(s.app, "layouts", "gun-usage.json")));
  assert.equal(lay.children[1].content.mod, "gun-usage-bar");
  assert.equal(lay.children[0].content.tab, "active");
  const fmt = read(path.join(s.app, "mods", "gun-usage-bar", "fmt.js"));
  assert.ok(fmt.includes(`"${s.usage}"`) && fmt.includes(process.execPath) && !/@NODE@|@USAGE_HOME@/.test(fmt));
  assert.match(read(path.join(s.usage, "bin", "statusline-wrap")), new RegExp(`home=\\$\\{HERDR_USAGE_HOME:-${s.usage.replace(/[.*+?^${}()|[\]\\/]/g, "\\$&")}\\}`));
  const info = JSON.parse(read(path.join(s.usage, "install.json")));
  assert.deepEqual(info.settings, { claude: s.files.claude, agy: s.files.agy });
  assert.equal(info.herdr_app, s.env.HERDR_APP_BIN);
  assert.equal(fs.statSync(s.usage).mode & 0o777, 0o700);
  assert.equal(fs.statSync(path.join(s.app, "layouts")).mode, layoutsMode, "layouts folder mode untouched");
  const claude1 = read(s.files.claude);
  assert.equal(JSON.parse(claude1).model, "x");
  assert.equal(JSON.parse(read(s.files.agy)).statusLine.stack_with_default, true);
  assert.ok(!fs.readdirSync(s.app).some((n) => n.startsWith(".herdr-usage-stage")), "stage removed");

  // The installed wrapper still prints the original and captures in the background.
  const out = spawnSync("/bin/sh", ["-c", JSON.parse(claude1).statusLine.command], { input: read(path.join(repo, "test", "fixtures", "claude-statusline.json")), env: { ...s.env, TMPDIR: s.home }, encoding: "utf8" });
  assert.equal(out.stdout, "orig");
  const capDir = path.join(s.usage, "cache", "captures");
  for (let i = 0; i < 100 && !(fs.existsSync(capDir) && fs.readdirSync(capDir).length); i++) Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 50);
  const caps = fs.readdirSync(capDir);
  assert.equal(caps.length, 1);

  // Update: the person switched back to main; a re-run keeps that and every byte of settings.
  fs.writeFileSync(path.join(s.stubDir, "layout"), "main");
  const r2 = run(s, "install.mjs");
  assert.equal(r2.status, 0, r2.stderr);
  assert.equal(shown(s), "main", "update does not switch layouts");
  assert.equal(read(s.files.claude), claude1);
  assert.deepEqual(fs.readdirSync(capDir), caps, "captures survive an update");
  assert.ok(fs.existsSync(path.join(s.usage, "state", "claude-statusline.orig.json")));

  const st = run(s, "status.mjs", ["--json"]);
  assert.equal(st.status, 0, st.stderr);
  const sj = JSON.parse(st.stdout);
  assert.equal(sj.installed, true);
  assert.equal(sj.statusline.claude.wrapped, true);
  assert.equal(sj.layout.exists, true);

  // Uninstall while shown: back to main first, then everything goes; settings restored byte for byte.
  fs.writeFileSync(path.join(s.stubDir, "layout"), "gun-usage");
  const r3 = run(s, "uninstall.mjs");
  assert.equal(r3.status, 0, r3.stderr);
  assert.equal(shown(s), "main");
  assert.equal(read(s.files.claude), before.c);
  assert.equal(read(s.files.agy), before.a);
  for (const p of ["usage", "mods/gun-usage-bar", "mods/gun-usage-detail", "layouts/gun-usage.json"]) assert.ok(!fs.existsSync(path.join(s.app, p)), p);
  assert.ok(fs.existsSync(path.join(s.app, "mods", "workspace-status")));
});

test("setup: CLIs that are not set up are skipped, and no folders are created", () => {
  const s = sandbox({ claude: false, agy: false });
  const r = run(s, "install.mjs");
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /claude statusLine: .* not found; skipped/);
  assert.match(r.stdout, /agy statusLine: .* not found; skipped/);
  assert.ok(!fs.existsSync(path.join(s.home, ".claude")) && !fs.existsSync(path.join(s.home, ".gemini")));
  assert.equal(run(s, "uninstall.mjs").status, 0);
  assert.ok(!fs.existsSync(s.usage));
});

test("setup: a missing settings file in an existing config folder is created, then removed again", () => {
  const s = sandbox({ claudeFile: false });
  assert.equal(run(s, "install.mjs").status, 0);
  assert.match(JSON.parse(read(s.files.claude)).statusLine.command, /statusline-wrap' claude$/);
  assert.equal(run(s, "uninstall.mjs").status, 0);
  assert.ok(!fs.existsSync(s.files.claude));
  assert.ok(fs.existsSync(path.dirname(s.files.claude)));
});

test("setup: CLAUDE_CONFIG_DIR and HERDR_APP_HOME are followed and recorded", () => {
  const s = sandbox({ claude: false });
  const cfg = path.join(s.home, "alt-claude");
  fs.mkdirSync(cfg);
  fs.writeFileSync(path.join(cfg, "settings.json"), "{}\n");
  const app2 = path.join(s.home, "alt-herdr");
  fs.cpSync(s.app, app2, { recursive: true });
  const env = { CLAUDE_CONFIG_DIR: cfg, HERDR_APP_HOME: app2 };
  const r = run(s, "install.mjs", ["--no-activate"], env);
  assert.equal(r.status, 0, r.stderr);
  const usage2 = path.join(app2, "usage");
  assert.ok(fs.existsSync(path.join(app2, "mods", "gun-usage-bar")) && fs.existsSync(usage2));
  assert.ok(!fs.existsSync(s.usage), "default Herdr home untouched");
  assert.equal(JSON.parse(read(path.join(usage2, "install.json"))).settings.claude, path.join(cfg, "settings.json"));
  assert.ok(read(path.join(app2, "mods", "gun-usage-bar", "fmt.js")).includes(usage2));
  // Uninstall finds the recorded file even without CLAUDE_CONFIG_DIR in its environment.
  assert.equal(run(s, "uninstall.mjs", [], { HERDR_APP_HOME: app2 }).status, 0);
  assert.equal(read(path.join(cfg, "settings.json")), "{}\n");
});

test("setup: --no-activate creates the layout without a window and does not switch", () => {
  const s = sandbox();
  fs.writeFileSync(path.join(s.stubDir, "no-window"), "");
  const r = run(s, "install.mjs", ["--no-activate"]);
  assert.equal(r.status, 0, r.stderr);
  assert.ok(fs.existsSync(path.join(s.app, "layouts", "gun-usage.json")));
  assert.ok(!calls(s).includes("layout.switch"));
});

test("setup: failed checks change nothing and exit nonzero", () => {
  const cases = [
    ["no window to activate", (s) => fs.writeFileSync(path.join(s.stubDir, "no-window"), ""), [], /no running Herdr window/],
    ["mod check fails", (s) => fs.writeFileSync(path.join(s.stubDir, "fail-check"), ""), [], /herdr-app check failed/],
    ["foreign mod folder", (s) => { fs.mkdirSync(path.join(s.app, "mods", "gun-usage-bar")); fs.writeFileSync(path.join(s.app, "mods", "gun-usage-bar", "main.js"), "// mine\n"); }, [], /not installed by herdr-usage/],
    ["foreign layout", (s) => fs.writeFileSync(path.join(s.app, "layouts", "gun-usage.json"), JSON.stringify(MAIN)), [], /not herdr-usage's layout/],
    ["foreign usage folder", (s) => { fs.mkdirSync(path.join(s.app, "usage")); fs.writeFileSync(path.join(s.app, "usage", "notes.txt"), "x"); }, [], /not created by herdr-usage/],
    ["usage folder with only familiar names", (s) => { fs.mkdirSync(path.join(s.app, "usage", "lib"), { recursive: true }); fs.writeFileSync(path.join(s.app, "usage", "lib", "unrelated.txt"), "x"); }, [], /not created by herdr-usage/],
    ["usage folder with another install.json", (s) => { fs.mkdirSync(path.join(s.app, "usage")); fs.writeFileSync(path.join(s.app, "usage", "install.json"), '{"package":"other"}'); }, [], /not created by herdr-usage/],
    ["invalid settings JSON", (s) => fs.writeFileSync(s.files.claude, "{ broken"), [], /not valid JSON/],
    ["settings formatting would change", (s) => fs.writeFileSync(s.files.claude, '{"a":1}\n'), [], /formatting would change/],
    ["no main layout", (s) => fs.rmSync(path.join(s.app, "layouts", "main.json")), [], /main layout not found/],
    ["no herdr-app", (s) => { s.env.HERDR_APP_BIN = path.join(s.home, "missing"); }, [], /herdr-app not found/],
    ["no Herdr home", (s) => fs.rmSync(s.app, { recursive: true }), [], /Herdr home not found/],
    ["old node for the wrapper", (s) => { s.env.HERDR_USAGE_NODE = path.join(s.home, "missing-node"); }, [], /older than|missing/],
    ["unknown option", () => {}, ["--frobnicate"], /unknown option/],
    ["unsupported platform", (s) => { const f = path.join(s.stubDir, "freebsd.mjs"); fs.writeFileSync(f, 'Object.defineProperty(process, "platform", { value: "freebsd" });\n'); s.env.NODE_OPTIONS = `--import=${f}`; }, [], /unsupported platform freebsd/],
  ];
  for (const [name, setup, args, re] of cases) {
    const s = sandbox();
    setup(s);
    const before = tree(s.home);
    const r = run(s, "install.mjs", args);
    assert.notEqual(r.status, 0, name);
    assert.match(r.stderr, re, name);
    assert.match(r.stderr, /Nothing was changed/, name);
    assert.deepEqual(tree(s.home), before, `${name}: files unchanged`);
  }
});

test("setup: a failed update keeps the working install as it was", () => {
  const s = sandbox();
  assert.equal(run(s, "install.mjs").status, 0);
  const before = tree(s.home);
  fs.writeFileSync(path.join(s.stubDir, "fail-check"), "");
  const r = run(s, "install.mjs");
  assert.notEqual(r.status, 0);
  assert.deepEqual(tree(s.home), before);
});

test("setup: an install made before install.json existed updates in place", () => {
  const s = sandbox();
  assert.equal(run(s, "install.mjs").status, 0);
  // Look like the pre-release install: no install.json, a capture, a user-changed layout look.
  fs.rmSync(path.join(s.usage, "install.json"));
  fs.mkdirSync(path.join(s.usage, "cache", "captures"), { recursive: true });
  fs.writeFileSync(path.join(s.usage, "cache", "captures", "claude-abc.json"), '{"source":"claude"}\n');
  const layFile = path.join(s.app, "layouts", "gun-usage.json");
  const lay = JSON.parse(read(layFile)); lay.background = "custom"; fs.writeFileSync(layFile, JSON.stringify(lay, null, 2) + "\n");
  const claude = read(s.files.claude), orig = read(path.join(s.usage, "state", "claude-statusline.orig.json"));
  fs.writeFileSync(path.join(s.stubDir, "layout"), "gun-usage");
  fs.writeFileSync(path.join(s.stubDir, "calls.log"), "");
  const r = run(s, "install.mjs");
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /already wrapped/);
  assert.equal(read(s.files.claude), claude, "no double wrapper");
  assert.equal(read(path.join(s.usage, "state", "claude-statusline.orig.json")), orig, "original kept");
  assert.ok(fs.existsSync(path.join(s.usage, "cache", "captures", "claude-abc.json")), "captures kept");
  assert.equal(JSON.parse(read(layFile)).background, "custom", "layout edits kept");
  assert.ok(!calls(s).includes("layout.switch"), "view not switched");
  assert.ok(fs.existsSync(path.join(s.usage, "install.json")));
});

test("setup: the baked Node is a stable launcher on PATH that resolves to the running node", () => {
  const s = sandbox();
  const binDir = path.join(s.home, "stable-bin");
  fs.mkdirSync(binDir);
  fs.symlinkSync(process.execPath, path.join(binDir, "node"));
  delete s.env.HERDR_USAGE_NODE;
  s.env.PATH = `${binDir}${path.delimiter}${s.env.PATH}`;
  const r = run(s, "install.mjs");
  assert.equal(r.status, 0, r.stderr);
  const launcher = path.join(binDir, "node");
  assert.equal(JSON.parse(read(path.join(s.usage, "install.json"))).node, launcher);
  assert.ok(read(path.join(s.app, "mods", "gun-usage-bar", "fmt.js")).includes(`"${launcher}"`));
  assert.match(read(path.join(s.usage, "bin", "statusline-wrap")), new RegExp(`node=\\$\\{HERDR_USAGE_NODE:-${launcher.replace(/[.*+?^${}()|[\]\\/]/g, "\\$&")}\\}`));
  // An explicit HERDR_USAGE_NODE still wins.
  const s2 = sandbox();
  assert.equal(run(s2, "install.mjs").status, 0);
  assert.equal(JSON.parse(read(path.join(s2.usage, "install.json"))).node, process.execPath);
});
