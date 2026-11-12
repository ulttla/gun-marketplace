import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { installStatusLine, uninstallStatusLine, isWrapper, originalFromWrapper } from "../lib/settings.mjs";

const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
test("Windows: install, wrapper pass-through, update, restore in isolated home", { skip: process.platform !== "win32" }, () => {
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
