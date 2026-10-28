// 트랜잭션 메일 (로그인 링크 · 검증 결과 · 만료 예정 알림 P-060 · 리드 알림 P-107).
//
// 왜 설정이 없으면 조용히 false 인가: 로컬·CI 에는 SMTP 가 없다. 그때 예외를 던지면
// "메일 발송 실패"가 배지 발급·리드 생성 같은 **본업을 롤백**시킨다. 알림 실패가 판정에 영향을 주지 않아야 한다
// (P-060 수용기준: "알림 실패가 만료 판정에 영향을 주지 않는다").
import { log } from "./log";

export interface MailOptions {
  replyTo?: string | null;
  /** 중복 발송 추적용. 워커 재시도 시 같은 값을 넣으면 수신측에서 스레드가 갈라지지 않는다. */
  messageId?: string;
}

/** @returns SMTP 로 넘겼으면 true, 메일이 설정되지 않았으면 false. */
export async function sendMail(to: string, subject: string, text: string, opts: MailOptions = {}): Promise<boolean> {
  const url = process.env.SMTP_URL;
  if (!url) {
    // 수신 주소는 redact() 가 가린다 — 로그에 리드 이메일이 남지 않는다 (N-13).
    log("info", "mail.skipped_not_configured", { to, subject });
    return false;
  }
  const nodemailer = await import("nodemailer");
  const transport = nodemailer.createTransport(url);
  await transport.sendMail({
    from: process.env.MAIL_FROM ?? "PROPLUS <no-reply@proplus.linkos.com>",
    to,
    subject,
    // HTML 본문을 만들지 않는다: 메일 클라이언트 렌더러까지 XSS 표면을 늘릴 이유가 없고,
    // 알림에 담을 내용은 "확인하러 오세요" 한 줄이면 충분하다 (보안정책 §2).
    text,
    replyTo: opts.replyTo ?? undefined,
    messageId: opts.messageId,
  });
  return true;
}
