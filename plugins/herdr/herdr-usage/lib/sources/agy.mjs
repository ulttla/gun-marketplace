// Account quota metadata only: no terminal session and no model inference.
import { execFile } from "node:child_process";
import os from "node:os";
import { findAgy } from "../setup.mjs";
import { agyWindow } from "../capture.mjs";
import { nowS, windowOf, installInfo } from "../util.mjs";
import { msg } from "../messages.mjs";

export function parseAgyQuota(payload, observed = nowS()) {
  // Supported read-only print command. Reject an agent response, cached session,
  // or any unexpected execution rather than presenting it as a quota read.
  if (payload?.status !== "SUCCESS" || payload?.command?.name !== "usage" ||
      payload?.num_turns !== 0 || payload?.conversation_id ||
      Object.values(payload?.usage ?? {}).some((n) => typeof n !== "number" || n !== 0)) return [];
  const windows = [];
  const groups = payload.command.data?.groups;
  for (const b of (Array.isArray(groups) ? groups : []).flatMap((g) => Array.isArray(g?.buckets) ? g.buckets : [])) {
    if (!b || typeof b.id !== "string" || !/^[A-Za-z0-9._-]{1,64}$/.test(b.id)) continue;
    const frac = b.remaining_fraction;
    if (frac != null && (typeof frac !== "number" || !Number.isFinite(frac) || frac < 0 || frac > 1)) continue;
    const { label, dur } = agyWindow(b.id);
    const w = windowOf({ id: b.id, label, duration_min: dur,
      remaining: frac == null ? null : frac * 100, resets_at: b.reset_time });
    w.observed_at = observed;
    if (typeof b.remaining_amount === "number" && Number.isFinite(b.remaining_amount)) w.remaining_amount = b.remaining_amount;
    if (b.disabled === true) w.disabled = true;
    windows.push(w);
  }
  return windows.length ? [{ key: "agy-default", label: "기본", label_key: "default", plan: null,
    observed_at: observed, windows, credits: null, balance_usd: null, spend: null }] : [];
}

function readQuota() {
  return new Promise((resolve, reject) => {
    const recorded = installInfo().agy;
    const agy = process.env.HERDR_USAGE_AGY || (typeof recorded === "string" && recorded) ||
      findAgy();
    if (!agy) return reject(new Error("quota_command_failed"));
    // Installed 1.5.7 documents /usage as a read-only print command: force-loads
    // current quota, zero agent turns/tokens and no conversation. The CLI owns
    // credential refresh. Never substitute a natural-language prompt here.
    execFile(agy, ["-p", "/usage", "--output-format", "json"],
      { cwd: os.homedir(), windowsHide: true, timeout: 35_000, maxBuffer: 256 * 1024 },
      (error, stdout) => {
        if (error) return reject(new Error("quota_command_failed"));
        try { resolve(JSON.parse(stdout)); } catch { reject(new Error("quota_command_invalid")); }
      });
  });
}

export async function collectAgy({ read = readQuota, now = nowS } = {}) {
  const base = { method: "quota-api", groups: [], last_error: null };
  try {
    const payload = await read();
    const observed = now();
    if (payload.error) {
      const connect = ["login_required", "http_401", "http_403"].includes(payload.error);
      return { ...base, status: connect ? "connect_needed" : "error",
        ...msg([connect ? "agy_login" : "agy_failed"]),
        last_error: /^[a-z0-9_]{1,40}$/.test(payload.error) ? payload.error : "quota_unavailable",
        retry_until: payload.error === "http_429" ? observed + (payload.retry_seconds || 300) : null };
    }
    const groups = parseAgyQuota(payload, observed);
    if (!groups.length) return { ...base, status: "unavailable", ...msg(["agy_no_quota"]) };
    return { ...base, groups, status: "ok", ...msg(["agy_live"]) };
  } catch {
    return { ...base, status: "error", ...msg(["agy_failed"]), last_error: "quota_command_failed" };
  }
}
