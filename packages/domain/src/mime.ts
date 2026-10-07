// F-106/F-115 RFC 5322 메시지 생성 (Gmail API raw, Gmail drafts). 헤더 인젝션 방지 + UTF-8 encoded-word.

const enc = new TextEncoder();
const B64 = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";

export function bytesToBase64(bytes: Uint8Array): string {
  let out = "";
  for (let i = 0; i < bytes.length; i += 3) {
    const a = bytes[i]!;
    const b = bytes[i + 1];
    const c = bytes[i + 2];
    out += B64[a >> 2]! + B64[((a & 3) << 4) | ((b ?? 0) >> 4)]!;
    out += b === undefined ? "=" : B64[((b & 15) << 2) | ((c ?? 0) >> 6)]!;
    out += c === undefined ? "=" : B64[c & 63]!;
  }
  return out;
}

export function utf8Base64(s: string): string {
  return bytesToBase64(enc.encode(s));
}

export function base64Url(s: string): string {
  return utf8Base64(s).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

const EMAIL_RE = /^[^\s@<>()",;:\\[\]]+@[^\s@<>()",;:\\[\]]+\.[^\s@<>()",;:\\[\]]+$/;
export function isSafeEmail(s: string): boolean {
  return s.length <= 254 && EMAIL_RE.test(s) && !/[\r\n]/.test(s);
}

/** RFC 2047 encoded-word(s); splits on character boundaries so each word stays <= 75 chars. */
export function encodeHeader(value: string): string {
  if (/[\r\n]/.test(value)) throw new Error("header injection");
  if (/^[\x20-\x7e]*$/.test(value)) return value;
  const words: string[] = [];
  let cur = "";
  for (const ch of value) {
    if (enc.encode(cur + ch).length > 42) {
      words.push(cur);
      cur = "";
    }
    cur += ch;
  }
  if (cur) words.push(cur);
  return words.map((w) => `=?UTF-8?B?${utf8Base64(w)}?=`).join("\r\n ");
}

function address(email: string, name?: string | null): string {
  if (!isSafeEmail(email)) throw new Error("invalid email");
  if (!name) return email;
  const clean = name.replace(/["\r\n]/g, "").trim();
  return /^[\x20-\x7e]*$/.test(clean) ? `"${clean}" <${email}>` : `${encodeHeader(clean)} <${email}>`;
}

export interface MimeInput {
  to: string;
  toName?: string | null;
  from?: string | null;
  fromName?: string | null;
  replyTo?: string | null;
  subject: string;
  body: string;
  date?: Date;
  messageId?: string;
}

export function buildMimeMessage(m: MimeInput): string {
  const headers = [`To: ${address(m.to, m.toName)}`];
  if (m.from) headers.push(`From: ${address(m.from, m.fromName)}`);
  if (m.replyTo) headers.push(`Reply-To: ${address(m.replyTo)}`);
  headers.push(`Subject: ${encodeHeader(m.subject)}`, `Date: ${(m.date ?? new Date()).toUTCString().replace("GMT", "+0000")}`);
  if (m.messageId) {
    if (/[\r\n<>]/.test(m.messageId)) throw new Error("invalid message id");
    headers.push(`Message-ID: <${m.messageId}>`);
  }
  headers.push("MIME-Version: 1.0", 'Content-Type: text/plain; charset="UTF-8"', "Content-Transfer-Encoding: base64");
  const body = utf8Base64(m.body.replace(/\r?\n/g, "\r\n")).replace(/.{1,76}/g, "$&\r\n");
  return `${headers.join("\r\n")}\r\n\r\n${body}`;
}
