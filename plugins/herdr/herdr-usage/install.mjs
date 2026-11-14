#!/usr/bin/env node
// Install or update herdr-usage: the collector and statusline wrapper into
// <Herdr home>/usage, the two mods into <Herdr home>/mods, a key-only statusLine
// wrapper for Claude Code and Antigravity (agy), and the gun-usage layout (a copy
// of Herdr's main layout whose status bar is gun-usage-bar).
//
//   node install.mjs [--language en|ko] [--no-activate] [--skip-layout] [--skip-settings] [--skip-claude] [--skip-agy]
//
// --language sets the display language and is saved in install.json. Without it
// an update keeps the saved language (Korean for installs made before 0.1.5)
// and a new install uses English.
// Everything is checked before the first write; a failed check changes nothing.
// Re-running it updates an existing install in place (it never wraps a wrapper).
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { installStatusLine, checkEditable } from "./lib/settings.mjs";
import { claudeSettingsPath, agySettingsPath } from "./lib/snapshot.mjs";
import { readJson, writeAtomic } from "./lib/util.mjs";
import {
  VERSION, MIN_NODE, MODS, LAYOUT, paths, parseInstallArgs, existingInstall, chooseLanguage, stableNode, supportedPlatform, findAgy, findCodex, findHerdrApp, herdr, shownLayout, nodeMajor,
  isOurMod, isOurUsageHome, isOurLayout, pointStatusAtBar,
} from "./lib/setup.mjs";

const repo = path.dirname(fileURLToPath(import.meta.url));
const KNOWN = ["--no-activate", "--skip-layout", "--skip-settings", "--skip-claude", "--skip-agy"];
const log = (m) => process.stdout.write(`${m}\n`);
function fail(msg, hint) {
  process.stderr.write(`herdr-usage install: ${msg}\n${hint ? `  ${hint}\n` : ""}Nothing was changed.\n`);
  process.exit(1);
}

// ---- 1. Checks (no writes) -------------------------------------------------
let opts;
try { opts = parseInstallArgs(process.argv.slice(2), KNOWN); } catch (e) { fail(e.message, `options: --language en|ko ${KNOWN.join(" ")}`); }
const args = opts.flags;
if (!supportedPlatform()) fail(`unsupported platform ${process.platform}`, "herdr-usage supports macOS, Linux and Windows.");
if (Number(process.versions.node.split(".")[0]) < MIN_NODE) fail(`Node.js ${process.versions.node} is too old`, `Run it with Node.js ${MIN_NODE} or newer.`);

const P = paths();
const node = stableNode();
const nm = nodeMajor(node);
if (nm == null || nm < MIN_NODE) fail(`the Node.js the statusline and Herdr will run (${node}) is missing or older than ${MIN_NODE}`, "Set HERDR_USAGE_NODE to a stable Node.js path.");

if (!fs.existsSync(P.app) || !fs.existsSync(P.mods)) fail(`Herdr home not found at ${P.app}`, "Open Herdr once, or set HERDR_APP_HOME to its home folder.");
const hrd = findHerdrApp();
if (!hrd) fail("herdr-app not found", "Install Herdr, put herdr-app on PATH, or set HERDR_APP_BIN.");

for (const m of MODS) {
  const dir = path.join(P.mods, m);
  if (fs.existsSync(dir) && !isOurMod(dir)) fail(`${dir} exists and was not installed by herdr-usage`, "Rename or remove that mod first.");
}
if (!isOurUsageHome(P.usage)) fail(`${P.usage} exists and was not created by herdr-usage`, "Move it away, or set HERDR_USAGE_HOME to another folder.");
const prevInfo = readJson(P.info, {}) ?? {};
const lang = chooseLanguage({ explicit: opts.language, prevInfo, existing: existingInstall(P, prevInfo) });

// statusLine plans: skip a CLI whose config folder does not exist (it is not set up here).
const settingsPlan = [];
if (!args.has("--skip-settings")) {
  for (const [src, file] of [["claude", claudeSettingsPath({ recorded: false })], ["agy", agySettingsPath({ recorded: false })]]) {
    if (args.has(`--skip-${src}`)) continue;
    if (!fs.existsSync(path.dirname(file))) { settingsPlan.push({ src, file, skip: `${path.dirname(file)} not found; skipped` }); continue; }
    try { checkEditable(file); } catch (e) { fail(`${src} settings: ${e.message}`, `Or pass --skip-${src}.`); }
    settingsPlan.push({ src, file });
  }
}

// layout plan
let layoutPlan = null;
if (!args.has("--skip-layout")) {
  if (fs.existsSync(P.layout)) {
    if (!isOurLayout(P.layout)) fail(`${P.layout} exists and is not herdr-usage's layout`, "Rename or remove it, or pass --skip-layout.");
    layoutPlan = { kind: "update" };
  } else {
    const main = readJson(path.join(P.layouts, "main.json"));
    if (!main) fail(`Herdr's main layout not found at ${path.join(P.layouts, "main.json")}`, "Open Herdr once, or pass --skip-layout.");
    if (!pointStatusAtBar(main)) fail("Herdr's main layout has no status bar block to replace", "This Herdr version is not supported; pass --skip-layout.");
    const activate = !args.has("--no-activate");
    const prev = activate ? shownLayout(hrd) : null;
    if (activate && !prev) fail("no running Herdr window answered herdr-app status", "Start Herdr, or pass --no-activate and switch layouts later.");
    layoutPlan = { kind: "create", layout: main, activate, prev };
  }
}

// Stage both mods with the paths filled in, and let herdr-app check them.
// Forward slashes are valid Windows paths and safe inside JS and shell literals.
const sub = (s) => s.replaceAll("@NODE@", node.replaceAll("\\", "/")).replaceAll("@USAGE_HOME@", P.usage.replaceAll("\\", "/")).replaceAll("@LANG@", lang.language);
function copyTree(from, to, transform) {
  fs.mkdirSync(to, { recursive: true });
  for (const e of fs.readdirSync(from, { withFileTypes: true })) {
    const a = path.join(from, e.name), b = path.join(to, e.name);
    if (e.isDirectory()) copyTree(a, b, transform);
    else {
      const tmp = `${b}.tmp-${process.pid}`;
      const text = fs.readFileSync(a, "utf8");
      fs.writeFileSync(tmp, transform ? transform(text) : text, { mode: fs.statSync(a).mode & 0o777 });
      fs.renameSync(tmp, b);
    }
  }
}
// Layout files sit in Herdr's own folder: write beside them, leave the folder's mode alone.
function writeLayout(text) {
  const tmp = `${P.layout}.tmp-${process.pid}`;
  fs.writeFileSync(tmp, text, { mode: 0o644 });
  fs.renameSync(tmp, P.layout);
}
const stage = fs.mkdtempSync(path.join(P.app, ".herdr-usage-stage-"));
const cleanStage = () => fs.rmSync(stage, { recursive: true, force: true });
for (const m of MODS) {
  const dst = path.join(stage, m);
  copyTree(path.join(repo, "mod", m), dst);
  copyTree(path.join(repo, "mod", "shared"), dst, sub);
  const r = herdr(hrd, ["check", dst], 60_000);
  if (!r.ok) { cleanStage(); fail(`herdr-app check failed for ${m}`, r.out.split("\n").slice(0, 6).join("\n  ")); }
}

// ---- 2. Apply ---------------------------------------------------------------
const problems = [];
try {
  // collector
  for (const d of [P.usage, path.join(P.usage, "cache"), path.join(P.usage, "state")]) { fs.mkdirSync(d, { recursive: true, mode: 0o700 }); fs.chmodSync(d, 0o700); }
  copyTree(path.join(repo, "bin"), path.join(P.usage, "bin"), sub);
  copyTree(path.join(repo, "lib"), path.join(P.usage, "lib"));
  fs.writeFileSync(path.join(P.usage, "package.json"), '{ "type": "module", "private": true }\n');
  log(`collector -> ${P.usage}`);

  // mods: swap each checked folder in whole (Herdr reloads it in place)
  for (const m of MODS) {
    const dst = path.join(P.mods, m), old = path.join(stage, `${m}.old`);
    if (fs.existsSync(dst)) fs.renameSync(dst, old);
    try { fs.renameSync(path.join(stage, m), dst); } catch (e) { if (fs.existsSync(old)) fs.renameSync(old, dst); throw e; }
    log(`mod -> ${dst}`);
  }
} catch (e) {
  cleanStage();
  process.stderr.write(`herdr-usage install: failed while copying files (${e.message}).\n  Fix the cause and run install.mjs again; it is safe to repeat.\n`);
  process.exit(1);
}
cleanStage();

// statusLine wrappers (key-only)
const settings = { ...(prevInfo.settings ?? {}) };
const wrapPath = path.join(P.usage, "bin", process.platform === "win32" ? "statusline-wrap.mjs" : "statusline-wrap");
for (const p of settingsPlan) {
  if (p.skip) { log(`${p.src} statusLine: ${p.skip}`); continue; }
  try {
    const r = installStatusLine({ file: p.file, src: p.src, wrapPath, origFile: path.join(P.usage, "state", `${p.src}-statusline.orig.json`), create: true });
    settings[p.src] = p.file;
    log(`${p.src} statusLine: ${r.note}`);
  } catch (e) {
    problems.push(`${p.src} statusLine not changed: ${e.message}`);
  }
}

// layout
let layoutNote = null;
if (layoutPlan?.kind === "update") {
  // Kept as the person left it; only the status block is pointed at the bar again.
  const lay = readJson(P.layout);
  const before = JSON.stringify(lay);
  pointStatusAtBar(lay);
  if (JSON.stringify(lay) !== before) writeLayout(JSON.stringify(lay, null, 2) + "\n");
  layoutNote = `layout ${LAYOUT} kept (switch with: herdr-app do layout.switch '{"name":"${LAYOUT}"}')`;
} else if (layoutPlan?.kind === "create") {
  writeLayout(JSON.stringify(layoutPlan.layout, null, 2) + "\n");
  if (layoutPlan.activate) {
    // Herdr picks a new layout file up within a second or so.
    let r = null;
    for (let i = 0; i < 20; i++) {
      r = herdr(hrd, ["do", "layout.switch", JSON.stringify({ name: LAYOUT })], 10_000);
      if (r.ok) break;
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 300);
    }
    if (r.ok) layoutNote = `layout ${LAYOUT} created and shown (back to the default: herdr-app do layout.switch '{"name":"${layoutPlan.prev}"}')`;
    else problems.push(`layout ${LAYOUT} was created but could not be shown (${r.out.split("\n")[0]}); run: herdr-app do layout.switch '{"name":"${LAYOUT}"}'`);
  } else {
    layoutNote = `layout ${LAYOUT} created, not shown (show it with: herdr-app do layout.switch '{"name":"${LAYOUT}"}')`;
  }
}
if (layoutNote) log(layoutNote);
log(`language ${lang.language} (${lang.reason}; change with: node install.mjs --language ${lang.language === "en" ? "ko" : "en"})`);

writeAtomic(P.info, JSON.stringify({
  package: "herdr-usage",
  version: VERSION,
  language: lang.language,
  node,
  herdr_app: hrd,
  codex: findCodex(),
  agy: findAgy(),
  codex_home: process.env.CODEX_HOME || prevInfo.codex_home || null,
  settings,
  layout: layoutPlan ? LAYOUT : prevInfo.layout ?? null,
  installed_at: new Date().toISOString(),
}, null, 2) + "\n");

if (problems.length) {
  for (const p of problems) process.stderr.write(`herdr-usage install: ${p}\n`);
  process.stderr.write("The rest is installed. Fix the cause and run install.mjs again, or run uninstall.mjs.\n");
  process.exit(1);
}
log(`herdr-usage ${VERSION} installed`);
