// Shared helpers: paths, atomic writes, a mkdir lock, small parsers.
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import crypto from "node:crypto";

export const appHomeDir = () => process.env.HERDR_APP_HOME || path.join(os.homedir(), ".config", "herdr-app");
export function usageHome() {
  return process.env.HERDR_USAGE_HOME || path.join(appHomeDir(), "usage");
}
export const installInfoPath = () => path.join(usageHome(), "install.json");
/** What the installer recorded (settings files, node, codex), or {}. */
export const installInfo = () => readJson(installInfoPath(), {}) ?? {};
export const cacheDir = () => path.join(usageHome(), "cache");
export const stateDir = () => path.join(usageHome(), "state");
export const capturesDir = () => path.join(cacheDir(), "captures");
export const snapshotPath = () => path.join(cacheDir(), "snapshot.json");
export const collectorStatePath = () => path.join(stateDir(), "collector.json");

export function ensureDir(dir) {
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  try { fs.chmodSync(dir, 0o700); } catch {}
}

/** Write via temp file + rename in the same directory, mode 0600 unless given. */
export function writeAtomic(file, text, mode = 0o600) {
  ensureDir(path.dirname(file));
  const tmp = `${file}.tmp-${process.pid}-${crypto.randomBytes(4).toString("hex")}`;
  fs.writeFileSync(tmp, text, { mode });
  fs.chmodSync(tmp, mode);
  fs.renameSync(tmp, file);
}

export function readJson(file, fallback = null) {
  try { return JSON.parse(fs.readFileSync(file, "utf8")); } catch { return fallback; }
}

export const hash = (s, n = 16) => crypto.createHash("sha256").update(String(s)).digest("hex").slice(0, n);

export const nowS = () => Math.floor(Date.now() / 1000);
export const iso = (sec) => (sec == null ? null : new Date(sec * 1000).toISOString());

/** Accepts epoch seconds, epoch ms, ISO strings or {seconds} (protobuf Timestamp). Returns epoch seconds or null. */
export function toEpochS(v) {
  if (v == null || v === "") return null;
  if (typeof v === "object" && v.seconds != null) return toEpochS(Number(v.seconds));
  if (typeof v === "number" || (typeof v === "string" && /^\d+(\.\d+)?$/.test(v))) {
    const n = Number(v);
    if (!Number.isFinite(n) || n <= 0) return null;
    return Math.floor(n > 1e11 ? n / 1000 : n); // ms vs s
  }
  const t = Date.parse(v);
  return Number.isFinite(t) ? Math.floor(t / 1000) : null;
}

/** A finite number clamped to 0..100, else null (missing is unknown, never 0 or 100). */
export function pct(v) {
  if (v == null || v === "") return null;
  const n = Number(v);
  if (!Number.isFinite(n)) return null;
  return Math.round(Math.min(100, Math.max(0, n)) * 10) / 10;
}

/** Build a window from exactly one measured field; the other side is derived from it. */
export function windowOf({ id, label, duration_min = null, used = null, remaining = null, resets_at = null }) {
  let u = pct(used), r = pct(remaining);
  if (u != null) r = Math.round((100 - u) * 10) / 10;
  else if (r != null) u = Math.round((100 - r) * 10) / 10;
  return { id, label: label ?? windowLabel(id, duration_min), duration_min, used_percent: u, remaining_percent: r, resets_at: resets_at == null ? null : toEpochS(resets_at) };
}

/** Korean label from a duration in minutes, or from an id that names one. Otherwise the id itself. */
export function windowLabel(id, duration_min) {
  const m = duration_min;
  if (m === 300) return "5시간";
  if (m === 10080) return "주간";
  if (m === 1440) return "일간";
  if (m != null && m % 1440 === 0) return `${m / 1440}일`;
  if (m != null && m % 60 === 0) return `${m / 60}시간`;
  if (m != null) return `${m}분`;
  const s = String(id ?? "").toLowerCase();
  if (/five_hour|5h/.test(s)) return "5시간";
  if (/seven_day|weekly|week/.test(s)) return "주간";
  if (/daily|day/.test(s)) return "일간";
  if (/monthly|month/.test(s)) return "월간";
  if (s === "session") return "세션";
  return String(id ?? "?");
}

/** Run fn while holding a mkdir lock. Returns null (without running) if another live run holds it. */
export async function withLock(name, staleMs, fn) {
  ensureDir(stateDir());
  const dir = path.join(stateDir(), `${name}.lock`);
  try {
    fs.mkdirSync(dir);
  } catch {
    let age = Infinity;
    try { age = Date.now() - fs.statSync(dir).mtimeMs; } catch {}
    if (age < staleMs) return null;
    try { fs.rmSync(dir, { recursive: true, force: true }); fs.mkdirSync(dir); } catch { return null; }
  }
  try { return await fn(); } finally { try { fs.rmSync(dir, { recursive: true, force: true }); } catch {} }
}

export function readStdin(limit = 4 * 1024 * 1024) {
  const chunks = [];
  let n = 0;
  const buf = Buffer.alloc(65536);
  for (;;) {
    let r = 0;
    try { r = fs.readSync(0, buf, 0, buf.length, null); } catch (e) { if (e.code === "EAGAIN") continue; if (e.code === "EOF") break; throw e; }
    if (r <= 0) break;
    n += r;
    if (n <= limit) chunks.push(Buffer.from(buf.subarray(0, r)));
  }
  return Buffer.concat(chunks).toString("utf8");
}

/** Short, safe error text: never bodies, headers or paths. */
export function errText(e) {
  const m = String(e?.code || e?.message || e || "error");
  return m.replace(/\/(Users|home)\/[^\s]+/g, "<path>").slice(0, 120);
}
