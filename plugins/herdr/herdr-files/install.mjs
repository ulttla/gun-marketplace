#!/usr/bin/env node
// Install or update herdr-files: the mod into <Herdr home>/mods/herdr-files, and
// in one personal layout the "files" block's content.mod pointed at it.
//
//   node install.mjs                          mod + the selected layout, if it is a personal one
//   node install.mjs --layout <name>          mod + that personal layout
//   node install.mjs --create-layout <name> [--from <layout>]
//                                             mod + a new personal copy of <layout> (default main), not shown
//   node install.mjs --no-layout              mod only
//
// It never switches layouts and never touches focus, spaces, tabs or panes:
// Herdr reloads an edited layout file in place. Everything is checked before the layout, mod folder or state is
// written; a failed check changes nothing. Re-running it updates in place.
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  VERSION, MIN_NODE, MOD, BLOCK, SHIPPED_MOD, paths, supportedPlatform, readJson, writeAtomic, sha256, layoutFile, validLayoutName,
  findHerdrApp, herdr, selectedLayout, isShippedLayout, isOurMod, planPatch, pointFiles, layoutText,
} from "./lib/setup.mjs";

const repo = path.dirname(fileURLToPath(import.meta.url));
const log = (m) => process.stdout.write(`${m}\n`);
function fail(msg, hint) {
  process.stderr.write(`herdr-files install: ${msg}\n${hint ? `  ${hint}\n` : ""}Nothing was changed.\n`);
  process.exit(1);
}

// ---- options ----------------------------------------------------------------
const opts = { layout: null, create: null, from: "main", noLayout: false };
const argv = process.argv.slice(2);
for (let i = 0; i < argv.length; i++) {
  const a = argv[i], value = () => { const v = argv[++i]; if (!v || v.startsWith("--")) fail(`${a} needs a layout name`); return v; };
  if (a === "--layout") opts.layout = value();
  else if (a === "--create-layout") opts.create = value();
  else if (a === "--from") opts.from = value();
  else if (a === "--no-layout") opts.noLayout = true;
  else fail(`unknown option ${a}`, "options: --layout <name> | --create-layout <name> [--from <layout>] | --no-layout");
}
if ([opts.layout, opts.create, opts.noLayout || null].filter(Boolean).length > 1) fail("use only one of --layout, --create-layout and --no-layout");
for (const n of [opts.layout, opts.create, opts.from]) if (n != null && !validLayoutName(n)) fail(`"${n}" is not a layout name`, "Use the file name without .json, e.g. my-layout.");

// ---- 1. Checks (no writes) --------------------------------------------------
if (!supportedPlatform()) fail(`unsupported platform ${process.platform}`, "herdr-files supports macOS and Linux.");
if (Number(process.versions.node.split(".")[0]) < MIN_NODE) fail(`Node.js ${process.versions.node} is too old`, `Run it with Node.js ${MIN_NODE} or newer.`);
const P = paths();
if (!fs.existsSync(P.mods) || !fs.existsSync(P.layouts)) fail(`Herdr home not found at ${P.app}`, "Open Herdr once, or set HERDR_APP_HOME to its home folder.");
const hrd = findHerdrApp();
if (!hrd) fail("herdr-app not found", "Install Herdr, put herdr-app on PATH, or set HERDR_APP_BIN.");
if (fs.existsSync(P.mod) && !isOurMod(P.mod)) fail(`${P.mod} exists and was not installed by herdr-files`, "Rename or remove that mod first.");
const info = readJson(P.info);
if (fs.existsSync(P.state) && fs.readdirSync(P.state).length && info?.package !== "herdr-files") fail(`${P.state} exists and was not created by herdr-files`, "Move it away first.");
const records = { ...(info?.layouts ?? {}) };

// The layout plan: { name, file, kind: "patch" | "create", layout, change } or null, plus a note.
let plan = null, note = null;
if (opts.create) {
  const file = layoutFile(P, opts.create);
  if (fs.existsSync(file)) fail(`layout ${opts.create} already exists`, `Pick another name, or patch it with --layout ${opts.create}.`);
  const src = readJson(layoutFile(P, opts.from));
  if (!src) fail(`layout ${opts.from} not found or not valid JSON at ${layoutFile(P, opts.from)}`);
  const p = planPatch(src);
  if (!p.ok) fail(`layout ${opts.from} cannot be used: ${p.reason}`);
  plan = { name: opts.create, file, kind: "create", layout: src, change: true };
} else if (!opts.noLayout) {
  const name = opts.layout ?? selectedLayout(P);
  const explicit = Boolean(opts.layout);
  const skip = (why) => { if (explicit) fail(why.msg, why.hint); note = `layout: ${why.msg}; not changed. ${why.hint}`; };
  if (!name) skip({ msg: "no selected layout found", hint: "Pass --layout <name> or --create-layout <name>." });
  else if (isShippedLayout(P, name)) skip({ msg: `layout ${name} is one of Herdr's own (replaced on every start)`, hint: `Make a personal copy with --create-layout <name> --from ${name}.` });
  else {
    const file = layoutFile(P, name);
    const original = fs.existsSync(file) ? fs.readFileSync(file, "utf8") : null;
    let lay = null;
    try { lay = original == null ? null : JSON.parse(original); } catch {}
    if (!lay) skip({ msg: `layout ${name} not found or not valid JSON at ${file}`, hint: "Check the name (herdr-app status shows the shown layout)." });
    else {
      const p = planPatch(lay);
      if (!p.ok) skip({ msg: `layout ${name} cannot be patched: ${p.reason}`, hint: "Only a block with id \"files\" showing Herdr's files mod is changed." });
      else plan = { name, file, kind: "patch", layout: lay, change: p.change, original };
    }
  }
}

// Stage the mod and let herdr-app check it before anything is written.
// Helpers `herdr-app check` writes into a checkout; Herdr writes its own into the installed mod.
const GENERATED = new Set(["gpui-kit.d.ts", "jsconfig.json"]);
function copyTree(from, to) {
  fs.mkdirSync(to, { recursive: true });
  for (const e of fs.readdirSync(from, { withFileTypes: true })) {
    if (GENERATED.has(e.name)) continue;
    const a = path.join(from, e.name), b = path.join(to, e.name);
    if (e.isDirectory()) copyTree(a, b); else fs.copyFileSync(a, b);
  }
}
const stage = fs.mkdtempSync(path.join(P.app, ".herdr-files-stage-"));
const cleanStage = () => fs.rmSync(stage, { recursive: true, force: true });
copyTree(path.join(repo, "mod", MOD), path.join(stage, MOD));
const checked = herdr(hrd, ["check", path.join(stage, MOD)]);
if (!checked.ok) { cleanStage(); fail("herdr-app check failed for the mod", checked.out.split("\n").slice(0, 6).join("\n  ")); }

// ---- 2. Apply ---------------------------------------------------------------
// Every change is undone if a later one fails: the previous mod stays in the
// stage until the layout and install.json are written.
const undo = [];
const exists = (f) => fs.existsSync(f);
const lines = [];
let show = null;
try {
  const old = path.join(stage, `${MOD}.old`);
  if (exists(P.mod)) { fs.renameSync(P.mod, old); undo.push(() => { fs.rmSync(P.mod, { recursive: true, force: true }); fs.renameSync(old, P.mod); }); }
  else undo.push(() => fs.rmSync(P.mod, { recursive: true, force: true }));
  fs.renameSync(path.join(stage, MOD), P.mod);
  lines.push(`mod -> ${P.mod}`);

  if (!exists(P.state)) { fs.mkdirSync(P.state); undo.push(() => fs.rmSync(P.state, { recursive: true, force: true })); }
  if (plan?.kind === "create") {
    pointFiles(plan.layout, SHIPPED_MOD, MOD);
    const text = layoutText(plan.layout);
    writeAtomic(plan.file, text);
    undo.push(() => fs.rmSync(plan.file, { force: true }));
    records[plan.name] = { previous: SHIPPED_MOD, created: true, sha256: sha256(text) };
    lines.push(`layout ${plan.name} created from ${opts.from}, not shown`);
    show = plan.name;
  } else if (plan?.kind === "patch") {
    const rec = { ...(records[plan.name] ?? { previous: SHIPPED_MOD, created: false }) };
    if (plan.change) {
      if (!exists(P.backups)) { fs.mkdirSync(P.backups); undo.push(() => fs.rmSync(P.backups, { recursive: true, force: true })); }
      const backup = path.join(P.backups, `${plan.name}.json.${new Date().toISOString().replace(/[:.]/g, "-")}`);
      fs.writeFileSync(backup, plan.original, { flag: "wx" });
      undo.push(() => fs.rmSync(backup, { force: true }));
      pointFiles(plan.layout, SHIPPED_MOD, MOD);
      const text = layoutText(plan.layout);
      writeAtomic(plan.file, text);
      undo.push(() => writeAtomic(plan.file, plan.original));
      rec.backup = backup;
      // A created layout stays removable only while nobody else changed it.
      if (rec.created && rec.sha256 === sha256(plan.original)) rec.sha256 = sha256(text);
      lines.push(`layout ${plan.name}: "${BLOCK}" block -> ${MOD} (backup ${backup})`);
    } else lines.push(`layout ${plan.name}: "${BLOCK}" block already shows ${MOD}`);
    records[plan.name] = rec;
    if (plan.name !== selectedLayout(P)) show = plan.name;
  }

  writeAtomic(P.info, JSON.stringify({ package: "herdr-files", version: VERSION, herdr_app: hrd, layouts: records, installed_at: new Date().toISOString() }, null, 2) + "\n");
} catch (e) {
  const left = [];
  for (const f of undo.reverse()) try { f(); } catch (u) { left.push(u.message); }
  process.stderr.write(`herdr-files install: failed while applying (${e.message}).\n`);
  if (left.length) {
    // The stage may still hold the previous mod (herdr-files.old): keep it for recovery.
    process.stderr.write(`  Could not undo everything (${left.join("; ")}).\n  Kept ${stage} (the previous mod, if any, is in ${path.join(stage, `${MOD}.old`)}). Backups, if any, are in ${P.backups}.\n`);
  } else {
    cleanStage();
    process.stderr.write("  Everything was put back as it was. Fix the cause and run install.mjs again.\n");
  }
  process.exit(1);
}
cleanStage();
for (const l of lines) log(l);
if (note) log(note);
if (show) log(`show it when you want: herdr-app do layout.switch '{"name":"${show}"}'`);
log(`herdr-files ${VERSION} installed`);
