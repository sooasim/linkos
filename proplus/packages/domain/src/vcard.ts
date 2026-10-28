/**
 * P-035: QR·vCard·공유 링크 — vCard 생성.
 *
 * 출처: 01_FEATURE_REGISTRY.yaml P-035
 *       "vCard 는 공개 허용 필드만 포함하고 비공개 연락처를 넣지 않는다"
 *
 * **이 함수는 받은 것만 쓴다.** 프로필에서 값을 더 끌어오지 않고, 비어 있는 필드는 줄을 만들지 않는다.
 * 공개 가능 여부 판정은 호출부가 `publicDto.publicContact()` / `pickPublic()` 으로 이미 끝낸다 (N-4).
 * 이 경계를 지키는 이유: vCard 는 "한 번 저장되면 우리 손을 떠나는" 산출물이라
 * 여기서 한 번 흘린 연락처는 비공개로 되돌릴 방법이 없다.
 */

import { stripDangerousUrl } from "./sanitize";

export interface VCardInput {
  displayName: string;
  headline?: string | null;
  org?: string | null;
  url: string;
  email?: string | null;
  phone?: string | null;
}

/**
 * vCard 텍스트 값 이스케이프 (RFC 2426 §2.4.2).
 *
 * 순서가 중요하다: 역슬래시를 **먼저** 바꿔야 뒤에서 만든 `\n`·`\,`·`\;` 가 다시 escape 되지 않는다.
 * 줄바꿈을 `\n` 리터럴로 바꾸는 것은 꾸미기가 아니라 **주입 방어**다 — 값에 CRLF 가 남으면
 * `END:VCARD` 같은 줄을 심어 다른 속성(예: 다른 사람의 TEL)을 끼워 넣을 수 있다.
 */
function esc(value: string): string {
  return value
    .replace(/\\/g, "\\\\")
    .replace(/\r\n|\r|\n/g, "\\n")
    .replace(/,/g, "\\,")
    .replace(/;/g, "\\;")
    .replace(/[\u0000-\u001F\u007F]/g, "")
    .trim();
}

/** 값이 비면 줄을 만들지 않는다 — 빈 FN/TEL 은 주소록 앱에서 깨진 연락처로 보인다. */
function push(lines: string[], name: string, value: string | null | undefined): void {
  if (typeof value !== "string") return;
  const v = esc(value);
  if (v.length === 0) return;
  lines.push(`${name}:${v}`);
}

/**
 * vCard 3.0 문자열. 줄 구분은 CRLF 다 (RFC 2426 — LF 만 쓰면 iOS 연락처가 거부한다).
 *
 * 긴 줄 접기(folding)는 하지 않는다. 실제 주소록 앱들이 접히지 않은 줄을 모두 받아들이고,
 * 접기를 잘못 구현하면 멀티바이트 한글이 쪼개져 값이 깨지는 쪽이 더 큰 위험이다.
 *
 * @throws displayName 이 비었을 때. vCard 3.0 에서 FN 은 필수이고, 이름 없는 vCard 는
 *         저장되는 순간 "누구의 것인지 알 수 없는 연락처"가 되므로 조용히 만들지 않는다.
 */
export function buildVCard(i: VCardInput): string {
  // 필수 검사는 **이스케이프 전 원문**으로 한다. `esc()` 가 CRLF 를 리터럴 `\n`(2글자)로
  // 바꾸므로, 개행만 담긴 이름은 이스케이프 후 길이가 0 이 아니게 되어 검사를 통과하고
  // `FN:\n` 이라는 이름 없는 vCard 가 만들어진다. 가시 문자가 하나라도 있어야 이름이다.
  const hasVisibleName = typeof i.displayName === "string" && /\P{White_Space}/u.test(i.displayName.replace(/\p{C}/gu, ""));
  if (!hasVisibleName) {
    throw new Error("vcard:display_name_required");
  }

  const fullName = esc(i.displayName);

  const lines: string[] = ["BEGIN:VCARD", "VERSION:3.0", `FN:${fullName}`, `N:${fullName};;;;`];

  // 헤드라인은 직함이 아니지만 주소록에서 "이 사람이 무슨 일을 하는가"가 보이는 유일한 칸이다.
  push(lines, "TITLE", i.headline);
  push(lines, "ORG", i.org);
  // URL 은 공개 프로필 주소(`https://proplus.linkos.com/p/{slug}`)다. 검증 내용은 담지 않는다 —
  // 배지는 만료·취소될 수 있으므로(N-9) 스냅샷이 아니라 **링크**로만 전달한다.
  // 서버가 만든 값이지만 스킴을 한 번 더 확인한다: vCard 는 우리 손을 떠나 다른 앱이 여는 파일이고,
  // 거기서 `javascript:`·`data:` 가 열리면 우리 쪽에서 막을 수단이 없다 (P-033).
  push(lines, "URL", stripDangerousUrl(i.url));
  push(lines, "EMAIL;TYPE=INTERNET", i.email);
  push(lines, "TEL;TYPE=CELL", i.phone);

  lines.push("END:VCARD");
  return `${lines.join("\r\n")}\r\n`;
}
