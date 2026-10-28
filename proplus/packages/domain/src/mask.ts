/**
 * 연락처 마스킹 분기 — P-102 (리드 연락처는 암호화 저장, 목록에는 마스킹만).
 *
 * 왜 `redact.ts` 와 파일을 나눴는가:
 *   리댁션은 **로그·이벤트**용이고 되돌릴 수 없게 지운다. 마스킹은 **화면**용이고
 *   "같은 사람인지 알아보기"를 남긴다. 호출부가 둘을 혼동하면 로그에 `010-****-1234`
 *   가 남거나 화면에 `[redacted]` 가 뜬다. 파일이 다르면 import 가 의도를 드러낸다.
 */

import { maskEmail, maskPhone } from "./redact";

export type ContactKind = "email" | "phone";

/**
 * 저장된 연락처를 담당자 화면에 보여줄 형태로 바꾼다.
 *
 * 복호화된 값이 이 함수까지 오는 것은 정상이다 — 다만 **마스킹 결과만** 응답에 담는다.
 * 원문 공개는 별도 권한·감사로그 경로(P-104)를 거친다.
 */
export function maskContact(kind: ContactKind, value: string): string {
  return kind === "email" ? maskEmail(value) : maskPhone(value);
}
