import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { installStatusLine, uninstallStatusLine, isWrapper, originalFromWrapper, wrapperCommand } from "../lib/settings.mjs";
import { findHerdrApp, findCodex, which } from "../lib/setup.mjs";

const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
// Avoid Node 25's native cpSync crash on some Unicode Windows paths.
function copyTree(from, to) {
  fs.mkdirSync(to, { recursive: true });
  for (const entry of fs.readdirSync(from, { withFileTypes: true })) {
    const source = path.join(from, entry.name), dest = path.join(to, entry.name);
    if (entry.isDirectory()) copyTree(source, dest);
    else fs.writeFileSync(dest, fs.readFileSync(source));
  }
}
test("Windows: install, wrapper pass-through, update, restore in isolated home", { skip: process.platform !== "win32" || !findHerdrApp() }, () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "usage Windows '한글-"));
  const app = path.join(home, "herdr");
  const usage = path.join(app, "usage");
  const claude = path.join(home, "claude.json"), agy = path.join(home, "agy.json");
  const script = path.join(home, "original.mjs");
  fs.writeFileSync(script, 'import fs from "node:fs"; process.stdout.write(fs.readFileSync(0)); process.stderr.write("original-stderr"); process.exitCode=7;');
  const command = `"${process.execPath}" "${script}"`;
  const original = JSON.stringify({ model: "keep", statusLine: { type: "command", command, padding: 0 } }, null, 2) + "\n";
  fs.mkdirSync(path.join(app, "mods"), { recursive: true });
  fs.mkdirSync(path.join(app, "layouts"));
  fs.writeFileSync(path.join(app, "layouts", "main.json"), JSON.stringify({ id: "root", type: "column", children: [{ id: "status", type: "block", content: { mod: "workspace-status" } }] }));
  fs.writeFileSync(claude, original);
  fs.writeFileSync(agy, '{}\n');
  const env = { ...process.env, HERDR_APP_HOME: app, HERDR_USAGE_HOME: usage, HERDR_USAGE_CLAUDE_SETTINGS: claude, HERDR_USAGE_AGY_SETTINGS: agy };
  const run = (name) => spawnSync(process.execPath, [path.join(repo, name), "--no-activate"], { env, encoding: "utf8", windowsHide: true });
  try {
    const installed = run("install.mjs");
    assert.equal(installed.status, 0, installed.stdout + installed.stderr);
    const sl = JSON.parse(fs.readFileSync(claude)).statusLine;
    assert.ok(isWrapper(sl));
    assert.equal(originalFromWrapper(sl), command);
    assert.equal(JSON.parse(fs.readFileSync(claude)).model, "keep");
    const input = fs.readFileSync(path.join(repo, "test/fixtures/claude-statusline.json"));
    const wrapped = spawnSync(sl.command, { shell: true, env, input, encoding: "utf8", windowsHide: true });
    assert.equal(wrapped.status, 7, wrapped.stderr);
    assert.equal(wrapped.stdout, input.toString());
    assert.equal(wrapped.stderr, "original-stderr");
    assert.ok(fs.readdirSync(path.join(usage, "cache/captures")).some(n => n.startsWith("claude-")));
    const second = run("install.mjs");
    assert.equal(second.status, 0, second.stderr);
    assert.deepEqual(JSON.parse(fs.readFileSync(claude)).statusLine, sl);
    // Restore directly: no interaction with the running window or its layout.
    for (const [src, file] of [["claude", claude], ["agy", agy]]) {
      assert.ok(uninstallStatusLine({ file, origFile: path.join(usage, "state", `${src}-statusline.orig.json`) }).changed);
    }
    assert.equal(fs.readFileSync(claude, "utf8"), original);
    assert.deepEqual(JSON.parse(fs.readFileSync(agy)), {});
  } finally { fs.rmSync(home, { recursive: true, force: true }); }
});

test("Windows: native wrapper preserves bytes, status and saved command without Herdr", { skip: process.platform !== "win32" }, () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "usage Windows '한글-"));
  try {
    copyTree(path.join(repo, "bin"), path.join(home, "bin"));
    copyTree(path.join(repo, "lib"), path.join(home, "lib"));
    fs.writeFileSync(path.join(home, "package.json"), '{"type":"module"}');
    const file = path.join(home, "settings.json"), origFile = path.join(home, "state", "original.json");
    const script = path.join(home, "original.mjs");
    fs.writeFileSync(script, 'import fs from "node:fs"; process.stdout.write(fs.readFileSync(0)); process.stderr.write("stderr"); process.exitCode=9;');
    const command = `"${process.execPath}" "${script}"`;
    const before = JSON.stringify({ statusLine: { type: "command", command } }, null, 2) + "\n";
    fs.writeFileSync(file, before);
    const params = { file, src: "claude", wrapPath: path.join(home, "bin", "statusline-wrap.mjs"), origFile };
    assert.ok(installStatusLine(params).changed);
    assert.equal(installStatusLine(params).changed, false);
    const sl = JSON.parse(fs.readFileSync(file)).statusLine;
    assert.ok(isWrapper(sl));
    assert.equal(originalFromWrapper(sl), command);
    const input = fs.readFileSync(path.join(repo, "test/fixtures/claude-statusline.json"));
    const env = { ...process.env, HERDR_USAGE_HOME: home };
    const result = spawnSync(sl.command, { shell: true, input, env, windowsHide: true });
    assert.equal(result.status, 9);
    assert.deepEqual(result.stdout, input);
    assert.equal(result.stderr.toString(), "stderr");
    assert.ok(fs.readdirSync(path.join(home, "cache", "captures")).length > 0);
    assert.ok(uninstallStatusLine({ file, origFile }).changed);
    assert.equal(fs.readFileSync(file, "utf8"), before);
  } finally { fs.rmSync(home, { recursive: true, force: true }); }
});

test("Windows: discovers a native executable using PATHEXT-style exe suffix", { skip: process.platform !== "win32" }, () => {
  assert.equal(which("node"), process.execPath);
  const found = findCodex();
  if (found) assert.match(found, /\.exe$/i);
});

test("Windows agy: cmd argument quoting, Unicode paths, pass-through and upgrade", { skip: process.platform !== "win32" }, () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "usage agy '한글 &-"));
  try {
    copyTree(path.join(repo, "bin"), path.join(home, "bin"));
    copyTree(path.join(repo, "lib"), path.join(home, "lib"));
    fs.writeFileSync(path.join(home, "package.json"), '{"type":"module"}');
    const file = path.join(home, "settings.json"), origFile = path.join(home, "state", "original.json");
    const wrapPath = path.join(home, "bin", "statusline-wrap.mjs");
    const script = path.join(home, "original.mjs");
    fs.writeFileSync(script, 'import fs from "node:fs"; process.stdout.write(fs.readFileSync(0)); process.stderr.write("original-stderr"); process.exitCode=7;');
    const original = `"${process.execPath}" "${script}"`;
    const before = JSON.stringify({ model: "keep", statusLine: { type: "command", command: original } }, null, 2) + "\n";
    fs.writeFileSync(file, before);
    const params = { file, src: "agy", wrapPath, origFile };
    installStatusLine(params);
    const sl = JSON.parse(fs.readFileSync(file)).statusLine;
    assert.ok(isWrapper(sl));
    assert.equal(originalFromWrapper(sl), original);
    assert.equal(installStatusLine(params).changed, false);
    const input = Buffer.concat([fs.readFileSync(path.join(repo, "test/fixtures/agy-statusline.json")), Buffer.alloc(1024 * 1024, 0x20)]);
    const env = { ...process.env, HERDR_USAGE_HOME: home };
    // No shell:true: reproduce agy's cmd.exe /c invocation, including normal
    // Windows argv escaping instead of Node's verbatim shell command mode.
    const run = (command) => spawnSync(process.env.ComSpec || "cmd.exe", ["/c", command], { input, env, windowsHide: true, maxBuffer: 4 * 1024 * 1024 });
    const legacy = `"${process.execPath}" "${wrapPath}" agy ${Buffer.from(original).toString("base64")}`;
    assert.notEqual(run(legacy).status, 0, "the old launcher reproduces the reported failure");
    const result = run(sl.command);
    assert.equal(result.status, 7, result.stderr?.toString());
    assert.deepEqual(result.stdout, input);
    assert.equal(result.stderr.toString(), "original-stderr");
    assert.ok(fs.readdirSync(path.join(home, "cache", "captures")).some(n => n.startsWith("agy-")));
    const silent = run(wrapperCommand(wrapPath, "agy", ""));
    assert.equal(silent.status, 0, silent.stderr?.toString());
    assert.equal(silent.stdout.length, 0);
    assert.equal(silent.stderr.length, 0);

    // Both the original quoted launcher and the local unquoted workaround
    // must migrate without changing the saved statusline or unrelated keys.
    const saved = fs.readFileSync(origFile, "utf8");
    for (const command of [legacy, `C:/PROGRA~1/nodejs/node.exe C:/usage/bin/statusline-wrap.mjs agy ${Buffer.from(original).toString("base64")}`]) {
      fs.writeFileSync(file, JSON.stringify({ model: "keep", statusLine: { ...sl, command } }, null, 2) + "\n");
      assert.ok(installStatusLine(params).changed);
      assert.equal(JSON.parse(fs.readFileSync(file)).model, "keep");
      assert.deepEqual(JSON.parse(fs.readFileSync(file)).statusLine, sl);
      assert.equal(fs.readFileSync(origFile, "utf8"), saved);
    }
    assert.ok(uninstallStatusLine(params).changed);
    assert.equal(fs.readFileSync(file, "utf8"), before);
    // Recovery still works if the saved state is lost.
    installStatusLine(params);
    fs.unlinkSync(origFile);
    assert.ok(uninstallStatusLine(params).changed);
    assert.equal(JSON.parse(fs.readFileSync(file)).statusLine.command, original);
  } finally { fs.rmSync(home, { recursive: true, force: true }); }
});
