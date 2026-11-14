#!/usr/bin/env node
// Undo install.mjs. In each layout install.mjs recorded, the "files" block goes
// back to the mod it showed before, but only while it still shows herdr-files.
// A layout install.mjs created is removed if it is unchanged and not the selected
// one; otherwise it is kept with its block restored. The mod and the state folder
// are removed only when no layout still shows herdr-files. Never switches layouts.
//   node uninstall.mjs
import fs from "node:fs";
import { MOD, SHIPPED_MOD, paths, readJson, writeAtomic, sha256, layoutFile, selectedLayout, isOurMod, pointFiles, references, layoutText, layoutNames } from "./lib/setup.mjs";

const extra = process.argv.slice(2);
if (extra.length) { process.stderr.write(`herdr-files uninstall: unknown option ${extra[0]}\n`); process.exit(1); }
const P = paths();
const log = (m) => process.stdout.write(`${m}\n`);
const warn = (m) => { process.stderr.write(`herdr-files uninstall: ${m}\n`); process.exitCode = 1; };
// Refuse a state folder this package did not write, before acting on any of it.
let info = {};
if (fs.existsSync(P.state) && fs.readdirSync(P.state).length) {
  info = readJson(P.info);
  if (info?.package !== "herdr-files") { process.stderr.write(`herdr-files uninstall: ${P.state} was not created by herdr-files; nothing was changed.\n`); process.exit(1); }
}
const selected = selectedLayout(P);
let restored = 0, failed = false;

for (const [name, rec] of Object.entries(info.layouts ?? {})) {
  const file = layoutFile(P, name);
  if (!fs.existsSync(file)) { log(`layout ${name}: not found; nothing to restore`); continue; }
  const text = fs.readFileSync(file, "utf8");
  let lay;
  try { lay = JSON.parse(text); } catch { warn(`layout ${name} is not valid JSON; left as is`); failed = true; continue; }
  if (rec.created && rec.sha256 === sha256(text) && name !== selected) {
    fs.rmSync(file, { force: true });
    log(`layout ${name} removed (created by install.mjs, unchanged)`);
    continue;
  }
  const n = pointFiles(lay, MOD, rec.previous || SHIPPED_MOD);
  if (n) {
    try { writeAtomic(file, layoutText(lay)); } catch (e) { warn(`layout ${name} NOT restored (${e.message})`); failed = true; continue; }
    restored++;
    log(`layout ${name}: "files" block -> ${rec.previous || SHIPPED_MOD}${rec.created ? ` (kept: ${name === selected ? "it is the selected layout" : "changed since install"})` : ""}`);
  } else log(`layout ${name}: no longer shows ${MOD}; left as is`);
}

// The mod goes only when every layout is readable and none shows it any more.
const leftover = [], unreadable = [];
for (const n of layoutNames(P)) {
  const lay = readJson(layoutFile(P, n));
  if (!lay) unreadable.push(n); else if (references(lay)) leftover.push(n);
}
if (failed || leftover.length || unreadable.length) {
  if (failed && !leftover.length && !unreadable.length) warn(`kept ${P.mod} and ${P.state}: a recorded layout was not restored (see above).`);
  if (leftover.length) warn(`kept ${P.mod}: still shown by layout ${leftover.join(", ")} (not changed by install.mjs). Point those blocks elsewhere, then run uninstall.mjs again.`);
  if (unreadable.length) warn(`kept ${P.mod} and ${P.state}: layout ${unreadable.join(", ")} could not be read, so it may still show ${MOD}. Fix it, then run uninstall.mjs again.`);
} else {
  if (fs.existsSync(P.mod)) {
    if (!isOurMod(P.mod)) log(`mod ${MOD}: not herdr-files'; left as is`);
    else {
      // Give a running Herdr a moment to reload the restored layouts first.
      if (restored) Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 1500);
      fs.rmSync(P.mod, { recursive: true, force: true });
      log(`mod ${MOD} removed`);
    }
  }
  if (fs.existsSync(P.state)) {
    fs.rmSync(P.state, { recursive: true, force: true });
    log(`${P.state} removed`);
  }
}
