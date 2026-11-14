// Shared by install.mjs, uninstall.mjs and status.mjs: where things live, how to
// find herdr-app, how to tell this package's files from someone else's, and the
// one layout edit it makes (the "files" block's content.mod).
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import crypto from "node:crypto";
import { spawnSync } from "node:child_process";

export const VERSION = "0.1.0";
export const MIN_NODE = 22;
export const MOD = "herdr-files";
export const BLOCK = "files"; // the block id Herdr's tab bar toggles; kept as is
export const SHIPPED_MOD = "files";
const MARK = 'PACKAGE = "herdr-files"';

export function paths() {
  const app = process.env.HERDR_APP_HOME || path.join(os.homedir(), ".config", "herdr-app");
  const state = path.join(app, "herdr-files");
  return { app, mods: path.join(app, "mods"), mod: path.join(app, "mods", MOD), layouts: path.join(app, "layouts"), state, info: path.join(state, "install.json"), backups: path.join(state, "backups") };
}

export const supportedPlatform = () => ["darwin", "linux"].includes(process.platform);

export function readJson(file, fallback = null) {
  try { return JSON.parse(fs.readFileSync(file, "utf8")); } catch { return fallback; }
}

/** Write beside the target and rename over it, keeping an existing file's mode. */
export function writeAtomic(file, text) {
  let mode = 0o644;
  try { mode = fs.statSync(file).mode & 0o777; } catch {}
  const tmp = `${file}.tmp-${process.pid}`;
  try {
    fs.writeFileSync(tmp, text, { mode });
    fs.renameSync(tmp, file);
  } catch (e) { fs.rmSync(tmp, { force: true }); throw e; }
}

export const sha256 = (text) => crypto.createHash("sha256").update(text).digest("hex");
export const layoutFile = (P, name) => path.join(P.layouts, `${name}.json`);
export const validLayoutName = (name) => typeof name === "string" && /^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(name) && !name.endsWith(".json");

const isExec = (p) => { try { fs.accessSync(p, fs.constants.X_OK); return fs.statSync(p).isFile(); } catch { return false; } };
export function which(name) {
  for (const dir of (process.env.PATH || "").split(path.delimiter)) if (dir && isExec(path.join(dir, name))) return path.join(dir, name);
  return null;
}

/** herdr-app: HERDR_APP_BIN, else PATH, else the usual install locations. */
export function findHerdrApp() {
  if (process.env.HERDR_APP_BIN) return isExec(process.env.HERDR_APP_BIN) ? process.env.HERDR_APP_BIN : null;
  const cands = [which("herdr-app"), path.join(os.homedir(), ".local", "bin", "herdr-app")];
  if (process.platform === "darwin") cands.push("/Applications/Herdr.app/Contents/MacOS/Herdr", path.join(os.homedir(), "Applications", "Herdr.app", "Contents", "MacOS", "Herdr"));
  return cands.find((p) => p && isExec(p)) ?? null;
}

/** Run herdr-app; returns {ok, out}. Never throws. Only `check` and `status` are used: neither changes the window. */
export function herdr(bin, args, timeout = 60_000) {
  const r = spawnSync(bin, args, { encoding: "utf8", timeout });
  const out = `${r.stdout ?? ""}${r.stderr ?? ""}`.trim();
  return { ok: r.status === 0 && !/^\s*\{\s*"error"/.test(r.stdout ?? ""), out: out || String(r.error?.message ?? "") };
}

/** The layout the person has selected, from Herdr's own shared state (read only). */
export const selectedLayout = (P) => readJson(path.join(P.app, "shared.json"))?.layout ?? null;

/** Herdr's own layouts: replaced on every start, so never edited. */
export function isShippedLayout(P, name) {
  const installed = readJson(path.join(P.app, "installed.json"), {}) ?? {};
  if (Object.keys(installed).some((k) => k === `layout:${name}`)) return true;
  if (["main", "terminals", "win98"].includes(name)) return !readJson(layoutFile(P, name))?.cloned_from;
  return false;
}

/** A mod folder this package installed (its core.js carries the package mark). */
export function isOurMod(dir) {
  try { return fs.readFileSync(path.join(dir, "core.js"), "utf8").includes(MARK); } catch { return false; }
}

/** Every block with this id in a layout tree (floating blocks and stacks included). */
export function blocks(layout, id = BLOCK) {
  const out = [];
  (function walk(n) {
    if (!n || typeof n !== "object") return;
    if (n.id === id && n.type === "block") out.push(n);
    for (const c of n.children ?? []) walk(c);
    for (const f of n.floating ?? []) walk(f);
  })(layout);
  return out;
}

/** Does any block anywhere in this layout show the mod? */
export function references(layout, mod = MOD) {
  let found = false;
  (function walk(n) {
    if (!n || typeof n !== "object") return;
    if (n.content?.mod === mod) found = true;
    for (const c of n.children ?? []) walk(c);
    for (const f of n.floating ?? []) walk(f);
    if (n.pane?.header?.content?.mod === mod) found = true;
  })(layout);
  return found;
}

/** What patching this layout would do: {ok, change, reason}. Mutates nothing. */
export function planPatch(layout) {
  const bs = blocks(layout);
  if (!bs.length) return { ok: false, reason: `it has no "${BLOCK}" block` };
  for (const b of bs) {
    const m = b.content?.mod;
    if (m !== SHIPPED_MOD && m !== MOD) return { ok: false, reason: `its "${BLOCK}" block shows ${m ? `the mod "${m}"` : "something other than a mod"}` };
  }
  return { ok: true, change: bs.some((b) => b.content.mod !== MOD) };
}

/** Points the files block(s) at `to` where they show `from`. Returns how many changed. */
export function pointFiles(layout, from, to) {
  let n = 0;
  for (const b of blocks(layout)) if (b.content?.mod === from) { b.content.mod = to; n++; }
  return n;
}

export const layoutText = (layout) => JSON.stringify(layout, null, 2) + "\n";

/** Layout names in the layouts folder. */
export function layoutNames(P) {
  try { return fs.readdirSync(P.layouts).filter((f) => f.endsWith(".json")).map((f) => f.slice(0, -5)); } catch { return []; }
}
