// F-019 암호화 object storage: storage driver interface (S3-compatible / local disk) + envelope encryption.
// Each object is encrypted with its own random 256-bit data key (AES-256-GCM, object key bound as AAD);
// the data key is wrapped with the vault keyring (CREDENTIALS_KEYS/CREDENTIALS_KEY) and stored in Postgres, never next to the ciphertext.
// Deleting the DB row therefore crypto-shreds the object even if a storage replica lingers.
import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";
import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { dirname, join, resolve, sep } from "node:path";
import { unavailable } from "./errors";
import { log } from "./platform";
import { sealBytes, unsealBytes } from "./vault";

export interface StorageDriver {
  readonly name: "local" | "s3";
  put(key: string, data: Buffer, contentType: string): Promise<void>;
  get(key: string): Promise<Buffer>;
  delete(key: string): Promise<void>;
}

const KEY_RE = /^[a-z0-9][a-z0-9/_-]{2,200}$/;
function assertKey(key: string) {
  if (!KEY_RE.test(key) || key.includes("..")) throw new Error("invalid object key");
}

export class LocalDiskDriver implements StorageDriver {
  readonly name = "local" as const;
  constructor(private readonly root: string) {}
  private path(key: string) {
    assertKey(key);
    const p = resolve(this.root, key);
    if (!p.startsWith(resolve(this.root) + sep)) throw new Error("invalid object key");
    return p;
  }
  async put(key: string, data: Buffer): Promise<void> {
    const p = this.path(key);
    await mkdir(dirname(p), { recursive: true, mode: 0o700 });
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

export class S3Driver implements StorageDriver {
  readonly name = "s3" as const;
  private client: import("@aws-sdk/client-s3").S3Client | null = null;
  constructor(
    private readonly bucket: string,
    private readonly opts: { endpoint?: string; region?: string; accessKeyId?: string; secretAccessKey?: string; forcePathStyle?: boolean; sse?: string; prefix?: string } = {},
  ) {}
  private async s3() {
    const sdk = await import("@aws-sdk/client-s3");
    if (!this.client) {
      this.client = new sdk.S3Client({
        region: this.opts.region ?? "auto",
        endpoint: this.opts.endpoint,
        forcePathStyle: this.opts.forcePathStyle ?? Boolean(this.opts.endpoint),
        credentials: this.opts.accessKeyId && this.opts.secretAccessKey ? { accessKeyId: this.opts.accessKeyId, secretAccessKey: this.opts.secretAccessKey } : undefined,
        // S3-compatible stores (R2, MinIO, GCS interop) do not all accept the newer default checksums
        requestChecksumCalculation: "WHEN_REQUIRED",
        responseChecksumValidation: "WHEN_REQUIRED",
        maxAttempts: 3,
      });
    }
    return { sdk, client: this.client };
  }
  private k(key: string) {
    assertKey(key);
    return `${this.opts.prefix ?? ""}${key}`;
  }
  async put(key: string, data: Buffer, contentType: string): Promise<void> {
    const { sdk, client } = await this.s3();
    await client.send(
      new sdk.PutObjectCommand({
        Bucket: this.bucket,
        Key: this.k(key),
        Body: data,
        ContentLength: data.length,
        // the payload is already ciphertext; the declared type is kept as metadata only
        ContentType: "application/octet-stream",
        Metadata: { "linkos-type": contentType.slice(0, 100) },
        ...(this.opts.sse ? { ServerSideEncryption: this.opts.sse as "AES256" } : {}),
      }),
    );
  }
  async get(key: string): Promise<Buffer> {
    const { sdk, client } = await this.s3();
    const r = await client.send(new sdk.GetObjectCommand({ Bucket: this.bucket, Key: this.k(key) }));
    if (!r.Body) throw new Error("empty object body");
    return Buffer.from(await r.Body.transformToByteArray());
  }
  async delete(key: string): Promise<void> {
    const { sdk, client } = await this.s3();
    await client.send(new sdk.DeleteObjectCommand({ Bucket: this.bucket, Key: this.k(key) }));
  }
}

let cached: { sig: string; driver: StorageDriver } | null = null;

/** OBJECT_STORAGE_DRIVER=s3|local (default: s3 when OBJECT_STORAGE_BUCKET is set, otherwise local encrypted disk). */
export function storageDriver(): StorageDriver {
  const env = process.env;
  const kind = env.OBJECT_STORAGE_DRIVER ?? (env.OBJECT_STORAGE_BUCKET ? "s3" : "local");
  const sig = [kind, env.OBJECT_STORAGE_BUCKET, env.OBJECT_STORAGE_ENDPOINT, env.OBJECT_STORAGE_LOCAL_DIR].join("|");
  if (cached?.sig === sig) return cached.driver;
  let driver: StorageDriver;
  if (kind === "s3") {
    if (!env.OBJECT_STORAGE_BUCKET) throw unavailable("storage_not_configured", "OBJECT_STORAGE_BUCKET 이 설정되지 않았습니다.");
    driver = new S3Driver(env.OBJECT_STORAGE_BUCKET, {
      endpoint: env.OBJECT_STORAGE_ENDPOINT || undefined,
      region: env.OBJECT_STORAGE_REGION || undefined,
      accessKeyId: env.OBJECT_STORAGE_ACCESS_KEY_ID || undefined,
      secretAccessKey: env.OBJECT_STORAGE_SECRET_ACCESS_KEY || undefined,
      forcePathStyle: env.OBJECT_STORAGE_FORCE_PATH_STYLE ? env.OBJECT_STORAGE_FORCE_PATH_STYLE === "1" : undefined,
      sse: env.OBJECT_STORAGE_SSE || undefined,
      prefix: env.OBJECT_STORAGE_PREFIX || undefined,
    });
  } else {
    const dir = env.OBJECT_STORAGE_LOCAL_DIR ?? join(process.cwd(), ".data", "objects");
    if (env.NODE_ENV === "production" && !env.OBJECT_STORAGE_LOCAL_DIR) log("warn", "storage.local_default_dir", { dir });
    driver = new LocalDiskDriver(dir);
  }
  cached = { sig, driver };
  return driver;
}

// ---------- envelope encryption ----------
// The data key is wrapped by the vault keyring (F-163 key versioning: CREDENTIALS_KEYS / CREDENTIALS_KEY); legacy
// wrapped keys (iv|tag|wrapped) still open, and `pnpm vault:rotate` re-wraps them under the active key.
export const WRAP_AAD = Buffer.from("linkos-dek-v1");

export interface Sealed {
  ciphertext: Buffer;
  wrappedKey: Buffer;
  iv: Buffer;
  authTag: Buffer;
}

export function sealObject(objectKey: string, plaintext: Buffer): Sealed {
  const dek = randomBytes(32);
  const iv = randomBytes(12);
  const c = createCipheriv("aes-256-gcm", dek, iv);
  c.setAAD(Buffer.from(objectKey));
  const ciphertext = Buffer.concat([c.update(plaintext), c.final()]);
  const authTag = c.getAuthTag();
  const wrappedKey = sealBytes(dek, WRAP_AAD);
  dek.fill(0);
  return { ciphertext, wrappedKey, iv, authTag };
}

export function openObject(objectKey: string, s: Sealed): Buffer {
  const dek = unsealBytes(s.wrappedKey, WRAP_AAD);
  const d = createDecipheriv("aes-256-gcm", dek, s.iv);
  d.setAAD(Buffer.from(objectKey));
  d.setAuthTag(s.authTag);
  const out = Buffer.concat([d.update(s.ciphertext), d.final()]);
  dek.fill(0);
  return out;
}
