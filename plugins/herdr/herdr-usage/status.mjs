#!/usr/bin/env node
// Show what is installed and how each source last reported. Read-only: it
// prints statuses and times, never usage numbers, settings contents or keys.
//   node status.mjs [--json]
import fs from "node:fs";
import path from "node:path";
import { isWrapper } from "./lib/settings.mjs";
import { claudeSettingsPath, agySettingsPath } from "./lib/snapshot.mjs";
import { readJson } from "./lib/util.mjs";
import { MODS, LAYOUT, paths, findHerdrApp, shownLayout, isOurMod, isOurLayout } from "./lib/setup.mjs";

const P = paths();
const info = readJson(P.info, {}) ?? {};
const snap = readJson(path.join(P.usage, "cache", "snapshot.json"));
const hrd = (info.herdr_app && fs.existsSync(info.herdr_app) && info.herdr_app) || findHerdrApp();
const shown = hrd ? shownLayout(hrd) : null;
const age = (s) => (s ? `${Math.max(0, Math.round(Date.now() / 1000 - s))} s ago` : "never");

const settings = {};
for (const [src, file] of [["claude", info.settings?.claude || claudeSettingsPath({ recorded: false })], ["agy", info.settings?.agy || agySettingsPath({ recorded: false })]]) {
  settings[src] = { file, wrapped: isWrapper(readJson(file)?.statusLine) };
}
const out = {
  installed: fs.existsSync(path.join(P.usage, "bin", "herdr-usage")),
  version: info.version ?? null,
  language: info.language ?? null,
  usage_home: P.usage,
  mods: Object.fromEntries(MODS.map((m) => [m, isOurMod(path.join(P.mods, m))])),
  layout: { exists: isOurLayout(P.layout), shown: shown === LAYOUT, current: shown },
  statusline: settings,
  snapshot_generated: snap?.generated_at ?? null,
  sources: Object.fromEntries(Object.entries(snap?.sources ?? {}).map(([k, s]) => [k, { status: s.status, method: s.method ?? null, observed_at: s.observed_at ?? null }])),
};

if (process.argv.includes("--json")) {
  process.stdout.write(JSON.stringify(out, null, 2) + "\n");
} else {
  const yes = (b) => (b ? "yes" : "no");
  const lines = [
    `installed:   ${yes(out.installed)}${out.version ? ` (${out.version})` : ""} at ${out.usage_home}`,
    `language:    ${out.language ?? (out.installed ? "not recorded (installed before 0.1.5; Korean)" : "-")}`,
    `mods:        ${MODS.map((m) => `${m} ${yes(out.mods[m])}`).join(", ")}`,
    `layout:      ${LAYOUT} ${out.layout.exists ? "present" : "absent"}${shown == null ? " (no Herdr window answered)" : out.layout.shown ? ", shown" : `, shown layout is ${shown}`}`,
    ...Object.entries(settings).map(([src, s]) => `statusline:  ${src} ${s.wrapped ? "wrapped" : "not wrapped"} (${s.file})`),
    `snapshot:    ${age(out.snapshot_generated)}`,
    ...Object.entries(out.sources).map(([k, s]) => `  ${k.padEnd(7)} ${s.status}${s.method ? ` via ${s.method}` : ""}, observed ${age(s.observed_at)}`),
  ];
  process.stdout.write(lines.join("\n") + "\n");
}
if (!out.installed) process.exitCode = 1;
