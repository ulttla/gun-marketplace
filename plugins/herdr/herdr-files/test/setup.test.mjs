// install / update / status / uninstall against a temporary Herdr home and a stub
// herdr-app. No running Herdr, no real layouts. The stub records every call so the
// tests can prove the installer never asks the window to do anything.
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
    [ -f "$2/main.js" ] && [ -f "$2/core.js" ] || exit 1
    exit 0 ;;
  status) printf '{"layout":"x","errors":[]}\\n' ;;
  *) echo '{"error":"stub: not allowed"}'; exit 1 ;;
esac
`;
const files = (mod = "files") => ({ id: "files", type: "block", content: { mod } });
const MAIN = { id: "root", type: "row", children: [{ id: "main", type: "block", content: { tab: "active" } }, { id: "panel", type: "column", children: [{ id: "panel-body", type: "stack", active: "files", children: [files(), { id: "changes", type: "block", content: { mod: "changes" } }] }] }] };
const MINE = { ...structuredClone(MAIN), cloned_from: { name: "main", version: "0.1.15" }, theme: "graphite" };
const canRoot = typeof process.getuid === "function" && process.getuid() === 0;

function sandbox({ selected = "mine" } = {}) {
  const home = fs.mkdtempSync(path.join(process.env.TMPDIR || os.tmpdir(), "hf-setup-"));
  const app = path.join(home, "herdr-home");
  fs.mkdirSync(path.join(app, "mods", "files"), { recursive: true });
  fs.mkdirSync(path.join(app, "layouts"));
  const write = (rel, v) => fs.writeFileSync(path.join(app, rel), typeof v === "string" ? v : JSON.stringify(v, null, 2) + "\n");
  write("layouts/main.json", MAIN);
  write("layouts/mine.json", MINE);
  write("installed.json", { files: "0.1.15", "layout:main": "0.1.15", "layout:terminals": "0.1.15" });
  write("shared.json", { layout: selected });
  const stubDir = path.join(home, "stub");
  fs.mkdirSync(stubDir);
  fs.writeFileSync(path.join(stubDir, "herdr-app"), STUB, { mode: 0o755 });
  const env = { ...process.env, HOME: home, HERDR_APP_HOME: app, HERDR_APP_BIN: path.join(stubDir, "herdr-app"), STUB_DIR: stubDir };
  return { home, app, stubDir, env, write, layout: (n) => path.join(app, "layouts", `${n}.json`), mod: path.join(app, "mods", "herdr-files"), state: path.join(app, "herdr-files") };
}
const run = (s, script, args = []) => spawnSync(process.execPath, [path.join(repo, script), ...args], { env: s.env, encoding: "utf8" });
const read = (f) => (fs.existsSync(f) ? fs.readFileSync(f, "utf8") : null);
const json = (f) => JSON.parse(fs.readFileSync(f, "utf8"));
const filesMod = (f) => json(f).children[1].children[0].children[0].content.mod;
const windowCalls = (s) => (read(path.join(s.stubDir, "calls.log")) ?? "").split("\n").filter((l) => l && !/^(check|status)\b/.test(l));

/** Every path under the Herdr home with contents, to prove "nothing changed". */
function tree(dir) {
  const out = {};
  (function walk(d) {
    for (const e of fs.readdirSync(d, { withFileTypes: true })) {
      const p = path.join(d, e.name);
      if (e.isDirectory()) { out[p] = "dir"; walk(p); } else out[p] = fs.readFileSync(p, "utf8");
    }
  })(dir);
  return out;
}

test("default: patches the selected personal layout, idempotent, round trip, never drives the window", () => {
  const s = sandbox();
  const original = read(s.layout("mine")), mainBefore = read(s.layout("main"));
  const r1 = run(s, "install.mjs");
  assert.equal(r1.status, 0, r1.stderr);
  assert.equal(filesMod(s.layout("mine")), "herdr-files");
  assert.equal(json(s.layout("mine")).children[1].children[0].children[0].id, "files", "block id kept");
  assert.equal(json(s.layout("mine")).theme, "graphite", "rest of the layout kept");
  assert.equal(read(s.layout("main")), mainBefore, "shipped layout untouched");
  assert.match(read(path.join(s.mod, "core.js")), /PACKAGE = "herdr-files"/);
  assert.ok(fs.existsSync(path.join(s.mod, "main.js")) && fs.existsSync(path.join(s.mod, "folder.svg")));
  const info = json(path.join(s.state, "install.json"));
  assert.equal(info.package, "herdr-files");
  assert.equal(info.layouts.mine.previous, "files");
  assert.equal(read(info.layouts.mine.backup), original, "backup is the original file");
  assert.doesNotMatch(r1.stdout, /layout\.switch/, "selected layout: nothing to switch");

  const afterFirst = tree(s.app);
  const r2 = run(s, "install.mjs");
  assert.equal(r2.status, 0, r2.stderr);
  assert.match(r2.stdout, /already shows herdr-files/);
  const afterSecond = tree(s.app);
  for (const k of Object.keys(afterFirst)) if (!k.endsWith("install.json")) assert.equal(afterSecond[k], afterFirst[k], `unchanged on re-run: ${k}`);
  assert.equal(Object.keys(afterSecond).length, Object.keys(afterFirst).length, "no new backup on re-run");
  assert.equal(json(path.join(s.state, "install.json")).layouts.mine.previous, "files", "previous mod not overwritten");

  const st = run(s, "status.mjs", ["--json"]);
  assert.equal(st.status, 0, st.stderr);
  const so = JSON.parse(st.stdout);
  assert.equal(so.installed, true);
  assert.equal(so.layouts.mine.shows, true);
  assert.deepEqual(so.herdr_errors, []);

  const u = run(s, "uninstall.mjs");
  assert.equal(u.status, 0, u.stderr);
  assert.equal(filesMod(s.layout("mine")), "files");
  assert.deepEqual(json(s.layout("mine")), JSON.parse(original), "layout back to what it was");
  assert.equal(fs.existsSync(s.mod), false);
  assert.equal(fs.existsSync(s.state), false);
  assert.equal(run(s, "status.mjs").status, 1, "status exits 1 when not installed");
  assert.deepEqual(windowCalls(s), [], "no layout.switch, focus or other window command");
});

test("selected layout is Herdr's own: mod only, note; --layout on it is refused and changes nothing", () => {
  const s = sandbox({ selected: "main" });
  const before = tree(s.app);
  const r = run(s, "install.mjs");
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /one of Herdr's own/);
  assert.match(r.stdout, /--create-layout/);
  assert.equal(read(s.layout("main")), before[s.layout("main")]);
  assert.equal(read(s.layout("mine")), before[s.layout("mine")], "an unselected personal layout is not touched");
  assert.ok(fs.existsSync(s.mod));

  const t = sandbox();
  const tb = tree(t.app);
  const r2 = run(t, "install.mjs", ["--layout", "main"]);
  assert.equal(r2.status, 1);
  assert.match(r2.stderr, /Nothing was changed/);
  assert.deepEqual(tree(t.app), tb);
});

test("--create-layout copies a layout without showing it; uninstall removes it only while unchanged and not selected", () => {
  const s = sandbox({ selected: "main" });
  const r = run(s, "install.mjs", ["--create-layout", "files-view", "--from", "main"]);
  assert.equal(r.status, 0, r.stderr);
  assert.equal(filesMod(s.layout("files-view")), "herdr-files");
  assert.equal(filesMod(s.layout("main")), "files");
  assert.equal(json(path.join(s.app, "shared.json")).layout, "main", "not switched");
  assert.match(r.stdout, /herdr-app do layout\.switch '\{"name":"files-view"\}'/, "tells how to show it");
  assert.equal(run(s, "install.mjs", ["--create-layout", "files-view"]).status, 1, "never overwrites an existing layout");
  const u = run(s, "uninstall.mjs");
  assert.equal(u.status, 0, u.stderr);
  assert.equal(fs.existsSync(s.layout("files-view")), false);

  // Edited after install: kept, with its block restored.
  const t = sandbox({ selected: "main" });
  run(t, "install.mjs", ["--create-layout", "files-view"]);
  const lay = json(t.layout("files-view")); lay.theme = "moss";
  fs.writeFileSync(t.layout("files-view"), JSON.stringify(lay, null, 2) + "\n");
  const u2 = run(t, "uninstall.mjs");
  assert.equal(u2.status, 0, u2.stderr);
  assert.equal(filesMod(t.layout("files-view")), "files");
  assert.equal(json(t.layout("files-view")).theme, "moss");
  assert.deepEqual(windowCalls(t), []);
});

test("refuses and changes nothing: foreign mod, foreign state, failed check, files block with another mod", () => {
  const cases = [
    ["foreign mod", (s) => { fs.mkdirSync(s.mod); fs.writeFileSync(path.join(s.mod, "main.js"), "// someone else's\n"); }, [], /not installed by herdr-files/],
    ["foreign state", (s) => { fs.mkdirSync(s.state); fs.writeFileSync(path.join(s.state, "notes.txt"), "x"); }, [], /not created by herdr-files/],
    ["failed check", (s) => fs.writeFileSync(path.join(s.stubDir, "fail-check"), ""), [], /herdr-app check failed/],
    ["other mod in block", (s) => { const l = structuredClone(MINE); l.children[1].children[0].children[0].content.mod = "my-files"; s.write("layouts/mine.json", l); }, ["--layout", "mine"], /shows the mod "my-files"/],
    ["missing layout", () => {}, ["--layout", "nope"], /not found/],
    ["bad name", () => {}, ["--layout", "../x"], /not a layout name/],
  ];
  for (const [name, prep, args, msg] of cases) {
    const s = sandbox();
    prep(s);
    const before = tree(s.app);
    const r = run(s, "install.mjs", args);
    assert.equal(r.status, 1, `${name}: ${r.stdout}`);
    assert.match(r.stderr, msg, name);
    assert.match(r.stderr, /Nothing was changed/, name);
    assert.deepEqual(tree(s.app), before, `${name}: nothing changed`);
  }
});

test("layout write failure: everything rolled back, the previous mod restored", { skip: canRoot && "root ignores permissions" }, () => {
  const s = sandbox();
  assert.equal(run(s, "install.mjs", ["--no-layout"]).status, 0);
  fs.writeFileSync(path.join(s.mod, "previous.txt"), "previous build");
  const before = tree(s.app);
  fs.chmodSync(path.join(s.app, "layouts"), 0o555);
  try {
    const r = run(s, "install.mjs");
    assert.equal(r.status, 1, r.stdout);
    assert.match(r.stderr, /failed while applying/);
    assert.match(r.stderr, /put back as it was/);
  } finally { fs.chmodSync(path.join(s.app, "layouts"), 0o755); }
  assert.deepEqual(tree(s.app), before, "layout, previous mod, state and backups as before");
});

test("install.json write failure after the layout was written: layout and backup rolled back", { skip: canRoot && "root ignores permissions" }, () => {
  const s = sandbox();
  assert.equal(run(s, "install.mjs", ["--no-layout"]).status, 0);
  fs.mkdirSync(path.join(s.state, "backups"));
  const before = tree(s.app);
  fs.chmodSync(s.state, 0o555);
  try {
    const r = run(s, "install.mjs");
    assert.equal(r.status, 1, r.stdout);
    assert.match(r.stderr, /put back as it was/);
  } finally { fs.chmodSync(s.state, 0o755); }
  assert.deepEqual(tree(s.app), before, "layout restored, backup removed, install.json unchanged");
});

test("uninstall keeps what it does not own or cannot verify", () => {
  // The person pointed the block elsewhere after install: left as is.
  const a = sandbox();
  run(a, "install.mjs");
  const l = json(a.layout("mine")); l.children[1].children[0].children[0].content.mod = "my-files";
  fs.writeFileSync(a.layout("mine"), JSON.stringify(l, null, 2) + "\n");
  assert.equal(run(a, "uninstall.mjs").status, 0);
  assert.equal(filesMod(a.layout("mine")), "my-files");

  // Another layout shows herdr-files without a record: mod and state kept.
  const b = sandbox();
  run(b, "install.mjs");
  const other = structuredClone(MINE); other.children[1].children[0].children[0].content.mod = "herdr-files";
  b.write("layouts/other.json", other);
  const ub = run(b, "uninstall.mjs");
  assert.equal(ub.status, 1);
  assert.match(ub.stderr, /still shown by layout other/);
  assert.ok(fs.existsSync(b.mod) && fs.existsSync(b.state));
  assert.equal(filesMod(b.layout("mine")), "files", "its own layout still restored");

  // A layout that cannot be parsed: mod and state kept.
  const c = sandbox();
  run(c, "install.mjs");
  c.write("layouts/broken.json", "{ not json");
  const uc = run(c, "uninstall.mjs");
  assert.equal(uc.status, 1);
  assert.match(uc.stderr, /broken could not be read/);
  assert.ok(fs.existsSync(c.mod) && fs.existsSync(c.state));
  fs.rmSync(c.layout("broken"));
  assert.equal(run(c, "uninstall.mjs").status, 0, "after fixing it, uninstall finishes");
  assert.equal(fs.existsSync(c.mod), false);

  // A state folder another package wrote: refused before touching anything.
  const d = sandbox();
  run(d, "install.mjs");
  fs.writeFileSync(path.join(d.state, "install.json"), JSON.stringify({ package: "something-else", layouts: { mine: { previous: "x" } } }));
  const before = tree(d.app);
  const ud = run(d, "uninstall.mjs");
  assert.equal(ud.status, 1);
  assert.match(ud.stderr, /not created by herdr-files/);
  assert.deepEqual(tree(d.app), before);

  // A foreign mod folder of the same name is never removed.
  const e = sandbox();
  fs.mkdirSync(e.mod); fs.writeFileSync(path.join(e.mod, "main.js"), "// mine\n");
  assert.equal(run(e, "uninstall.mjs").status, 0);
  assert.ok(fs.existsSync(path.join(e.mod, "main.js")));
});

test("unknown options are refused", () => {
  const s = sandbox();
  assert.equal(run(s, "install.mjs", ["--activate"]).status, 1);
  assert.equal(run(s, "install.mjs", ["--layout", "mine", "--no-layout"]).status, 1);
  assert.equal(run(s, "uninstall.mjs", ["--force"]).status, 1);
});

test("re-patching an edited created layout keeps it from being deleted", () => {
  const s = sandbox({ selected: "main" });
  run(s, "install.mjs", ["--create-layout", "foo"]);
  const l = json(s.layout("foo"));
  l.children[1].children[0].children[0].content.mod = "files"; // the person points it back and edits it
  l.theme = "ink";
  fs.writeFileSync(s.layout("foo"), JSON.stringify(l, null, 2) + "\n");
  assert.equal(run(s, "install.mjs", ["--layout", "foo"]).status, 0);
  assert.equal(filesMod(s.layout("foo")), "herdr-files");
  assert.equal(run(s, "uninstall.mjs").status, 0);
  assert.ok(fs.existsSync(s.layout("foo")), "edited layout kept");
  assert.equal(json(s.layout("foo")).theme, "ink");
  assert.equal(filesMod(s.layout("foo")), "files");
});

test("status tells an unreadable layout from one that does not show the mod", () => {
  const s = sandbox();
  run(s, "install.mjs");
  s.write("layouts/mine.json", "{ broken");
  const r = JSON.parse(run(s, "status.mjs", ["--json"]).stdout);
  assert.equal(r.layouts.mine.shows, null);
  assert.deepEqual(r.unreadable_layouts, ["mine"]);
  assert.match(run(s, "status.mjs").stdout, /mine not valid JSON/);
});

test("generated gpui-shell helpers in a checkout are not installed", () => {
  const s = sandbox();
  const modSrc = path.join(repo, "mod", "herdr-files");
  const made = ["gpui-kit.d.ts", "jsconfig.json"].filter((f) => !fs.existsSync(path.join(modSrc, f)));
  for (const f of made) fs.writeFileSync(path.join(modSrc, f), "// generated\n");
  try {
    assert.equal(run(s, "install.mjs", ["--no-layout"]).status, 0);
    assert.equal(fs.existsSync(path.join(s.mod, "gpui-kit.d.ts")), false);
    assert.equal(fs.existsSync(path.join(s.mod, "jsconfig.json")), false);
    assert.ok(fs.existsSync(path.join(s.mod, "main.js")));
  } finally { for (const f of made) fs.rmSync(path.join(modSrc, f), { force: true }); }
});
