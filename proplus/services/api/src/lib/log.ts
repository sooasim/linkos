// P-186 구조화 로그 (보안정책 §3 / 기술백서 §7, N-13).
//
// 왜 래퍼를 두는가: console.log 를 직접 쓰면 언젠가 누가 리드 이메일이나 증거 파일 내용을 그대로 찍는다.
// 로그로 나가는 유일한 출구를 하나로 만들고 그 출구에서 redact() 를 강제한다. "조심하자"는 지침은 깨지고 함수는 안 깨진다.
import { redact } from "@proplus/domain";

export type LogLevel = "info" | "warn" | "error";

/**
 * @param event 점 표기 식별자 (`proof.badge_issued`). 사람이 읽는 문장이 아니라 집계 가능한 키다.
 * @param fields 구조화 필드. redact() 를 통과하므로 PII 가 섞여 들어와도 원문으로는 남지 않는다.
 */
export function log(level: LogLevel, event: string, fields?: Record<string, unknown>): void {
  const line = JSON.stringify({
    ts: new Date().toISOString(),
    level,
    event,
    ...(fields ? (redact(fields) as object) : {}),
  });
  // 테스트에서 info/warn 까지 쏟아지면 실패 원인이 묻힌다. 에러는 테스트에서도 보여 준다.
  if (process.env.NODE_ENV === "test" && level !== "error") return;
  if (level === "error") console.error(line);
  else if (level === "warn") console.warn(line);
  else console.log(line);
}
