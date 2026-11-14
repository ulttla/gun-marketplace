// Detail dialog for subscription usage: every source, window, reset time and
// observation time, with a manual refresh. Opened by gun-usage-bar.
import { View, div, svg, image } from "gpui-kit";
import { h_flex, v_flex } from "gpui-base";
import { theme, props, closeOverlay, exec, readTextFile, shared, setShared, focused, panes } from "herdr";
import { NODE, USAGE_HOME, SOURCES, SHARED_KEY, now, ago, until, clock, windowState, fmtPct, barColor, isStale, STATUS_KO, methodKo, newest, focusedContext } from "./fmt.js";

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
        else this.note = "새로고침 실패";
      } catch { this.note = "새로고침 실패"; }
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

  windowRow(w, t, n, stale) {
    const st = windowState(w, n);
    const color = st.kind === "ok" ? barColor(t, st.used) : t.dim;
    const reset = w.resets_at
      ? st.kind === "expired" ? `리셋 ${clock(w.resets_at)} 지남` : `리셋 ${clock(w.resets_at)} · ${until(w.resets_at, n)}`
      : "리셋 시간 정보 없음";
    const extra = w.balance_usd != null ? ` · 잔액 $${w.balance_usd.toFixed(2)}${w.allowance_usd != null ? ` / $${w.allowance_usd.toFixed(2)}` : ""}` : "";
    return v_flex().gap(4).child(
      h_flex().gap(10).items_center()
        .child(div().w(118).flex_none().text_color(t.muted).truncate().child(w.label ?? w.id))
        .child(div().flex_1().h(6).rounded(3).bg(t.raised).overflow_hidden()
          // Filled part = remaining, matching the remaining-first copy.
          .when(st.kind === "ok", (el) => el.child(div().h_full().w(`${Math.max(1, Math.min(100, st.remaining))}%`).rounded(3).bg(stale ? t.dim : color))))
        .child(div().w(150).flex_none().text_color(st.kind === "ok" && !stale ? t.foreground : t.dim).child(st.text)),
    ).child(div().pl(128).text_size(11).text_color(t.dim).child(reset + extra + (w.disabled ? " · 비활성" : "")));
  }

  sourceCard(src, s, t, n, snap) {
    const status = s?.status ?? "unavailable";
    const groups = s?.groups ?? [];
    const stale = groups.length > 0 && isStale(s.observed_at, s.stale_after_s, n);
    const pill = stale
      ? this.pill("오래됨", t.foreground, t.raised)
      : this.pill(STATUS_KO[status] ?? status, status === "ok" ? t.accent_foreground : t.foreground, status === "ok" ? t.accent : status === "error" ? t.blocked : t.raised);
    const observedLabel = s?.method === "statusline" ? "세션 수신" : s?.method === "rollout" ? "Codex 기록" : "조회";
    const meta = [];
    if (s?.observed_at) meta.push(`${observedLabel} ${clock(s.observed_at)} (${ago(s.observed_at, n)})`);
    if (s?.fetched_at && s.method !== "statusline") meta.push(`마지막 시도 ${clock(s.fetched_at, false)}`);
    if (s?.last_error) meta.push(`오류: ${s.last_error}`);

    const body = [];
    if (!groups.length) body.push(div().text_color(t.dim).child(s?.message_ko ?? `${src.name} 대기`));
    for (const g of groups) {
      const head = [g.label && groups.length > 1 ? g.label : null, g.plan ? `플랜 ${g.plan}` : null, g.sessions ? `세션 ${g.sessions}개` : null].filter(Boolean).join(" · ");
      if (head) body.push(div().text_size(11).text_color(t.dim).child(head));
      if (!g.windows.length) body.push(div().text_color(t.dim).child("보고된 사용량 창 없음"));
      for (const w of g.windows) body.push(this.windowRow(w, t, n, stale));
      if (g.spend) body.push(div().text_size(11).text_color(t.dim).child(`지출 한도 ${g.spend.used_percent != null ? fmtPct(g.spend.used_percent) + " 사용" : "알 수 없음"}${g.spend.resets_at ? ` · 리셋 ${clock(g.spend.resets_at)}` : ""}`));
      if (g.credits) body.push(div().text_size(11).text_color(t.dim).child(`크레딧 ${g.credits.unlimited ? "무제한" : g.credits.has_credits ? g.credits.balance ?? "있음" : "없음"}`));
      if (g.balance_usd != null) body.push(div().text_size(11).text_color(t.dim).child(`구매 잔액 $${g.balance_usd.toFixed(2)}`));
    }
    if (src.id === "ollama") {
      const l = snap?.local?.ollama;
      const txt = !l ? "로컬 상태 모름" : l.daemon === "running" ? `로컬 실행 중 · ${l.models.length ? `로드됨: ${l.models.join(", ")}` : "로드된 모델 없음"} (로컬 모델은 한도 없음)` : "로컬 꺼짐";
      body.push(div().text_size(11).text_color(t.dim).child(txt));
    }

    return v_flex().gap(8).p(12).rounded(8).border_1().border_color(t.border).bg(t.surface)
      .child(h_flex().gap(8).items_center()
        .child(this.icon(src, t))
        .child(div().text_size(13.5).font_semibold().text_color(t.foreground).child(src.name))
        .child(pill)
        .child(div().flex_1())
        .child(div().text_size(11).text_color(t.dim).child(methodKo(s?.method))))
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
      .child(this.busy ? "조회 중…" : "새로고침");
    const close = h_flex().id("close").h(28).px(10).items_center().rounded(7).text_color(t.dim).cursor_pointer().hover((s) => s.bg(t.hover))
      .on_click(() => closeOverlay(props().overlay)).child("닫기");

    const ctxCard = v_flex().gap(6).p(12).rounded(8).border_1().border_color(t.border).bg(t.surface)
      .child(div().text_size(13).font_semibold().text_color(t.foreground).child("선택한 터미널 컨텍스트"))
      .child(ctx
        ? v_flex().gap(4)
          .child(h_flex().gap(10).items_center()
            .child(this.icon(ctx, t, 14))
            .child(div().flex_1().h(6).rounded(3).bg(t.raised).overflow_hidden().child(div().h_full().w(`${Math.max(1, Math.min(100, ctx.used_percent))}%`).rounded(3).bg(barColor(t, ctx.used_percent))))
            .child(div().w(150).flex_none().text_color(t.foreground).child(`${fmtPct(ctx.used_percent)} 사용`)))
          .child(div().text_size(11).text_color(t.dim).child([ctx.name, ctx.model, ctx.window_tokens ? `${Math.round(ctx.window_tokens / 1000)}k 토큰` : null, ctx.cwd_name, `수신 ${ago(ctx.observed_at, n)}`].filter(Boolean).join(" · ")))
        : div().text_color(t.dim).child("선택한 Claude/Antigravity 터미널의 statusline 값이 없습니다 (Codex 컨텍스트는 표시하지 않음)"));

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
          .child(div().text_size(16).font_semibold().child("구독 사용량"))
          .child(div().text_size(11).text_color(t.dim).child(snap ? `업데이트 ${clock(snap.generated_at)} (${ago(snap.generated_at, n)}) · 네트워크 조회 ${Math.round((snap.poll_s ?? 300) / 60)}분 간격` : "아직 수집 전")))
        .when(Boolean(this.note), (el) => el.child(div().text_size(11).text_color(t.blocked).child(this.note)))
        .child(button).child(close))
      .child(v_flex().id("scroll").flex_1().min_h(0).gap(10).overflow_y_scrollbar()
        .children(SOURCES.map((src) => this.sourceCard(src, snap?.sources?.[src.id], t, n, snap)))
        .child(ctxCard)
        .child(div().text_size(10.5).text_color(t.dim).child("남음/사용은 각 서비스가 보고한 값입니다. 직접 조회 실패 시 마지막 수신값을 표시합니다. 터미널 컨텍스트는 세션에서 받은 값입니다.")));
  }
}
