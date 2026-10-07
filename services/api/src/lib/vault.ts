// AES-256-GCM sealing with CREDENTIALS_KEY (credential vault, cached idempotent responses).
import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";
import { unavailable } from "./errors";

function key(): Buffer {
  const k = process.env.CREDENTIALS_KEY;
  if (!k) {
    if (process.env.NODE_ENV === "production") throw unavailable("vault_not_configured", "CREDENTIALS_KEY 가 설정되지 않았습니다.");
    return Buffer.alloc(32, 7);
  }
  const b = Buffer.from(k, "base64");
  if (b.length !== 32) throw new Error("CREDENTIALS_KEY must be 32 bytes base64");
  return b;
}

export function seal(obj: unknown): Buffer {
  const iv = randomBytes(12);
  const c = createCipheriv("aes-256-gcm", key(), iv);
  const enc = Buffer.concat([c.update(JSON.stringify(obj), "utf8"), c.final()]);
  return Buffer.concat([iv, c.getAuthTag(), enc]);
}

export function unseal<T>(buf: Buffer): T {
  const d = createDecipheriv("aes-256-gcm", key(), buf.subarray(0, 12));
  d.setAuthTag(buf.subarray(12, 28));
  return JSON.parse(Buffer.concat([d.update(buf.subarray(28)), d.final()]).toString("utf8")) as T;
}
