// Detail dialog for subscription usage: every source, window, reset time and
// observation time, with a manual refresh. Opened by gun-usage-bar.
import { View, div, svg, image } from "gpui-kit";
import { h_flex, v_flex } from "gpui-base";
import { theme, props, closeOverlay, exec, readTextFile, shared, setShared, focused, panes } from "herdr";
import { NODE, USAGE_HOME, SOURCES, SHARED_KEY, now, ago, until, clock, windowState, fmtPct, barColor, isStale, statusText, methodText, newest, focusedContext } from "./fmt.js";
import { strings, windowName, groupName, sourceMessage } from "./i18n.js";

const L = strings();
// Column widths fit the longer of the English and Korean copy.
const LABEL_W = 140, VALUE_W = 172;

export default class GunUsageDetail extends View {
  init(_props, cx) {
    this.snap = null;
    this.busy = false;
    this.note = null;
    this.handle = cx.focus_handle();
    this.handle.focus();
    cx.spawn(async (cx) => {
      try {
        const text = await readTextFile(`${USAGE_HOME}/cache/snapshot.json`);
        if (text) this.snap = JSON.parse(text);
      } catch {}
      cx.notify();
    });
  }

  refresh(cx) {
    if (this.busy) return;
    this.busy = true;
    this.note = null;
    cx.notify();
    cx.spawn(async (cx) => {
      try {
        const r = await exec(NODE, [`${USAGE_HOME}/bin/herdr-usage`, "snapshot", "--refresh"], { timeout: 45_000 });
        const s = r.code === 0 ? JSON.parse(r.stdout) : null;
        if (s?.schema === 1 && !s.busy && s.sources) { this.snap = s; setShared(SHARED_KEY, s); }
        else this.note = L.refreshFailed;
      } catch { this.note = L.refreshFailed; }
      this.busy = false;
      cx.notify();
    });
  }

  icon(src, t, size = 16) {
    return src.tint ? svg(src.icon).size(size).flex_none().text_color(t.foreground) : image(src.icon).w(size).h(size).flex_none();
  }

  pill(text, fg, bg) {
    return div().px(7).h(18).flex_none().rounded(9).bg(bg).text_color(fg).text_size(10.5).flex().items_center().child(text);
  }

  windowRow(src, w, t, n, stale) {
    const st = windowState(w, n);
    const color = st.kind === "ok" ? barColor(t, st.used) : t.dim;
    const reset = w.resets_at
      ? st.kind === "expired" ? L.resetPassed(clock(w.resets_at)) : L.resetAt(clock(w.resets_at), until(w.resets_at, n))
      : L.noReset;
    const extra = w.balance_usd != null ? L.balance(w.balance_usd.toFixed(2), w.allowance_usd != null ? w.allowance_usd.toFixed(2) : null) : "";
    return v_flex().gap(4).child(
      h_flex().gap(10).items_center()
        .child(div().w(LABEL_W).flex_none().text_color(t.muted).truncate().child(windowName(src.id, w)))
        .child(div().flex_1().h(6).rounded(3).bg(t.raised).overflow_hidden()
          // Filled part = remaining, matching the remaining-first copy.
          .when(st.kind === "ok", (el) => el.child(div().h_full().w(`${Math.max(1, Math.min(100, st.remaining))}%`).rounded(3).bg(stale ? t.dim : color))))
        .child(div().w(VALUE_W).flex_none().text_color(st.kind === "ok" && !stale ? t.foreground : t.dim).child(st.text)),
    ).child(div().pl(LABEL_W + 10).text_size(11).text_color(t.dim).child(reset + extra + (w.disabled ? L.disabled : "")));
  }

  sourceCard(src, s, t, n, snap) {
    const status = s?.status ?? "unavailable";
    const groups = s?.groups ?? [];
    const stale = groups.length > 0 && isStale(s.observed_at, s.stale_after_s, n);
    const pill = stale
      ? this.pill(L.stale, t.foreground, t.raised)
      : this.pill(statusText(status), status === "ok" ? t.accent_foreground : t.foreground, status === "ok" ? t.accent : status === "error" ? t.blocked : t.raised);
    const observedLabel = L.observed[s?.method === "statusline" || s?.method === "rollout" ? s.method : "other"];
    const meta = [];
    if (s?.observed_at) meta.push(`${observedLabel} ${clock(s.observed_at)} (${ago(s.observed_at, n)})`);
    if (s?.fetched_at && s.method !== "statusline") meta.push(L.lastTry(clock(s.fetched_at, false)));
    if (s?.last_error) meta.push(L.error(s.last_error));

    const body = [];
    if (!groups.length) body.push(div().text_color(t.dim).child(sourceMessage(src.id, s) ?? L.srcWaiting(src.name)));
    for (const g of groups) {
      const head = [groups.length > 1 ? groupName(g) : null, g.plan ? L.plan(g.plan) : null, g.sessions ? L.sessions(g.sessions) : null].filter(Boolean).join(" · ");
      if (head) body.push(div().text_size(11).text_color(t.dim).child(head));
      if (!g.windows.length) body.push(div().text_color(t.dim).child(L.noWindows));
      for (const w of g.windows) body.push(this.windowRow(src, w, t, n, stale));
      if (g.spend) body.push(div().text_size(11).text_color(t.dim).child(L.spend(g.spend.used_percent != null ? fmtPct(g.spend.used_percent) : null, g.spend.resets_at ? clock(g.spend.resets_at) : null)));
      if (g.credits) body.push(div().text_size(11).text_color(t.dim).child(L.credits(g.credits)));
      if (g.balance_usd != null) body.push(div().text_size(11).text_color(t.dim).child(L.purchased(g.balance_usd.toFixed(2))));
    }
    if (src.id === "ollama") {
      const l = snap?.local?.ollama;
      const txt = !l ? L.localUnknown : l.daemon === "running" ? L.localRunning(l.models ?? []) : L.localStopped;
      body.push(div().text_size(11).text_color(t.dim).child(txt));
    }

    return v_flex().gap(8).p(12).rounded(8).border_1().border_color(t.border).bg(t.surface)
      .child(h_flex().gap(8).items_center()
        .child(this.icon(src, t))
        .child(div().text_size(13.5).font_semibold().text_color(t.foreground).child(src.name))
        .child(pill)
        .child(div().flex_1())
        .child(div().text_size(11).text_color(t.dim).child(methodText(s?.method))))
      .children(body)
      .when(meta.length > 0, (el) => el.child(div().text_size(11).text_color(t.dim).child(meta.join(" · "))));
  }

  render(cx) {
    const t = theme();
    const n = now();
    const snap = newest(this.snap, shared(SHARED_KEY));
    const ctx = focusedContext(snap, focused(), panes());
    const button = h_flex().id("refresh").h(28).px(12).items_center().rounded(7).border_1().border_color(t.input).bg(t.raised)
      .text_color(this.busy ? t.dim : t.foreground).cursor_pointer().hover((s) => s.bg(t.hover)).on_click((_e, cx) => this.refresh(cx))
      .child(this.busy ? L.refreshing : L.refresh);
    const close = h_flex().id("close").h(28).px(10).items_center().rounded(7).text_color(t.dim).cursor_pointer().hover((s) => s.bg(t.hover))
      .on_click(() => closeOverlay(props().overlay)).child(L.close);

    const ctxCard = v_flex().gap(6).p(12).rounded(8).border_1().border_color(t.border).bg(t.surface)
      .child(div().text_size(13).font_semibold().text_color(t.foreground).child(L.ctxTitle))
      .child(ctx
        ? v_flex().gap(4)
          .child(h_flex().gap(10).items_center()
            .child(this.icon(ctx, t, 14))
            .child(div().flex_1().h(6).rounded(3).bg(t.raised).overflow_hidden().child(div().h_full().w(`${Math.max(1, Math.min(100, ctx.used_percent))}%`).rounded(3).bg(barColor(t, ctx.used_percent))))
            .child(div().w(VALUE_W).flex_none().text_color(t.foreground).child(L.ctxUsed(fmtPct(ctx.used_percent)))))
          .child(div().text_size(11).text_color(t.dim).child([ctx.name, ctx.model, ctx.window_tokens ? L.tokens(Math.round(ctx.window_tokens / 1000)) : null, ctx.cwd_name, L.received(ago(ctx.observed_at, n))].filter(Boolean).join(" · ")))
        : div().text_color(t.dim).child(L.ctxNone));

    return v_flex().id("gun-usage-detail").track_focus(this.handle)
      .on_key_down((e, cx) => {
        if (e.key === "escape") closeOverlay(props().overlay);
        else if (e.key === "r") this.refresh(cx);
        else return;
        cx.stop_propagation();
      })
      .size_full().min_h(0).p(18).gap(12).bg(t.popover).text_size(12.5).text_color(t.foreground)
      .child(h_flex().gap(10).items_center()
        .child(v_flex().flex_1().gap(2)
          .child(div().text_size(16).font_semibold().child(L.title))
          .child(div().text_size(11).text_color(t.dim).child(snap ? L.updated(clock(snap.generated_at), ago(snap.generated_at, n), Math.round((snap.poll_s ?? 300) / 60)) : L.notCollected)))
        .when(Boolean(this.note), (el) => el.child(div().text_size(11).text_color(t.blocked).child(this.note)))
        .child(button).child(close))
      .child(v_flex().id("scroll").flex_1().min_h(0).gap(10).overflow_y_scrollbar()
        .children(SOURCES.map((src) => this.sourceCard(src, snap?.sources?.[src.id], t, n, snap)))
        .child(ctxCard)
        .child(div().text_size(10.5).text_color(t.dim).child(L.footer)));
  }
}
