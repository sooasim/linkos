// F-010 흐름의 끝 — 상대 명함을 찍어 인식한 뒤, 내 명함을 "휴대폰 기본 메시지"로 보내는 교환.
// 순수 로직만 둔다(문자 본문 조립 · sms: 링크 생성). 실제 전송은 클라이언트가 Web Share/sms: 로 한다.
// 비타협 원칙 3(핸드오프 사다리)·8(고위험 자동행동은 승인) 준수: 서버가 자동 발송하지 않고,
// 사용자의 휴대폰 메시지 앱을 '초안이 채워진 상태'로 열어 사용자가 직접 보낸다.

export interface MyCard {
  name: string;
  jobTitle?: string | null;
  company?: string | null;
  phone?: string | null;
  email?: string | null;
  /** 내 공개(디지털) 명함 링크 — 상대가 열어 전체 정보를 보고 저장한다 */
  url?: string | null;
}

/** 숫자와 '+' 만 남긴 전화번호(sms: 링크의 수신자용). 없으면 빈 문자열 → 수신자 없이 작성창만 연다. */
export function telDigits(phone: string | null | undefined): string {
  return String(phone ?? "").replace(/[^\d+]/g, "");
}

/**
 * 내 명함을 문자로 보낼 때의 본문. 이름·직함·회사·연락처는 **내가 가진 값만** 넣고,
 * 전체 정보는 공개 명함 링크로 잇는다. 지어내지 않는다 — 비어 있는 칸은 줄을 생략한다.
 */
export function buildMyCardMessage(me: MyCard, opts: { recipientName?: string | null } = {}): string {
  const who = opts.recipientName?.trim();
  const lines: string[] = [];
  lines.push(who ? `${who}님, 반갑습니다. 제 명함을 보내드려요.` : "반갑습니다. 제 명함을 보내드려요.");
  lines.push("");
  const headline = [me.name, me.jobTitle].filter((x) => x && String(x).trim()).join(" ");
  if (headline) lines.push(headline);
  if (me.company && me.company.trim()) lines.push(me.company.trim());
  if (me.phone && me.phone.trim()) lines.push(`☎ ${me.phone.trim()}`);
  if (me.email && me.email.trim()) lines.push(`✉ ${me.email.trim()}`);
  if (me.url && me.url.trim()) lines.push(me.url.trim());
  return lines.join("\n").trim();
}

/**
 * 상대가 방금 스캔한 명함을 '내 폰에 기록'으로 보낼 때의 본문(인식 결과 요약).
 * 상대의 사실 필드만 담는다 — 역시 지어내지 않는다.
 */
export function buildScanRecordMessage(c: { fullName?: string | null; company?: string | null; jobTitle?: string | null; phone?: string | null; email?: string | null }, at?: string | null): string {
  const lines: string[] = ["📇 스캔한 명함"];
  const headline = [c.fullName, c.jobTitle].filter((x) => x && String(x).trim()).join(" ");
  if (headline) lines.push(headline);
  if (c.company && c.company.trim()) lines.push(c.company.trim());
  if (c.phone && c.phone.trim()) lines.push(`☎ ${c.phone.trim()}`);
  if (c.email && c.email.trim()) lines.push(`✉ ${c.email.trim()}`);
  if (at && at.trim()) lines.push(`— ${at.trim()}`);
  return lines.join("\n").trim();
}

/** 휴대폰 기본 메시지 앱을 여는 sms: 링크. 수신자 번호는 숫자/+만 남긴다. body 는 인코딩한다. */
export function smsHref(phone: string | null | undefined, body: string): string {
  return `sms:${telDigits(phone)}?body=${encodeURIComponent(body)}`;
}
