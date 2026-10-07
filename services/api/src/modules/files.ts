// files module — encrypted object storage for F-019 명함 원본 보관, F-024 딥 프로필 미디어/파일, F-156 공유 파일,
// with F-172 upload inspection, signed short-lived download URLs and retention purge.
import { createHash, randomUUID, timingSafeEqual } from "node:crypto";
import { type Audience, type Visibility, canSee, isVisibility } from "@linkos/domain";
import { z } from "zod";
import { type Db, one, pool, q, tx } from "../lib/db";
import { ApiError, badRequest, notFound, unauthorized } from "../lib/errors";
import { type InspectedUpload, type UploadPurpose, inspectUpload } from "../lib/filescan";
import { type Ctx, audit, hmac, log } from "../lib/platform";
import { openObject, sealObject, storageDriver } from "../lib/storage";

export interface StoredObject {
  id: string;
  contentType: string;
  byteSize: number;
  scanStatus: InspectedUpload["scanStatus"];
  scanDetail: string | null;
  retentionUntil: Date | null;
}

const days = (n: number) => new Date(Date.now() + n * 86_400_000);

/**
 * Inspect → encrypt → put to storage → insert the row. Storage I/O happens before (and outside) any
 * transaction; callers link the returned id in their own transaction and call deleteStoredObject on failure.
 */
export async function storeObject(input: {
  ownerUserId: string;
  purpose: UploadPurpose;
  bytes: Buffer;
  filename?: string | null;
  retentionDays?: number | null;
  metadata?: Record<string, unknown>;
  skipReencode?: boolean;
}): Promise<StoredObject> {
  const inspected = await inspectUpload(input.purpose, input.bytes, { skipReencode: input.skipReencode });
  const now = new Date();
  const objectKey = `${input.purpose.replace(/_/g, "-")}/${now.getUTCFullYear()}/${String(now.getUTCMonth() + 1).padStart(2, "0")}/${randomUUID()}`;
  const sealed = sealObject(objectKey, inspected.bytes);
  const driver = storageDriver();
  await driver.put(objectKey, sealed.ciphertext, inspected.contentType);
  try {
    const row = await one<{ id: string; retention_until: Date | null }>(
      `INSERT INTO stored_objects (owner_user_id, purpose, driver, object_key, content_type, byte_size, sha256, original_name, wrapped_key, iv, auth_tag, scan_status, scan_engine, scan_detail, retention_until, metadata)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16) RETURNING id, retention_until`,
      [
        input.ownerUserId, input.purpose, driver.name, objectKey, inspected.contentType, inspected.bytes.length,
        createHash("sha256").update(inspected.bytes).digest("hex"), input.filename?.slice(0, 200) ?? null,
        sealed.wrappedKey, sealed.iv, sealed.authTag, inspected.scanStatus, inspected.engine, inspected.detail,
        input.retentionDays ? days(input.retentionDays) : null, JSON.stringify({ ...(input.metadata ?? {}), sanitized: inspected.sanitized }),
      ],
    );
    if (inspected.scanStatus === "quarantined") log("warn", "upload.quarantined", { objectId: row!.id, purpose: input.purpose, detail: inspected.detail });
    return { id: row!.id, contentType: inspected.contentType, byteSize: inspected.bytes.length, scanStatus: inspected.scanStatus, scanDetail: inspected.detail, retentionUntil: row!.retention_until };
  } catch (e) {
    await driver.delete(objectKey).catch(() => undefined);
    throw e;
  }
}

/** Hard delete: storage object + row (wrapped key) — cascades to the linking rows. */
export async function deleteStoredObject(id: string, db: Db = pool()): Promise<void> {
  const r = await one<{ object_key: string; driver: string }>("DELETE FROM stored_objects WHERE id=$1 RETURNING object_key, driver", [id], db);
  if (r) await storageDriver().delete(r.object_key).catch((e) => log("warn", "storage.delete_failed", { error: (e as Error).message }));
}

export async function readObjectBytes(id: string): Promise<{ bytes: Buffer; contentType: string; filename: string | null; scanStatus: string }> {
  const r = await one<any>("SELECT object_key, content_type, original_name, wrapped_key, iv, auth_tag, scan_status FROM stored_objects WHERE id=$1 AND deleted_at IS NULL", [id]);
  if (!r) throw notFound("file");
  const ciphertext = await storageDriver().get(r.object_key);
  const bytes = openObject(r.object_key, { ciphertext, wrappedKey: r.wrapped_key, iv: r.iv, authTag: r.auth_tag });
  return { bytes, contentType: r.content_type, filename: r.original_name, scanStatus: r.scan_status };
}

// ---------- signed download URLs ----------
export const DEFAULT_URL_TTL = 300;

export function signedFileUrl(objectId: string, ttlSec = DEFAULT_URL_TTL, now = Date.now()): string {
  const exp = Math.floor(now / 1000) + ttlSec;
  return `/api/v1/files/${objectId}?exp=${exp}&sig=${hmac(`file:${objectId}:${exp}`)}`;
}

/** GET /files/{id}?exp&sig — the signature is the capability (short-lived); quarantined files are never served. */
export async function downloadSigned(objectId: string, exp: string | null, sig: string | null) {
  if (!/^[0-9a-f-]{36}$/.test(objectId) || !exp || !sig || !/^\d+$/.test(exp)) throw new ApiError(403, "invalid_signature", "유효하지 않은 링크입니다.");
  const expected = Buffer.from(hmac(`file:${objectId}:${exp}`));
  const given = Buffer.from(sig);
  if (expected.length !== given.length || !timingSafeEqual(expected, given)) throw new ApiError(403, "invalid_signature", "유효하지 않은 링크입니다.");
  if (Number(exp) * 1000 < Date.now()) throw new ApiError(410, "link_expired", "링크가 만료되었습니다.");
  const o = await readObjectBytes(objectId);
  if (o.scanStatus === "quarantined") throw new ApiError(423, "file_quarantined", "보안 검사에서 격리된 파일입니다.");
  return o;
}

/** Retention (F-019): purge objects past retention_until. Run from the worker. */
export async function purgeExpiredObjects(limit = 100): Promise<number> {
  const rows = await q<{ id: string }>("SELECT id FROM stored_objects WHERE retention_until IS NOT NULL AND retention_until < now() ORDER BY retention_until LIMIT $1", [limit]);
  for (const r of rows) await deleteStoredObject(r.id);
  if (rows.length) await q("INSERT INTO audit_logs (action, entity_type, metadata) VALUES ('storage.retention_purge','stored_object',$1)", [JSON.stringify({ count: rows.length })]);
  return rows.length;
}

const objectView = (o: { id: string; content_type: string; byte_size: string | number; scan_status: string; retention_until?: Date | null; original_name?: string | null }, ttl = DEFAULT_URL_TTL) => ({
  objectId: o.id,
  contentType: o.content_type,
  byteSize: Number(o.byte_size),
  scanStatus: o.scan_status,
  filename: o.original_name ?? null,
  retentionUntil: o.retention_until ?? null,
  url: o.scan_status === "quarantined" ? null : signedFileUrl(o.id, ttl),
});

// ---------- F-019 card originals (opt-in per scan) ----------
export function cardImageRetentionDays(): number {
  return Number(process.env.CARD_IMAGE_RETENTION_DAYS ?? 365);
}

export async function attachCardImage(ctx: Ctx, cardId: string, side: "front" | "back", bytes: Buffer) {
  if (!ctx.userId) throw unauthorized();
  const userId = ctx.userId;
  const card = await one<{ id: string }>("SELECT id FROM business_cards WHERE id=$1 AND captured_by=$2", [cardId, userId]);
  if (!card) throw notFound("capture job");
  const obj = await storeObject({ ownerUserId: userId, purpose: "card_image", bytes, filename: `card-${side}.jpg`, retentionDays: cardImageRetentionDays(), metadata: { cardId, side } });
  const col = side === "front" ? "front_object_id" : "back_object_id";
  try {
    const old = await tx(async (c) => {
      const prev = await one<{ old: string | null }>(`SELECT ${col} AS old FROM business_cards WHERE id=$1 FOR UPDATE`, [cardId], c);
      await c.query(`UPDATE business_cards SET ${col}=$2, ${side === "front" ? "front_object_key" : "back_object_key"}=$3 WHERE id=$1`, [cardId, obj.id, obj.id]);
      await audit(c, ctx, "capture.image_stored", "business_card", cardId, { side, scan: obj.scanStatus, retentionDays: cardImageRetentionDays() });
      return prev?.old ?? null;
    });
    if (old) await deleteStoredObject(old);
  } catch (e) {
    await deleteStoredObject(obj.id);
    throw e;
  }
  return { cardId, side, ...obj, url: obj.scanStatus === "quarantined" ? null : signedFileUrl(obj.id) };
}

export async function listCardImages(ctx: Ctx, cardId: string) {
  if (!ctx.userId) throw unauthorized();
  const card = await one<{ front_object_id: string | null; back_object_id: string | null }>("SELECT front_object_id, back_object_id FROM business_cards WHERE id=$1 AND captured_by=$2", [cardId, ctx.userId]);
  if (!card) throw notFound("capture job");
  const ids = [card.front_object_id, card.back_object_id].filter(Boolean) as string[];
  const rows = ids.length ? await q<any>("SELECT id, content_type, byte_size, scan_status, retention_until FROM stored_objects WHERE id = ANY($1::uuid[])", [ids]) : [];
  return {
    images: rows.map((r) => ({ side: r.id === card.front_object_id ? "front" : "back", ...objectView(r) })),
  };
}

export async function deleteCardImage(ctx: Ctx, cardId: string, side: "front" | "back") {
  if (!ctx.userId) throw unauthorized();
  const col = side === "front" ? "front_object_id" : "back_object_id";
  const card = await one<{ id: string | null }>(`SELECT ${col} AS id FROM business_cards WHERE id=$1 AND captured_by=$2`, [cardId, ctx.userId]);
  if (!card) throw notFound("capture job");
  if (card.id) {
    await deleteStoredObject(card.id);
    await audit(pool(), ctx, "capture.image_deleted", "business_card", cardId, { side });
  }
  return { ok: true };
}

/** Images of all business cards linked to a contact (owner only) — shown on the person page. */
export async function contactCardImages(ctx: Ctx, contactId: string) {
  if (!ctx.userId) throw unauthorized();
  const rows = await q<any>(
    `SELECT b.id AS card_id, o.id, o.content_type, o.byte_size, o.scan_status, o.retention_until, CASE WHEN o.id=b.front_object_id THEN 'front' ELSE 'back' END AS side
     FROM business_cards b JOIN stored_objects o ON o.id IN (b.front_object_id, b.back_object_id)
     WHERE b.contact_id=$1 AND b.captured_by=$2 ORDER BY b.captured_at DESC LIMIT 10`,
    [contactId, ctx.userId],
  );
  return { images: rows.map((r) => ({ cardId: r.card_id, side: r.side, ...objectView(r) })) };
}

// ---------- F-024 deep profile media ----------
export const mediaMeta = z.object({
  title: z.string().trim().max(120).nullish(),
  visibility: z.string().refine((v): v is Visibility => isVisibility(v) && v !== "private", "invalid visibility").default("business"),
});

const MAX_MEDIA = 30;

export async function addProfileMedia(ctx: Ctx, profileId: string, bytes: Buffer, meta: z.infer<typeof mediaMeta>, filename?: string | null) {
  if (!ctx.userId) throw unauthorized();
  const p = await one<{ user_id: string }>("SELECT user_id FROM profiles WHERE id=$1", [profileId]);
  if (!p || p.user_id !== ctx.userId) throw notFound("profile");
  const count = await one<{ n: number }>("SELECT count(*)::int AS n FROM profile_media WHERE profile_id=$1", [profileId]);
  if ((count?.n ?? 0) >= MAX_MEDIA) throw new ApiError(422, "too_many_media", `미디어는 최대 ${MAX_MEDIA}개까지 올릴 수 있습니다.`);
  const obj = await storeObject({ ownerUserId: ctx.userId, purpose: "profile_media", bytes, filename, metadata: { profileId } });
  try {
    const id = await tx(async (c) => {
      const r = await one<{ id: string }>(
        "INSERT INTO profile_media (profile_id, object_id, kind, title, visibility, sort_order) VALUES ($1,$2,$3,$4,$5,$6) RETURNING id",
        [profileId, obj.id, obj.contentType === "application/pdf" ? "pdf" : "image", meta.title ?? filename ?? null, meta.visibility, count?.n ?? 0],
        c,
      );
      await audit(c, ctx, "profile.media_added", "profile", profileId, { kind: obj.contentType, scan: obj.scanStatus });
      return r!.id;
    });
    return { ...obj, objectId: obj.id, id };
  } catch (e) {
    await deleteStoredObject(obj.id);
    throw e;
  }
}

/** Same audience rules as the public card (F-034): owner > trusted (approved request) > business (relationship) > public. */
export async function audienceFor(profileId: string, viewerUserId: string | null): Promise<Audience> {
  const p = await one<{ user_id: string }>("SELECT user_id FROM profiles WHERE id=$1", [profileId]);
  if (!p) throw notFound("profile");
  if (viewerUserId && viewerUserId === p.user_id) return "owner";
  if (!viewerUserId) return "public";
  const granted = await one("SELECT 1 FROM access_requests WHERE requester_user_id=$1 AND target_profile_id=$2 AND status='approved' LIMIT 1", [viewerUserId, profileId]);
  if (granted) return "trusted";
  const related = await one("SELECT 1 FROM contacts WHERE owner_user_id=$1 AND linked_user_id=$2 AND deleted_at IS NULL", [p.user_id, viewerUserId]);
  return related ? "business" : "public";
}

export async function listProfileMedia(profileId: string, viewerUserId: string | null) {
  const audience = await audienceFor(profileId, viewerUserId);
  const rows = await q<any>(
    `SELECT m.id, m.kind, m.title, m.visibility, o.id AS object_id, o.content_type, o.byte_size, o.scan_status, o.original_name
     FROM profile_media m JOIN stored_objects o ON o.id=m.object_id WHERE m.profile_id=$1 ORDER BY m.sort_order, m.created_at`,
    [profileId],
  );
  const visible = rows.filter((r) => canSee(r.visibility as Visibility, audience) && (audience === "owner" || r.scan_status !== "quarantined"));
  return {
    audience,
    hidden: rows.length - visible.length,
    media: visible.map((r) => ({ id: r.id, kind: r.kind, title: r.title, visibility: r.visibility, ...objectView({ id: r.object_id, content_type: r.content_type, byte_size: r.byte_size, scan_status: r.scan_status, original_name: r.original_name }, 600) })),
  };
}

export async function deleteProfileMedia(ctx: Ctx, profileId: string, mediaId: string) {
  if (!ctx.userId) throw unauthorized();
  const m = await one<{ object_id: string }>(
    "SELECT m.object_id FROM profile_media m JOIN profiles p ON p.id=m.profile_id WHERE m.id=$1 AND m.profile_id=$2 AND p.user_id=$3",
    [mediaId, profileId, ctx.userId],
  );
  if (!m) throw notFound("media");
  await deleteStoredObject(m.object_id);
  await audit(pool(), ctx, "profile.media_deleted", "profile", profileId);
  return { ok: true };
}

// ---------- F-156 Connection Room shared files / links ----------
async function assertRoom(userId: string, roomId: string) {
  const r = await one("SELECT 1 FROM connection_rooms WHERE id=$1 AND owner_user_id=$2", [roomId, userId]);
  if (!r) throw notFound("room");
}

export async function addRoomFile(ctx: Ctx, roomId: string, bytes: Buffer, title: string | null, filename?: string | null) {
  if (!ctx.userId) throw unauthorized();
  const userId = ctx.userId;
  await assertRoom(userId, roomId);
  const obj = await storeObject({ ownerUserId: userId, purpose: "room_file", bytes, filename, metadata: { roomId } });
  try {
    const id = await tx(async (c) => {
      const label = (title || filename || "파일").slice(0, 160);
      const r = await one<{ id: string }>("INSERT INTO connection_room_files (room_id, object_id, title, kind, uploaded_by) VALUES ($1,$2,$3,'file',$4) RETURNING id", [roomId, obj.id, label, userId], c);
      await c.query("INSERT INTO connection_room_messages (room_id, author_user_id, body) VALUES ($1,$2,$3)", [roomId, userId, `파일 공유: ${label}`]);
      await audit(c, ctx, "room.file_added", "connection_room", roomId, { scan: obj.scanStatus });
      return r!.id;
    });
    return { ...obj, objectId: obj.id, id };
  } catch (e) {
    await deleteStoredObject(obj.id);
    throw e;
  }
}

export const roomLinkInput = z.object({ title: z.string().trim().min(1).max(160), url: z.string().trim().max(1000) });

export async function addRoomLink(ctx: Ctx, roomId: string, input: z.infer<typeof roomLinkInput>) {
  if (!ctx.userId) throw unauthorized();
  const userId = ctx.userId;
  await assertRoom(userId, roomId);
  let url: URL;
  try {
    url = new URL(input.url.includes("://") ? input.url : `https://${input.url}`);
  } catch {
    throw badRequest("invalid_url", "올바른 링크가 아닙니다.");
  }
  if (!["http:", "https:"].includes(url.protocol)) throw badRequest("invalid_url", "http(s) 링크만 공유할 수 있습니다.");
  return tx(async (c) => {
    const r = await one<{ id: string }>("INSERT INTO connection_room_files (room_id, url, title, kind, uploaded_by) VALUES ($1,$2,$3,'link',$4) RETURNING id", [roomId, url.toString(), input.title, userId], c);
    await c.query("INSERT INTO connection_room_messages (room_id, author_user_id, body) VALUES ($1,$2,$3)", [roomId, userId, `링크 공유: ${input.title}`]);
    return { id: r!.id, url: url.toString() };
  });
}

export async function listRoomFiles(ctx: Ctx, roomId: string) {
  if (!ctx.userId) throw unauthorized();
  await assertRoom(ctx.userId, roomId);
  const rows = await q<any>(
    `SELECT f.id, f.kind, f.title, f.url, f.created_at, o.id AS object_id, o.content_type, o.byte_size, o.scan_status, o.original_name
     FROM connection_room_files f LEFT JOIN stored_objects o ON o.id=f.object_id WHERE f.room_id=$1 ORDER BY f.created_at DESC`,
    [roomId],
  );
  return {
    files: rows.map((r) => ({
      id: r.id,
      kind: r.kind,
      title: r.title,
      createdAt: r.created_at,
      ...(r.kind === "link" ? { url: r.url } : objectView({ id: r.object_id, content_type: r.content_type, byte_size: r.byte_size, scan_status: r.scan_status, original_name: r.original_name })),
    })),
  };
}

export async function deleteRoomFile(ctx: Ctx, roomId: string, fileId: string) {
  if (!ctx.userId) throw unauthorized();
  await assertRoom(ctx.userId, roomId);
  const f = await one<{ object_id: string | null }>("DELETE FROM connection_room_files WHERE id=$1 AND room_id=$2 RETURNING object_id", [fileId, roomId]);
  if (!f) throw notFound("file");
  if (f.object_id) await deleteStoredObject(f.object_id);
  return { ok: true };
}
