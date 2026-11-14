#!/usr/bin/env node
// What is installed and which layouts show herdr-files. Read-only; exits 1 when
// the mod is not installed.
//   node status.mjs [--json]
import fs from "node:fs";
import { MOD, paths, readJson, layoutFile, selectedLayout, isOurMod, references, layoutNames, findHerdrApp, herdr } from "./lib/setup.mjs";

const P = paths();
const info = readJson(P.info, {}) ?? {};
const recorded = info.layouts ?? {};
// true / false, or null when the file is missing or not valid JSON.
const shows = (name) => { const lay = readJson(layoutFile(P, name)); return lay ? references(lay) : null; };
const hrd = (info.herdr_app && fs.existsSync(info.herdr_app) && info.herdr_app) || findHerdrApp();
let errors = null;
if (hrd) {
  // `status` only reads what the window shows.
  const r = herdr(hrd, ["status"], 10_000);
  if (r.ok) try { errors = (JSON.parse(r.out).errors ?? []).filter((e) => JSON.stringify(e).includes(MOD)); } catch {}
}
const out = {
  installed: isOurMod(P.mod),
  version: info.version ?? null,
  mod: P.mod,
  selected_layout: selectedLayout(P),
  layouts: Object.fromEntries(Object.entries(recorded).map(([n, r]) => [n, { exists: fs.existsSync(layoutFile(P, n)), shows: shows(n), created: Boolean(r.created), backup: r.backup ?? null }])),
  other_layouts: layoutNames(P).filter((n) => !(n in recorded) && shows(n)),
  unreadable_layouts: layoutNames(P).filter((n) => shows(n) === null),
  herdr_errors: errors,
};

if (process.argv.includes("--json")) process.stdout.write(JSON.stringify(out, null, 2) + "\n");
else {
  const lines = [
    `installed:  ${out.installed ? `yes (${out.version ?? "unknown version"})` : "no"} at ${out.mod}`,
    `selected:   ${out.selected_layout ?? "unknown"}`,
    ...Object.entries(out.layouts).map(([n, l]) => `layout:     ${n}${l.created ? " (created)" : ""} ${!l.exists ? "missing" : l.shows === null ? "not valid JSON" : l.shows ? `shows ${MOD}` : `no longer shows ${MOD}`}`),
    ...out.other_layouts.map((n) => `layout:     ${n} shows ${MOD} (not changed by install.mjs)`),
    ...out.unreadable_layouts.filter((n) => !(n in recorded)).map((n) => `layout:     ${n} not valid JSON`),
    `herdr:      ${errors == null ? "no window answered" : errors.length ? `errors: ${errors.map((e) => JSON.stringify(e)).join("; ")}` : "no errors for this mod"}`,
  ];
  process.stdout.write(lines.join("\n") + "\n");
}
if (!out.installed) process.exitCode = 1;
