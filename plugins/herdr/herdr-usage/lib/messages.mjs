// Source messages as locale-neutral codes. The mods show them in the chosen
// language; message_ko (Korean) is still written for older readers. Keep this
// Korean text equal to mod/shared/i18n.js (test/i18n.test.mjs checks it).
export const MESSAGES_KO = {
  not_polled: "아직 조회 전",
  showing_last: "마지막 값 표시",
  session_value: "세션 수신값 (마지막 응답 기준)",
  statusline_connect: (n) => `${n} statusline 연결 필요`,
  statusline_waiting: (n) => `${n} 세션 대기 중 (첫 응답 후 표시)`,
  partial_session: "일부 한도는 마지막 세션 값",
  showing_last_session: "마지막 세션 값 표시",
  live: "실시간 조회",
  agy_live: "실시간 조회 (터미널 실행 불필요)",
  agy_login: "Antigravity 로그인 확인 필요",
  agy_failed: "Antigravity 사용량 조회 실패",
  agy_no_quota: "사용량 조회 응답에 구독 한도 없음",
  codex_rollout: "마지막 Codex 턴 기록",
  codex_failed: "Codex 조회 실패",
  claude_auth: "Claude 로그인 갱신 필요",
  claude_rate_limited: "Claude 조회 제한 · 잠시 후 재시도",
  claude_failed: "Claude 사용량 조회 실패",
  claude_empty: "Claude 사용량 응답이 비어 있음",
  ollama_login: "Ollama 로그인 필요",
  ollama_signin: "Ollama 로그인 필요 (ollama signin)",
  ollama_auth: "Ollama 인증 필요",
  rate_limited: "요청 한도 초과, 잠시 후 재시도",
  ollama_failed: "Ollama 조회 실패",
};

const cliName = (src) => (src === "claude" ? "Claude Code" : src === "agy" ? "Antigravity" : src ?? "");

/** Korean text for a list of codes (joined with " · "). */
export function koText(codes, src) {
  return codes.map((c) => { const v = MESSAGES_KO[c]; return typeof v === "function" ? v(cliName(src)) : v ?? c; }).join(" · ");
}

/** { message_codes, message_ko } for a source result. */
export const msg = (codes, src) => ({ message_codes: codes, message_ko: koText(codes, src) });
