// F-163 비밀 관리 / F-165 암호화 — AES-256-GCM sealing (credential vault, sealed tokens, cached idempotent responses,
// storage data-key wrapping) with key versioning + rotation.
//
// Keys:   CREDENTIALS_KEYS="v2:<base64 32B>,v1:<base64 32B>"  (first = active for new seals; the rest decrypt only)
//         CREDENTIALS_KEY=<base64 32B>                         (legacy single key — still honoured, id "v1" unless
//                                                               CREDENTIALS_KEYS already names that key)
// Format: versioned  = "LKV1" | len(id) (1 byte) | id (ascii) | iv (12) | tag (16) | ciphertext
//         legacy     = iv (12) | tag (16) | ciphertext          (pre-rotation rows; tried against every key)
// Re-seal everything under the active key with `pnpm vault:rotate` (scripts/rotate-credentials.ts).
import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";
import { unavailable } from "./errors";

const MAGIC = Buffer.from("LKV1", "ascii");
const KEY_ID = /^[A-Za-z0-9_.-]{1,32}$/;

export interface VaultKey {
  id: string;
  key: Buffer;
}

function decodeKey(b64: string, label: string): Buffer {
  const b = Buffer.from(b64.trim(), "base64");
  if (b.length !== 32) throw new Error(`${label} must be 32 bytes base64`);
  return b;
}

/** Parse the keyring from the environment (exported for tests and the rotation script). */
export function parseKeyring(env: { CREDENTIALS_KEYS?: string; CREDENTIALS_KEY?: string; NODE_ENV?: string } = process.env): VaultKey[] {
  const ring: VaultKey[] = [];
  if (env.CREDENTIALS_KEYS?.trim()) {
    for (const part of env.CREDENTIALS_KEYS.split(",").map((s) => s.trim()).filter(Boolean)) {
      const i = part.indexOf(":");
      if (i <= 0) throw new Error("CREDENTIALS_KEYS entries must look like <id>:<base64 key>");
      const id = part.slice(0, i);
      if (!KEY_ID.test(id)) throw new Error(`CREDENTIALS_KEYS: invalid key id "${id}"`);
      if (ring.some((k) => k.id === id)) throw new Error(`CREDENTIALS_KEYS: duplicate key id "${id}"`);
      ring.push({ id, key: decodeKey(part.slice(i + 1), `CREDENTIALS_KEYS[${id}]`) });
    }
  }
  if (env.CREDENTIALS_KEY?.trim()) {
    const key = decodeKey(env.CREDENTIALS_KEY, "CREDENTIALS_KEY");
    if (!ring.some((k) => k.key.equals(key))) {
      let id = "v1";
      for (let n = 0; ring.some((k) => k.id === id); n++) id = `legacy${n || ""}`;
      ring.push({ id, key }); // active only when CREDENTIALS_KEYS is unset
    }
  }
  if (!ring.length) {
    if (env.NODE_ENV === "production") throw unavailable("vault_not_configured", "CREDENTIALS_KEY(S) 가 설정되지 않았습니다.");
    ring.push({ id: "dev", key: Buffer.alloc(32, 7) });
  }
  return ring;
}

let cache: { sig: string; ring: VaultKey[] } | null = null;
function keyring(): VaultKey[] {
  const sig = `${process.env.CREDENTIALS_KEYS ?? ""}|${process.env.CREDENTIALS_KEY ?? ""}|${process.env.NODE_ENV ?? ""}`;
  if (!cache || cache.sig !== sig) cache = { sig, ring: parseKeyring() };
  return cache.ring;
}

export function activeKeyId(): string {
  return keyring()[0]!.id;
}

function encrypt(k: VaultKey, plain: Buffer, aad?: Buffer): Buffer {
  const iv = randomBytes(12);
  const c = createCipheriv("aes-256-gcm", k.key, iv);
  if (aad) c.setAAD(aad);
  const enc = Buffer.concat([c.update(plain), c.final()]);
  const id = Buffer.from(k.id, "ascii");
  return Buffer.concat([MAGIC, Buffer.from([id.length]), id, iv, c.getAuthTag(), enc]);
}

function decryptRaw(key: Buffer, body: Buffer, aad?: Buffer): Buffer {
  const d = createDecipheriv("aes-256-gcm", key, body.subarray(0, 12));
  if (aad) d.setAAD(aad);
  d.setAuthTag(body.subarray(12, 28));
  return Buffer.concat([d.update(body.subarray(28)), d.final()]);
}

/** Key id a ciphertext was sealed with (null = legacy unversioned blob). */
export function sealedKeyId(buf: Buffer): string | null {
  if (buf.length < MAGIC.length + 2 || !buf.subarray(0, MAGIC.length).equals(MAGIC)) return null;
  const n = buf[MAGIC.length]!;
  const id = buf.subarray(MAGIC.length + 1, MAGIC.length + 1 + n).toString("ascii");
  return KEY_ID.test(id) && buf.length >= MAGIC.length + 1 + n + 28 ? id : null;
}

/** Encrypt raw bytes with the active key (optional AAD binds the ciphertext to its context). */
export function sealBytes(plain: Buffer, aad?: Buffer): Buffer {
  return encrypt(keyring()[0]!, plain, aad);
}

/** Decrypt bytes sealed by any key in the ring (versioned or legacy). Throws if no key authenticates it. */
export function unsealBytes(buf: Buffer, aad?: Buffer): Buffer {
  const ring = keyring();
  const id = sealedKeyId(buf);
  if (id) {
    const k = ring.find((x) => x.id === id);
    const start = MAGIC.length + 1 + id.length;
    if (k) {
      try {
        return decryptRaw(k.key, buf.subarray(start), aad);
      } catch {
        // a legacy blob whose random IV happens to start with the magic: fall through to the legacy path
      }
    }
  }
  for (const k of ring) {
    try {
      return decryptRaw(k.key, buf, aad);
    } catch {
      // try next key
    }
  }
  throw new Error(id && !ring.some((x) => x.id === id) ? `vault: key "${id}" is not configured` : "vault: unable to decrypt (unknown key)");
}

/** True when the blob is not sealed with the active key (legacy or older version) and should be re-sealed. */
export function needsReseal(buf: Buffer): boolean {
  return sealedKeyId(buf) !== activeKeyId();
}

/** Re-encrypt under the active key (rotation). */
export function reseal(buf: Buffer, aad?: Buffer): Buffer {
  return sealBytes(unsealBytes(buf, aad), aad);
}

export function seal(obj: unknown): Buffer {
  return sealBytes(Buffer.from(JSON.stringify(obj), "utf8"));
}

export function unseal<T>(buf: Buffer): T {
  return JSON.parse(unsealBytes(buf).toString("utf8")) as T;
}
