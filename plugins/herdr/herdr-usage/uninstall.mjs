#!/usr/bin/env node
// Undo install.mjs: restore each statusLine only if it is still the wrapper,
// leave the gun-usage layout (switching to main first if it is shown), and
// remove the layout, the two mods and the usage folder (cache, captures, state).
//   node uninstall.mjs [--keep-files]
import fs from "node:fs";
import path from "node:path";
import { uninstallStatusLine } from "./lib/settings.mjs";
import { claudeSettingsPath, agySettingsPath } from "./lib/snapshot.mjs";
import { readJson } from "./lib/util.mjs";
import { MODS, LAYOUT, paths, findHerdrApp, herdr, shownLayout, isOurMod, isOurLayout, isOurUsageHome } from "./lib/setup.mjs";

const args = new Set(process.argv.slice(2));
const P = paths();
const info = readJson(P.info, {}) ?? {};
const log = (m) => process.stdout.write(`${m}\n`);
const warn = (m) => { process.stderr.write(`herdr-usage uninstall: ${m}\n`); process.exitCode = 1; };

// The files install.mjs recorded, else this environment's defaults (installs before install.json).
const files = { claude: info.settings?.claude || claudeSettingsPath({ recorded: false }), agy: info.settings?.agy || agySettingsPath({ recorded: false }) };
let keepState = false;
for (const [src, file] of Object.entries(files)) {
  try {
    const r = uninstallStatusLine({ file, origFile: path.join(P.usage, "state", `${src}-statusline.orig.json`) });
    log(`${src} statusLine: ${r.note}`);
    if (!r.changed && r.note !== "no saved original" && r.note !== "settings file missing") keepState = true;
    if (r.unsafe) process.exitCode = 1;
  } catch (e) {
    warn(`${src} statusLine NOT restored (${e.message})`);
    keepState = true;
  }
}

if (!args.has("--keep-files")) {
  if (fs.existsSync(P.layout)) {
    if (!isOurLayout(P.layout)) log(`layout ${LAYOUT}: not herdr-usage's; left as is`);
    else {
      const hrd = (info.herdr_app && fs.existsSync(info.herdr_app) && info.herdr_app) || findHerdrApp();
      if (hrd && shownLayout(hrd) === LAYOUT) {
        const r = herdr(hrd, ["do", "layout.switch", JSON.stringify({ name: "main" })], 10_000);
        if (!r.ok) warn(`could not switch back to the main layout (${r.out.split("\n")[0]}); switch with ctrl-shift-l`);
      }
      fs.rmSync(P.layout, { force: true });
      log(`layout ${LAYOUT} removed`);
    }
  }
  for (const m of MODS) {
    const dir = path.join(P.mods, m);
    if (!fs.existsSync(dir)) continue;
    if (!isOurMod(dir)) { log(`mod ${m}: not herdr-usage's; left as is`); continue; }
    fs.rmSync(dir, { recursive: true, force: true });
    log(`mod ${m} removed`);
  }
  if (!fs.existsSync(P.usage)) {
    // nothing to remove
  } else if (!isOurUsageHome(P.usage)) {
    log(`${P.usage}: not herdr-usage's; left as is`);
  } else if (keepState) {
    // A statusLine may still point at the wrapper: keep bin/lib/state, drop only cached data.
    fs.rmSync(path.join(P.usage, "cache"), { recursive: true, force: true });
    warn(`kept ${P.usage}/{bin,lib,state}: a statusLine still uses the wrapper (see above)`);
  } else {
    fs.rmSync(P.usage, { recursive: true, force: true });
    log(`${P.usage} removed`);
  }
}
