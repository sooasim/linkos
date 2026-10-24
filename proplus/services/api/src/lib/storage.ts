// N-5 / P-196 증거 원본 저장 (ADR-004 · 보안정책 §2 "증빙 파일 유출" · §3 저장 암호화).
//
// 설계 의도 세 가지:
//  1) 공개 조회 경로는 이 파일을 거치지 않는다. 배지(공개)와 증거 원본(내부)은 저장소부터 분리된다.
//  2) 디스크에 평문 원본을 두지 않는다. 서버 백업·스냅샷이 신분증 사본 더미가 되는 것을 막는다.
//  3) 직접 접근 URL 을 만들지 않는다. 다운로드는 **짧은 만료의 서명 URL**로만 가능하고 매 건 감사로그를 남긴다
//     (보안정책 §2 — 기본 만료 60초).
import { createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { dirname, resolve, sep } from "node:path";
import { ENCRYPTION_REF, decryptBytes, encryptBytes } from "./crypto";
import { badRequest, unavailable } from "./errors";
import { log } from "./log";

export interface StorageDriver {
  readonly name: "local" | "s3";
  put(key: string, data: Buffer, contentType: string): Promise<void>;
  get(key: string): Promise<Buffer>;
  delete(key: string): Promise<void>;
}

/** 객체 키 화이트리스트. `..` 와 절대경로를 막아 드라이버 밖으로 쓰기/읽기가 새 나가지 않게 한다. */
const KEY_RE = /^[a-z0-9][a-z0-9/_-]{2,200}$/;

export function assertObjectKey(key: string): void {
  if (!KEY_RE.test(key) || key.includes("..")) throw badRequest("invalid_object_key", "객체 키 형식이 올바르지 않습니다.");
}

export class LocalDiskDriver implements StorageDriver {
  readonly name = "local" as const;
  constructor(private readonly root: string) {}

  private path(key: string): string {
    assertObjectKey(key);
    const p = resolve(this.root, key);
    // 정규화 후에도 루트 안인지 다시 확인한다 — KEY_RE 를 통과하는 심볼릭한 조합까지 막는 두 번째 그물.
    if (!p.startsWith(resolve(this.root) + sep)) throw badRequest("invalid_object_key", "객체 키 형식이 올바르지 않습니다.");
    return p;
  }

  async put(key: string, data: Buffer): Promise<void> {
    const p = this.path(key);
    await mkdir(dirname(p), { recursive: true, mode: 0o700 });
    // 임시 파일 → rename: 쓰다가 죽어도 반쯤 쓰인 증거 파일이 남지 않는다.
    const tmp = `${p}.${randomBytes(6).toString("hex")}.tmp`;
    await writeFile(tmp, data, { mode: 0o600 });
    await rename(tmp, p);
  }

  async get(key: string): Promise<Buffer> {
    return readFile(this.path(key));
  }

  async delete(key: string): Promise<void> {
    await rm(this.path(key), { force: true });
  }
}

// TODO(전략 §6 Files): S3 호환 드라이버. 이 인터페이스만 구현하면 되고 호출부는 바뀌지 않는다.
//   실사 전까지 설치하지 않는 이유는 오픈소스·외부 의존을 늘리지 않기 위함이 아니라(S3 SDK 는 OSS 검토 대상이 아니다)
//   운영 버킷·키 관리 정책이 아직 없기 때문이다(미결정 §2 데이터 국외이전). 정책이 정해지면 여기에 S3Driver 를 추가한다.

let cached: { sig: string; driver: StorageDriver } | null = null;

export function storageDriver(): StorageDriver {
  const dir = process.env.OBJECT_STORAGE_LOCAL_DIR ?? "/var/lib/proplus/storage";
  if (cached?.sig === dir) return cached.driver;
  const driver = new LocalDiskDriver(dir);
  cached = { sig: dir, driver };
  return driver;
}

/** 저장. 본문은 객체 키를 AAD 로 묶어 암호화한다 — 암호문을 다른 키 위에 옮겨 붙일 수 없다. */
export async function putObject(key: string, data: Buffer, contentType: string): Promise<{ encryptionRef: string }> {
  assertObjectKey(key);
  await storageDriver().put(key, encryptBytes(data, key), contentType);
  return { encryptionRef: ENCRYPTION_REF };
}

export async function getObject(key: string): Promise<Buffer> {
  assertObjectKey(key);
  return decryptBytes(await storageDriver().get(key), key);
}

export async function deleteObject(key: string): Promise<void> {
  assertObjectKey(key);
  await storageDriver().delete(key);
}

// ---------- 서명 URL (보안정책 §2: 짧은 만료) ----------

/** 기본 만료 60초. 증거 파일 링크가 채팅·메일에 붙여진 뒤에도 열리는 상황을 만들지 않는다. */
export const SIGNED_URL_TTL_SEC = Number(process.env.STORAGE_SIGNED_URL_TTL_SEC ?? 60);

function signingSecret(): string {
  const secret = process.env.STORAGE_SIGNING_SECRET ?? process.env.AUTH_SECRET;
  if (!secret) {
    if (process.env.NODE_ENV === "production") throw unavailable("storage_not_configured", "STORAGE_SIGNING_SECRET 이 설정되지 않았습니다.");
    log("warn", "storage.dev_signing_secret");
    return "proplus-dev-only-secret";
  }
  return secret;
}

function signature(key: string, expiresAtSec: number): string {
  return createHmac("sha256", signingSecret()).update(`${key}\n${expiresAtSec}`).digest("hex");
}

/**
 * 다운로드용 서명 URL.
 *
 * async 인 이유: S3 presign 은 비동기다. 지금 local 드라이버는 동기로 끝나지만
 * 드라이버를 교체할 때 호출부(await)를 바꾸지 않으려고 시그니처를 미리 맞춘다.
 */
export async function getSignedUrl(key: string, ttlSec = SIGNED_URL_TTL_SEC): Promise<string> {
  assertObjectKey(key);
  const exp = Math.floor(Date.now() / 1000) + Math.max(1, ttlSec);
  const prefix = (process.env.STORAGE_SIGNED_URL_PREFIX ?? "/api/v1/files").replace(/\/$/, "");
  return `${prefix}?key=${encodeURIComponent(key)}&exp=${exp}&sig=${signature(key, exp)}`;
}

/**
 * 서명 검증. 다운로드 라우트가 호출한다.
 * 비교는 timingSafeEqual 로 한다 — 서명 한 바이트씩 맞춰 보는 공격을 응답시간으로 돕지 않는다.
 */
export function verifySignedUrl(params: { key: string; exp: string | number; sig: string }, now = new Date()): boolean {
  const exp = Number(params.exp);
  if (!Number.isFinite(exp) || exp * 1000 < now.getTime()) return false;
  const expected = Buffer.from(signature(params.key, exp), "utf8");
  const given = Buffer.from(params.sig, "utf8");
  if (expected.length !== given.length) return false;
  return timingSafeEqual(expected, given);
}
