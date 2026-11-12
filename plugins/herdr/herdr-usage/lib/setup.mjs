// Shared by install.mjs, uninstall.mjs and status.mjs: where things live, how
// to find herdr-app, and how to tell this package's files from someone else's.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { appHomeDir, usageHome, readJson } from "./util.mjs";

export const VERSION = "0.1.1";
export const MIN_NODE = 22;
export const MODS = ["gun-usage-bar", "gun-usage-detail"];
export const LAYOUT = "gun-usage";
export const BAR = "gun-usage-bar";
const SHARED_MARK = 'SHARED_KEY = "gun-usage.snapshot"';

export function paths() {
  const app = appHomeDir();
  const usage = usageHome();
  return { app, usage, mods: path.join(app, "mods"), layouts: path.join(app, "layouts"), layout: path.join(app, "layouts", `${LAYOUT}.json`), info: path.join(usage, "install.json") };
}

export function supportedPlatform() {
  return ["darwin", "linux", "win32"].includes(process.platform);
}

const isExec = (p) => { try { fs.accessSync(p, fs.constants.X_OK); return fs.statSync(p).isFile(); } catch { return false; } };

/** First executable named `name` on PATH, or null. */
export function which(name) {
  for (const dir of (process.env.PATH || "").split(path.delimiter)) {
    const names = process.platform === "win32" ? [/\.exe$/i.test(name) ? name : `${name}.exe`] : [name];
    for (const n of names) if (dir && isExec(path.join(dir, n))) return path.join(dir, n);
  }
  return null;
}

/** Prefer the native Windows executable: .cmd/.ps1 launchers need a shell. */
export function findCodex() {
  if (process.env.HERDR_USAGE_CODEX) return process.env.HERDR_USAGE_CODEX;
  const onPath = which("codex");
  if (onPath || process.platform !== "win32") return onPath;
  const npm = path.join(process.env.APPDATA || path.join(os.homedir(), "AppData", "Roaming"), "npm", "node_modules", "@openai", "codex");
  const arch = process.arch === "arm64" ? "aarch64" : "x86_64";
  return [
    path.join(os.homedir(), ".local", "bin", "codex.exe"),
    path.join(npm, "node_modules", "@openai", `codex-win32-${process.arch}`, "vendor", `${arch}-pc-windows-msvc`, "bin", "codex.exe"),
    path.join(npm, "vendor", `${arch}-pc-windows-msvc`, "bin", "codex.exe"),
  ].find(isExec) ?? null;
}

/** The Node.js to bake into the wrapper and mods: HERDR_USAGE_NODE, else a launcher
 *  on PATH (or a usual bin folder) that resolves to this very node, so a Homebrew
 *  upgrade that removes the versioned Cellar path does not break it; else this node. */
export function stableNode() {
  if (process.env.HERDR_USAGE_NODE) return process.env.HERDR_USAGE_NODE;
  const real = (p) => { try { return fs.realpathSync(p); } catch { return null; } };
  const self = real(process.execPath);
  const cands = [which("node"), "/opt/homebrew/bin/node", "/usr/local/bin/node", "/usr/bin/node"];
  return cands.find((p) => p && isExec(p) && real(p) === self) ?? process.execPath;
}

/** herdr-app: HERDR_APP_BIN, else PATH, else the usual install locations. */
export function findHerdrApp() {
  if (process.env.HERDR_APP_BIN) return isExec(process.env.HERDR_APP_BIN) ? process.env.HERDR_APP_BIN : null;
  const cands = [which("herdr-app"), path.join(os.homedir(), ".local", "bin", "herdr-app")];
  if (process.platform === "darwin") cands.push("/Applications/Herdr.app/Contents/MacOS/Herdr", path.join(os.homedir(), "Applications", "Herdr.app", "Contents", "MacOS", "Herdr"));
  return cands.find((p) => p && isExec(p)) ?? null;
}

/** Run herdr-app; returns {ok, out}. Never throws. */
export function herdr(bin, args, timeout = 30_000) {
  const r = spawnSync(bin, args, { encoding: "utf8", timeout, windowsHide: true });
  const out = `${r.stdout ?? ""}${r.stderr ?? ""}`.trim();
  return { ok: r.status === 0 && !/^\s*\{\s*"error"/.test(r.stdout ?? ""), out: out || String(r.error?.message ?? "") };
}

/** The shown layout's name, or null when no window answers. */
export function shownLayout(bin) {
  const r = herdr(bin, ["status"], 10_000);
  if (!r.ok) return null;
  try { return JSON.parse(r.out).layout ?? null; } catch { return null; }
}

/** Major version of a node binary, or null. */
export function nodeMajor(bin) {
  const r = spawnSync(bin, ["-p", "process.versions.node"], { encoding: "utf8", timeout: 10_000, windowsHide: true });
  const m = r.status === 0 && String(r.stdout).trim().match(/^(\d+)\./);
  return m ? Number(m[1]) : null;
}

/** A mod folder this package installed (the shared fmt.js carries its key). */
export function isOurMod(dir) {
  try { return fs.readFileSync(path.join(dir, "fmt.js"), "utf8").includes(SHARED_MARK); } catch { return false; }
}

/** A usage home this package created, or one that is missing or empty.
 *  Recognized by content: its install.json, or the collector and wrapper this
 *  package ships (installs made before install.json existed have only those). */
export function isOurUsageHome(dir) {
  let names;
  try { names = fs.readdirSync(dir); } catch (e) { return e.code === "ENOENT"; }
  if (!names.filter((n) => n !== ".DS_Store").length) return true;
  if (readJson(path.join(dir, "install.json"))?.package === "herdr-usage") return true;
  const has = (rel, text) => { try { return fs.readFileSync(path.join(dir, rel), "utf8").includes(text); } catch { return false; } };
  return has("bin/herdr-usage", "usage: herdr-usage snapshot [--due|--refresh|--cached] | capture <claude|agy>")
    && has("bin/statusline-wrap", '"$home/bin/herdr-usage" capture "$src"');
}

/** Points a layout's status block at the bar. Returns true when one was found. */
export function pointStatusAtBar(layout) {
  let found = false;
  (function walk(n) {
    if (!n || typeof n !== "object") return;
    if (n.id === "status" && n.content?.mod) { n.content.mod = BAR; found = true; }
    for (const c of n.children ?? []) walk(c);
  })(layout);
  return found;
}

/** A layout file this package wrote (its status block shows the bar). */
export function isOurLayout(file) {
  const lay = readJson(file);
  if (!lay) return false;
  let ours = false;
  (function walk(n) {
    if (!n || typeof n !== "object") return;
    if (n.id === "status" && n.content?.mod === BAR) ours = true;
    for (const c of n.children ?? []) walk(c);
  })(lay);
  return ours;
}
