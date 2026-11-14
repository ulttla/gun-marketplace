// Codex: live read through a short-lived `codex app-server` (stdio JSON-RPC,
// account/rateLimits/read), falling back to the newest rate_limits event in
// recent rollout files. accountId and upsell fields are never kept.
import { spawn } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { windowOf, nowS, toEpochS, errText, installInfo } from "../util.mjs";
import { msg } from "../messages.mjs";

function codexBin() {
  if (process.env.HERDR_USAGE_CODEX) return process.env.HERDR_USAGE_CODEX;
  const rec = installInfo().codex; // found on PATH at install time
  if (typeof rec === "string" && rec && fs.existsSync(rec)) return rec;
  for (const p of ["/opt/homebrew/bin/codex", "/usr/local/bin/codex"]) if (fs.existsSync(p)) return p;
  return "codex";
}

function credits(c) {
  if (!c || typeof c !== "object") return null;
  return { has_credits: Boolean(c.hasCredits ?? c.has_credits), unlimited: Boolean(c.unlimited), balance: c.balance != null ? String(c.balance).slice(0, 20) : null };
}

/** app-server RateLimitSnapshot -> group. */
export function groupFromAppSnapshot(s, observed) {
  const windows = [];
  for (const [slot, w] of [["primary", s?.primary], ["secondary", s?.secondary]]) {
    if (!w || typeof w !== "object") continue; // null = no such window, not 0%
    const dur = w.windowDurationMins ?? null;
    windows.push(windowOf({ id: dur ? `w${dur}` : slot, duration_min: dur, used: w.usedPercent, resets_at: w.resetsAt }));
  }
  return {
    key: `codex-${String(s?.limitId ?? "codex").replace(/[^A-Za-z0-9._-]/g, "").slice(0, 40)}`,
    label: s?.limitName || s?.limitId || "Codex",
    plan: s?.planType ?? null,
    observed_at: observed,
    windows,
    credits: credits(s?.credits),
    balance_usd: null,
    reached: s?.rateLimitReachedType ?? null,
  };
}

export function parseAppServerResult(result, observed) {
  const by = result?.rateLimitsByLimitId;
  const snaps = by && typeof by === "object" && Object.keys(by).length ? Object.values(by) : result?.rateLimits ? [result.rateLimits] : [];
  return snaps.filter(Boolean).map((s) => groupFromAppSnapshot(s, observed));
}

/** Rollout `rate_limits` event line -> group (observed_at = the event's own timestamp). */
export function groupFromRolloutLine(line) {
  const ev = JSON.parse(line);
  const rl = ev?.payload?.rate_limits;
  if (!rl) return null;
  const observed = toEpochS(ev.timestamp);
  const windows = [];
  for (const [slot, w] of [["primary", rl.primary], ["secondary", rl.secondary]]) {
    if (!w || typeof w !== "object") continue;
    const dur = w.window_minutes ?? null;
    windows.push(windowOf({ id: dur ? `w${dur}` : slot, duration_min: dur, used: w.used_percent, resets_at: w.resets_at }));
  }
  return {
    key: `codex-${String(rl.limit_id ?? "codex").replace(/[^A-Za-z0-9._-]/g, "").slice(0, 40)}`,
    label: rl.limit_name || rl.limit_id || "Codex",
    plan: rl.plan_type ?? null,
    observed_at: observed,
    windows,
    credits: credits(rl.credits),
    balance_usd: null,
    reached: rl.rate_limit_reached_type ?? null,
  };
}

/** One bounded app-server exchange. The child runs in its own process group and is always killed. */
export function readAppServer(timeoutMs = 15000) {
  return new Promise((resolve, reject) => {
    const child = spawn(codexBin(), ["app-server"], { stdio: ["pipe", "pipe", "ignore"], detached: process.platform !== "win32", windowsHide: true });
    let buf = "";
    let done = false;
    const finish = (err, val) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      try { child.stdin.end(); } catch {}
      if (process.platform === "win32") {
        if (child.pid) {
          const killer = spawn("taskkill.exe", ["/PID", String(child.pid), "/T", "/F"], { stdio: "ignore", windowsHide: true });
          killer.on("error", () => { try { child.kill(); } catch {} });
        }
      } else {
        try { process.kill(-child.pid, "SIGTERM"); } catch {}
        setTimeout(() => { try { process.kill(-child.pid, "SIGKILL"); } catch {} }, 1500).unref();
      }
      err ? reject(err) : resolve(val);
    };
    const timer = setTimeout(() => finish(new Error("timeout")), timeoutMs);
    const send = (m) => child.stdin.write(JSON.stringify(m) + "\n");
    child.on("error", (e) => finish(e));
    child.on("exit", (code) => finish(new Error(`exit ${code}`)));
    child.stdin.on("error", () => {});
    child.stdout.on("data", (d) => {
      buf += d;
      let i;
      while ((i = buf.indexOf("\n")) >= 0) {
        const line = buf.slice(0, i).trim();
        buf = buf.slice(i + 1);
        if (!line) continue;
        let m;
        try { m = JSON.parse(line); } catch { continue; }
        if (m.id === 1) {
          if (m.error) return finish(new Error(`initialize: ${m.error.code ?? "error"}`));
          send({ jsonrpc: "2.0", method: "initialized" });
          send({ jsonrpc: "2.0", id: 2, method: "account/rateLimits/read", params: { excludeResetCreditDetails: true } });
        } else if (m.id === 2) {
          if (m.error) return finish(new Error(`rateLimits: ${m.error.code ?? "error"}`));
          return finish(null, m.result);
        }
      }
    });
    send({ jsonrpc: "2.0", id: 1, method: "initialize", params: { clientInfo: { name: "herdr-usage", version: "1.0.0" } } });
  });
}

function recentRollouts() {
  const root = path.join(process.env.CODEX_HOME || installInfo().codex_home || path.join(os.homedir(), ".codex"), "sessions");
  const files = [];
  for (let d = 0; d < 3; d++) {
    const t = new Date(Date.now() - d * 86400000);
    for (const dt of [[t.getFullYear(), t.getMonth() + 1, t.getDate()], [t.getUTCFullYear(), t.getUTCMonth() + 1, t.getUTCDate()]]) {
      const dir = path.join(root, String(dt[0]), String(dt[1]).padStart(2, "0"), String(dt[2]).padStart(2, "0"));
      try {
        for (const n of fs.readdirSync(dir)) if (n.startsWith("rollout-") && n.endsWith(".jsonl")) files.push(path.join(dir, n));
      } catch {}
    }
  }
  return [...new Set(files)]
    .map((f) => { try { return { f, m: fs.statSync(f).mtimeMs }; } catch { return null; } })
    .filter(Boolean)
    .sort((a, b) => b.m - a.m)
    .slice(0, 12)
    .map((x) => x.f);
}

function tailLines(file, bytes = 262144) {
  const fd = fs.openSync(file, "r");
  try {
    const size = fs.fstatSync(fd).size;
    const len = Math.min(size, bytes);
    const b = Buffer.alloc(len);
    fs.readSync(fd, b, 0, len, size - len);
    return b.toString("utf8").split("\n");
  } finally { fs.closeSync(fd); }
}

/** Newest rate_limits event across recent rollouts, chosen by event timestamp. */
export function readRollouts() {
  let best = null;
  for (const f of recentRollouts()) {
    let lines;
    try { lines = tailLines(f); } catch { continue; }
    for (let i = lines.length - 1; i >= 0; i--) {
      if (!lines[i].includes('"rate_limits"')) continue;
      let g = null;
      try { g = groupFromRolloutLine(lines[i]); } catch {}
      if (!g || !g.windows.length) continue; // null/partial line: keep scanning this file
      if (!best || (g.observed_at ?? 0) > (best.observed_at ?? 0)) best = g;
      break;
    }
  }
  return best ? [best] : [];
}

export async function collectCodex() {
  try {
    const result = await readAppServer();
    const groups = parseAppServerResult(result, nowS());
    if (groups.length) return { status: "ok", method: "app-server", groups, ...msg(["live"]), last_error: null };
    throw new Error("empty");
  } catch (e) {
    const groups = readRollouts();
    if (groups.length) return { status: "ok", method: "rollout", groups, ...msg(["codex_rollout"]), last_error: `app-server: ${errText(e)}` };
    return { status: "error", method: "app-server", groups: [], ...msg(["codex_failed"]), last_error: errText(e) };
  }
}
