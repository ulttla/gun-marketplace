// Merge per-session statusline captures into account groups, conservatively:
// per window, the newest reset wins; captures of the same window (reset within
// SAME_WINDOW_S) take the max used percent, so an idle older session can never
// pull a newer account value backwards.
import { agyWindow } from "./capture.mjs";

const SAME_WINDOW_S = 300;

/** Labels come from the window id at read time, so cached captures follow label fixes. */
function relabel(source, w) {
  if (source !== "agy") return w;
  const { label, dur } = agyWindow(w.id);
  return { ...w, label, duration_min: dur };
}

export function mergeWindows(entries) {
  // entries: [{ w: window, observed_at }]
  const byId = new Map();
  for (const e of entries) {
    if (!byId.has(e.w.id)) byId.set(e.w.id, []);
    byId.get(e.w.id).push(e);
  }
  const out = [];
  for (const list of byId.values()) {
    const withReset = list.filter((e) => e.w.resets_at != null);
    let pool;
    if (withReset.length) {
      const top = Math.max(...withReset.map((e) => e.w.resets_at));
      pool = withReset.filter((e) => top - e.w.resets_at <= SAME_WINDOW_S);
    } else {
      // No reset time anywhere: take the most recently observed only.
      const top = Math.max(...list.map((e) => e.observed_at ?? 0));
      pool = list.filter((e) => (e.observed_at ?? 0) === top);
    }
    const known = pool.filter((e) => e.w.used_percent != null);
    const best = known.length ? known.reduce((a, b) => (b.w.used_percent > a.w.used_percent ? b : a)) : pool[0];
    const observed = Math.max(...pool.map((e) => e.observed_at ?? 0)) || null;
    out.push({ ...best.w, resets_at: Math.max(...pool.map((e) => e.w.resets_at ?? 0)) || null, observed_at: observed });
  }
  return out.sort((a, b) => (a.duration_min ?? 1e9) - (b.duration_min ?? 1e9) || a.id.localeCompare(b.id));
}

/** captures -> groups[] for the snapshot. */
export function groupsFromCaptures(captures) {
  const byAcct = new Map();
  for (const c of captures) {
    if (!c.quota) continue;
    if (!byAcct.has(c.account)) byAcct.set(c.account, []);
    byAcct.get(c.account).push(c);
  }
  const groups = [];
  for (const [key, list] of byAcct) {
    const entries = [];
    for (const c of list) for (const w of c.quota.windows ?? []) entries.push({ w: relabel(c.source, w), observed_at: c.quota_observed_at });
    const windows = mergeWindows(entries);
    const spends = list.filter((c) => c.quota.spend).sort((a, b) => (b.quota_observed_at ?? 0) - (a.quota_observed_at ?? 0));
    const plans = list.map((c) => c.quota.plan).filter(Boolean);
    groups.push({
      key,
      label: list[0].account_label ?? "기본",
      plan: plans[0] ?? null,
      observed_at: Math.max(...list.map((c) => c.quota_observed_at ?? 0)) || null,
      windows,
      credits: null,
      balance_usd: null,
      spend: spends[0]?.quota.spend ?? null,
      sessions: list.length,
    });
  }
  return groups;
}

/** Recent contexts with a terminal id (the mod filters by focus and live terminals). */
export function contextsFromCaptures(src, captures, now, maxAgeS = 6 * 3600) {
  const best = new Map();
  for (const c of captures) {
    if (!c.context || !c.terminal || now - (c.context_observed_at ?? 0) > maxAgeS) continue;
    const prev = best.get(c.terminal);
    if (!prev || (c.context_observed_at ?? 0) > (prev.context_observed_at ?? 0)) best.set(c.terminal, c);
  }
  return [...best.values()].map((c) => ({
    terminal: c.terminal,
    source: src,
    model: c.context.model,
    used_percent: c.context.used_percent,
    window_tokens: c.context.window_tokens,
    observed_at: c.context_observed_at,
    cwd_name: c.cwd_name,
  }));
}
