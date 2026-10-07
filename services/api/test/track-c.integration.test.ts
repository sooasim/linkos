// Track C integration tests (real PostgreSQL): F-019 encrypted originals + retention, F-172 upload scanning,
// F-024 profile media ACL, F-156 room files, F-014/F-144 badge → event lead, F-178/F-179 idempotent commit,
// F-081~F-086 recording → STT (Google v2 / Whisper fakes) → diarized transcript → evidence-linked suggestions.
import { generateKeyPairSync } from "node:crypto";
import { mkdtemp, readdir, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import sharp from "sharp";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { startFakeClamd, startFakeS3, startFakeStt } from "./fakeTrackC";

process.env.DATABASE_URL ??= "postgres://linkos:linkos@localhost:5432/linkos_test_c";
process.env.RATE_LIMIT_DISABLED = "1";
process.env.APP_ORIGIN = "https://linkos.test";
process.env.LLM_DISABLED = "1";
delete process.env.OBJECT_STORAGE_BUCKET;
delete process.env.OBJECT_STORAGE_DRIVER;
delete process.env.CLAMAV_HOST;
delete process.env.STT_PROVIDER;
const storageDir = await mkdtemp(join(tmpdir(), "linkos-objects-"));
process.env.OBJECT_STORAGE_LOCAL_DIR = storageDir;

const api = await import("../src/index");
const { migrate } = await import("../src/migrate");
const { sealObject, openObject } = await import("../src/lib/storage");
const { inspectUpload, sniffType } = await import("../src/lib/filescan");
const { capture, card, connection, event, files, identity, meeting, recording, relationship, withIdempotency, closePool, q, one } = api;

const ctx = (userId: string | null) => ({ userId, ip: "10.0.0.3", userAgent: "vitest", requestId: "t" });
const consents = [
  { type: "terms" as const, granted: true },
  { type: "privacy" as const, granted: true },
  { type: "age_14" as const, granted: true },
];
async function signUp(email: string) {
  const { devCode } = await identity.requestOtp(ctx(null), email);
  return (await identity.verifyOtp(ctx(null), email, devCode!, consents)).user;
}
const baseProfile = {
  company: null, jobTitle: null, headline: null, bioShort: null, bioLong: null, keywords: [], industries: [], regions: [],
  theme: "ink" as const, matchingOptIn: true, deep: {}, fields: [], offers: [], needs: [], variants: [],
};

const jpegWithGps = () =>
  sharp({ create: { width: 64, height: 40, channels: 3, background: "#f4f1ea" } })
    .withExif({ IFD0: { Make: "LeakyPhone", Copyright: "SECRET-GPS-37.5665" } })
    .jpeg()
    .toBuffer();
const png = () => sharp({ create: { width: 20, height: 20, channels: 4, background: "#c8f03c" } }).png().toBuffer();
const pdf = (extra = "") => Buffer.from(`%PDF-1.4\n1 0 obj << /Type /Catalog ${extra} >> endobj\ntrailer << /Root 1 0 R >>\n%%EOF\n`);
const webm = (script: number, pad = 64) => Buffer.concat([Buffer.from([0x1a, 0x45, 0xdf, 0xa3, script]), Buffer.alloc(pad, 0x42)]);
const urlParams = (u: string) => {
  const x = new URL(u, "https://linkos.test");
  return { id: x.pathname.split("/").pop()!, exp: x.searchParams.get("exp"), sig: x.searchParams.get("sig") };
};

let owner: { id: string };
let other: { id: string };

beforeAll(async () => {
  await migrate();
  await q("TRUNCATE users, organizations, companies, exchange_sessions, outbox_events, audit_logs, rate_limits, idempotency_keys, otp_codes, events, deletion_requests, stored_objects CASCADE");
  owner = await signUp("trackc-owner@test.io");
  other = await signUp("trackc-other@test.io");
});
afterAll(async () => {
  await closePool();
  await rm(storageDir, { recursive: true, force: true });
});

describe("F-019 envelope encryption", () => {
  it("encrypts per object, binds the object key, and detects tampering", () => {
    const plain = Buffer.from("명함 원본 bytes");
    const s = sealObject("card-image/2026/10/a", plain);
    expect(s.ciphertext.includes(plain)).toBe(false);
    expect(openObject("card-image/2026/10/a", s).equals(plain)).toBe(true);
    expect(() => openObject("card-image/2026/10/b", s)).toThrow();
    const bad = Buffer.from(s.ciphertext);
    bad[0] = bad[0]! ^ 1;
    expect(() => openObject("card-image/2026/10/a", { ...s, ciphertext: bad })).toThrow();
    // two seals of the same plaintext never share a data key / ciphertext
    expect(sealObject("k/x/y", plain).wrappedKey.equals(sealObject("k/x/y", plain).wrappedKey)).toBe(false);
  });
});

describe("F-172 upload inspection", () => {
  it("checks magic bytes and size, re-encodes images (EXIF/GPS stripped), quarantines active PDFs and EICAR", async () => {
    await expect(inspectUpload("card_image", Buffer.from("<script>alert(1)</script> pretending to be a jpeg"))).rejects.toMatchObject({ status: 415 });
    await expect(inspectUpload("card_image", await png().then((b) => Buffer.concat([b]))).then((r) => r.contentType)).resolves.toBe("image/png");
    await expect(inspectUpload("recording_part", Buffer.alloc(12 * 1024 * 1024 + 1, 1))).rejects.toMatchObject({ status: 413, code: "file_too_large" });
    await expect(inspectUpload("card_image", pdf())).rejects.toMatchObject({ code: "unsupported_file_type" });
    expect(sniffType(webm(0))).toBe("audio/webm");

    const src = await jpegWithGps();
    expect((await sharp(src).metadata()).exif).toBeTruthy();
    const r = await inspectUpload("card_image", src);
    expect(r.sanitized).toBe(true);
    expect((await sharp(r.bytes).metadata()).exif).toBeUndefined();
    expect(r.bytes.includes(Buffer.from("SECRET-GPS"))).toBe(false);

    const js = await inspectUpload("room_file", pdf("/OpenAction << /S /JavaScript /JS (app.alert(1)) >>"));
    expect(js.scanStatus).toBe("quarantined");
    expect(js.detail).toContain("pdf_active_content");
    const eicar = await inspectUpload("room_file", pdf("% X5O!P%@AP[4\\PZX54(P^)7CC)7}$EICAR-STANDARD-ANTIVIRUS-TEST-FILE!$H+H*"));
    expect(eicar.scanStatus).toBe("quarantined");
    expect((await inspectUpload("room_file", pdf())).scanStatus).toBe("clean");
  });

  it("uses clamd over TCP when CLAMAV_HOST is set; fails closed only when CLAMAV_REQUIRED=1", async () => {
    const clamd = await startFakeClamd();
    process.env.CLAMAV_HOST = clamd.host;
    process.env.CLAMAV_PORT = String(clamd.port);
    try {
      const clean = await inspectUpload("profile_media", pdf());
      expect(clean).toMatchObject({ scanStatus: "clean" });
      expect(clean.engine).toContain("clamav");
      const bad = await inspectUpload("profile_media", pdf("% EVIL-PAYLOAD"));
      expect(bad).toMatchObject({ scanStatus: "quarantined", detail: "clamav:Eicar-Test-Signature" });
      expect(clamd.scans).toBe(2);
    } finally {
      await clamd.close();
    }
    // scanner down: stored as 'unscanned' (default) or rejected with 503 when required
    expect((await inspectUpload("profile_media", pdf())).scanStatus).toBe("unscanned");
    process.env.CLAMAV_REQUIRED = "1";
    await expect(inspectUpload("profile_media", pdf())).rejects.toMatchObject({ status: 503 });
    delete process.env.CLAMAV_REQUIRED;
    delete process.env.CLAMAV_HOST;
    delete process.env.CLAMAV_PORT;
  });
});

describe("F-019 명함 원본 보관 (opt-in), signed URLs, retention", () => {
  it("stores the original encrypted on disk, serves it via a short-lived signed URL and purges after retention", async () => {
    const job = await capture.captureBusinessCard(ctx(owner.id), { side: "front", kind: "card", engine: "test", lines: [{ text: "홍길동 대표" }, { text: "hong@linkos.test" }] });
    await expect(files.attachCardImage(ctx(other.id), job.id, "front", await jpegWithGps())).rejects.toMatchObject({ status: 404 });
    const att = await files.attachCardImage(ctx(owner.id), job.id, "front", await jpegWithGps());
    expect(att.scanStatus).toBe("clean");
    expect(att.retentionUntil).toBeTruthy();

    // ciphertext on disk only
    const row = await one<{ object_key: string; wrapped_key: Buffer }>("SELECT object_key, wrapped_key FROM stored_objects WHERE id=$1", [att.id]);
    const onDisk = await readFile(join(storageDir, row!.object_key));
    expect(onDisk.subarray(0, 3).equals(Buffer.from([0xff, 0xd8, 0xff]))).toBe(false);
    expect(row!.wrapped_key.length).toBeGreaterThan(32);

    const { id, exp, sig } = urlParams(att.url!);
    const dl = await files.downloadSigned(id, exp, sig);
    expect(dl.contentType).toBe("image/jpeg");
    expect(sniffType(dl.bytes)).toBe("image/jpeg");
    await expect(files.downloadSigned(id, exp, `${sig!.slice(0, -1)}0`)).rejects.toMatchObject({ status: 403 });
    const old = urlParams(files.signedFileUrl(id, 60, Date.now() - 3600_000));
    await expect(files.downloadSigned(old.id, old.exp, old.sig)).rejects.toMatchObject({ status: 410 });

    const listed = await files.listCardImages(ctx(owner.id), job.id);
    expect(listed.images).toHaveLength(1);
    expect(listed.images[0]).toMatchObject({ side: "front", contentType: "image/jpeg" });

    // replacing the image deletes the previous object
    const att2 = await files.attachCardImage(ctx(owner.id), job.id, "front", await jpegWithGps());
    expect(await one("SELECT 1 FROM stored_objects WHERE id=$1", [att.id])).toBeNull();

    await q("UPDATE stored_objects SET retention_until = now() - interval '1 day' WHERE id=$1", [att2.id]);
    expect(await files.purgeExpiredObjects()).toBe(1);
    expect(await one("SELECT 1 FROM stored_objects WHERE id=$1", [att2.id])).toBeNull();
    expect((await one<{ front_object_id: string | null }>("SELECT front_object_id FROM business_cards WHERE id=$1", [job.id]))!.front_object_id).toBeNull();
    const left = await readdir(storageDir, { recursive: true });
    expect(left.some((f) => String(f).endsWith(row!.object_key.split("/").pop()!))).toBe(false);
  });

  it("works against an S3-compatible endpoint (SigV4-signed, ciphertext only)", async () => {
    const s3 = await startFakeS3();
    Object.assign(process.env, { OBJECT_STORAGE_DRIVER: "s3", OBJECT_STORAGE_BUCKET: "linkos-test", OBJECT_STORAGE_ENDPOINT: s3.url, OBJECT_STORAGE_ACCESS_KEY_ID: "AKIDTEST", OBJECT_STORAGE_SECRET_ACCESS_KEY: "secret", OBJECT_STORAGE_REGION: "us-east-1" });
    try {
      const obj = await files.storeObject({ ownerUserId: owner.id, purpose: "room_file", bytes: pdf(), filename: "deck.pdf" });
      const key = (await one<{ object_key: string; driver: string }>("SELECT object_key, driver FROM stored_objects WHERE id=$1", [obj.id]))!;
      expect(key.driver).toBe("s3");
      const stored = s3.objects.get(`linkos-test/${key.object_key}`)!;
      expect(stored).toBeTruthy();
      expect(stored.includes(Buffer.from("%PDF"))).toBe(false);
      expect(s3.signed).toBeGreaterThan(0);
      expect((await files.readObjectBytes(obj.id)).bytes.equals(pdf())).toBe(true);
      await files.deleteStoredObject(obj.id);
      expect(s3.objects.size).toBe(0);
    } finally {
      for (const k of ["OBJECT_STORAGE_DRIVER", "OBJECT_STORAGE_BUCKET", "OBJECT_STORAGE_ENDPOINT", "OBJECT_STORAGE_ACCESS_KEY_ID", "OBJECT_STORAGE_SECRET_ACCESS_KEY", "OBJECT_STORAGE_REGION"]) delete process.env[k];
      await s3.close();
    }
  });
});

describe("F-024 딥 프로필 미디어 (field ACL)", () => {
  it("serves media by audience; quarantined files are never listed to others", async () => {
    const p = await card.saveProfile(ctx(owner.id), { ...baseProfile, name: "미디어 오너" });
    const img = await files.addProfileMedia(ctx(owner.id), p.id, await png(), { title: "포트폴리오", visibility: "trusted" }, "p.png");
    await files.addProfileMedia(ctx(owner.id), p.id, pdf(), { title: "회사소개서", visibility: "public" }, "intro.pdf");
    await files.addProfileMedia(ctx(owner.id), p.id, pdf("/JS (x)"), { title: "매크로", visibility: "public" }, "bad.pdf");
    await expect(files.addProfileMedia(ctx(other.id), p.id, await png(), { title: "x", visibility: "public" })).rejects.toMatchObject({ status: 404 });

    const anon = await files.listProfileMedia(p.id, null);
    expect(anon.audience).toBe("public");
    expect(anon.media.map((m) => m.title)).toEqual(["회사소개서"]);
    expect(anon.hidden).toBe(2);
    expect(anon.media[0]!.url).toMatch(/^\/api\/v1\/files\//);
    const mine = await files.listProfileMedia(p.id, owner.id);
    expect(mine.media).toHaveLength(3);
    expect(mine.media.find((m) => m.title === "매크로")!.url).toBeNull();
    // approved access request → trusted
    await q("INSERT INTO access_requests (requester_user_id, target_profile_id, requested_fields, status) VALUES ($1,$2,'{}','approved')", [other.id, p.id]);
    expect((await files.listProfileMedia(p.id, other.id)).media.map((m) => m.title).sort()).toEqual(["포트폴리오", "회사소개서"]);
    await files.deleteProfileMedia(ctx(owner.id), p.id, img.id);
    expect((await files.listProfileMedia(p.id, owner.id)).media).toHaveLength(2);
  });
});

describe("F-156 Connection Room 공유 파일", () => {
  it("shares files and links inside the room only", async () => {
    const a = await relationship.createContact(ctx(owner.id), { fullName: "가나다", source: "manual", provenance: {} } as any);
    const b = await relationship.createContact(ctx(owner.id), { fullName: "라마바", source: "manual", provenance: {} } as any);
    const intro = await connection.createIntroduction(ctx(owner.id), { partyAContactId: a.contactId, partyBContactId: b.contactId, reason: "협업" });
    await connection.recordIntroConsent(ctx(owner.id), intro.id, "a", true);
    const done = await connection.recordIntroConsent(ctx(owner.id), intro.id, "b", true);
    const roomId = done.roomId!;
    const f = await files.addRoomFile(ctx(owner.id), roomId, pdf(), "제안서", "proposal.pdf");
    await files.addRoomLink(ctx(owner.id), roomId, { title: "데모", url: "demo.linkos.test/x" });
    await expect(files.addRoomLink(ctx(owner.id), roomId, { title: "x", url: "javascript:alert(1)" })).rejects.toMatchObject({ code: "invalid_url" });
    await expect(files.addRoomFile(ctx(other.id), roomId, pdf(), "x")).rejects.toMatchObject({ status: 404 });
    const list = await files.listRoomFiles(ctx(owner.id), roomId);
    expect(list.files.map((x: any) => [x.kind, x.title])).toEqual([["link", "데모"], ["file", "제안서"]]);
    expect((list.files[0] as any).url).toBe("https://demo.linkos.test/x");
    const room = await connection.getConnectionRoom(ctx(owner.id), roomId);
    expect(room.messages.some((m: any) => m.body === "파일 공유: 제안서")).toBe(true);
    await files.deleteRoomFile(ctx(owner.id), roomId, f.id);
    expect((await files.listRoomFiles(ctx(owner.id), roomId)).files).toHaveLength(1);
  });
});

describe("F-014/F-144 badge → event lead, F-178/F-179 idempotent offline commit", () => {
  it("commits a badge scan + reviewed contact atomically as an event lead, exactly once per Idempotency-Key", async () => {
    await card.saveProfile(ctx(owner.id), { ...baseProfile, name: "행사 주최자" });
    const ev = await event.createEvent(ctx(owner.id), { name: "AI Summit 2026" });
    const lines = [
      { text: "AI SUMMIT 2026", confidence: 90, bbox: { x0: 0, y0: 0, x1: 300, y1: 30 } },
      { text: "Jane Doe", confidence: 95, bbox: { x0: 0, y0: 60, x1: 300, y1: 130 } },
      { text: "Acme Labs Inc.", confidence: 90, bbox: { x0: 0, y0: 150, x1: 300, y1: 180 } },
      { text: "EXHIBITOR", confidence: 95, bbox: { x0: 0, y0: 220, x1: 300, y1: 260 } },
    ];
    const job = await capture.captureBusinessCard(ctx(owner.id), { side: "front", kind: "badge", engine: "test", lines });
    expect(job.draft.fullName).toBe("Jane Doe");
    expect(job.draft.company).toBe("Acme Labs Inc.");
    expect(job.badgeType).toBe("EXHIBITOR");

    const body = {
      capture: { side: "front" as const, kind: "badge" as const, engine: "test", lines },
      contact: { fullName: "Jane Doe", company: "Acme Labs Inc.", source: "manual" as const, provenance: { fullName: { source: "ocr", confidence: 0.9 } } },
      eventId: ev.id,
    };
    const input = capture.commitInput.parse(body);
    const run = () => withIdempotency(`commit:${owner.id}`, "offline-key-1", body, async () => ({ status: 201, body: await capture.commitCapture(ctx(owner.id), input) }));
    const r1 = await run();
    const r2 = await run();
    expect(r2.replayed).toBe(true);
    expect(r2.body.contactId).toBe(r1.body.contactId);
    expect((await q("SELECT id FROM contacts WHERE owner_user_id=$1 AND full_name='Jane Doe'", [owner.id])).length).toBe(1);
    const bc = await one<{ kind: string; event_id: string; contact_id: string }>("SELECT kind, event_id, contact_id FROM business_cards WHERE id=$1", [r1.body.captureId]);
    expect(bc).toMatchObject({ kind: "badge", event_id: ev.id, contact_id: r1.body.contactId });
    const detail = await event.getEvent(ctx(owner.id), ev.id);
    expect(detail.leads.map((l: any) => l.fullName)).toContain("Jane Doe");
    expect(r1.body.contact.source).toBe("event");
    // not an attendee → no lead
    await expect(capture.commitCapture(ctx(other.id), input)).rejects.toMatchObject({ status: 404 });
  });

  it("returns 409 version_conflict with the server copy for stale offline edits (conflict UI input)", async () => {
    const c = await relationship.createContact(ctx(owner.id), { fullName: "충돌 테스트", source: "manual", provenance: {} } as any);
    await relationship.updateContact(ctx(owner.id), c.contactId, { jobTitle: "서버에서 수정", version: 1 });
    await expect(relationship.updateContact(ctx(owner.id), c.contactId, { jobTitle: "오프라인 수정", version: 1 })).rejects.toMatchObject({
      status: 409,
      code: "version_conflict",
      details: { serverVersion: 2, current: { jobTitle: "서버에서 수정" } },
    });
  });
});

describe("F-081~F-086 회의 녹음 → 전사 → 화자분리 → 근거 연결 제안", () => {
  let stt: Awaited<ReturnType<typeof startFakeStt>>;
  beforeAll(async () => {
    stt = await startFakeStt();
  });
  afterAll(async () => {
    for (const k of ["STT_PROVIDER", "GOOGLE_STT_ENDPOINT", "GOOGLE_STT_PROJECT", "GOOGLE_STT_CREDENTIALS_JSON", "WHISPER_API_URL", "WHISPER_API_KEY"]) delete process.env[k];
    await stt.close();
  });

  async function consentedMeeting(title: string) {
    const m = await meeting.saveMeeting(ctx(owner.id), meeting.meetingInput.parse({ title }));
    await meeting.setRecordingConsent(ctx(owner.id), m.id, { ownerConsent: true, participantsAcknowledged: true, policy: "all_party" });
    return m;
  }

  it("Google STT v2 (service-account JWT): parts → diarized segments with offsets → transcript.ready → suggestions with evidence", async () => {
    const { privateKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
    Object.assign(process.env, {
      STT_PROVIDER: "google",
      GOOGLE_STT_ENDPOINT: stt.url,
      GOOGLE_STT_PROJECT: "linkos-test",
      GOOGLE_STT_CREDENTIALS_JSON: JSON.stringify({ client_email: "stt@linkos-test.iam.gserviceaccount.com", private_key: privateKey.export({ type: "pkcs8", format: "pem" }), token_uri: `${stt.url}/token` }),
    });
    const m0 = await meeting.saveMeeting(ctx(owner.id), meeting.meetingInput.parse({ title: "동의 없음" }));
    await expect(meeting.createRecording(ctx(owner.id), m0.id)).rejects.toMatchObject({ code: "recording_consent_required" });

    const m = await consentedMeeting("파일럿 논의");
    const rec = await meeting.createRecording(ctx(owner.id), m.id, { mimeType: "audio/webm;codecs=opus" });
    expect(rec).toMatchObject({ status: "recording", transcription: "google-stt-v2" });
    await expect(recording.uploadPart(ctx(owner.id), m.id, rec.id, 0, Buffer.from("not audio at all, really"), { offsetMs: 0 })).rejects.toMatchObject({ status: 415 });
    await expect(recording.uploadPart(ctx(other.id), m.id, rec.id, 0, webm(0), { offsetMs: 0 })).rejects.toMatchObject({ status: 404 });
    expect(await recording.uploadPart(ctx(owner.id), m.id, rec.id, 0, webm(0), { offsetMs: 0, durationMs: 50_000 })).toMatchObject({ duplicate: false });
    expect(await recording.uploadPart(ctx(owner.id), m.id, rec.id, 0, webm(0), { offsetMs: 0 })).toMatchObject({ duplicate: true });

    // parts are transcribed while recording continues
    expect(await recording.processTranscriptions()).toBe(1);
    await recording.uploadPart(ctx(owner.id), m.id, rec.id, 1, webm(1), { offsetMs: 50_000, durationMs: 3000 });
    const fin = await recording.finalizeRecording(ctx(owner.id), m.id, rec.id, { durationSeconds: 53 });
    expect(fin).toMatchObject({ status: "transcribing", parts: 2 });
    await expect(recording.uploadPart(ctx(owner.id), m.id, rec.id, 2, webm(1), { offsetMs: 53_000 })).rejects.toMatchObject({ code: "recording_closed" });
    expect(await recording.processTranscriptions()).toBe(1);

    expect(stt.calls.token).toBe(1);
    expect(stt.lastAuth).toBe("Bearer fake-sa-token");
    expect(stt.lastGoogleBody.config.features.diarizationConfig).toEqual({ minSpeakerCount: 1, maxSpeakerCount: 6 });
    expect(stt.lastGoogleBody.config.languageCodes).toEqual(["ko-KR", "en-US"]);

    const t = await recording.getTranscript(ctx(owner.id), m.id);
    expect(t.recordings[0]).toMatchObject({ status: "analyzed", parts: 2, partsDone: 2, language: "ko-kr", provider: "google-stt-v2" });
    expect(t.segments.map((s) => [s.speaker, s.text])).toEqual([
      ["S1", "오늘 회의 감사합니다. 3개 병원 파일럿으로 진행하기로 했습니다."],
      ["S2", "제가 제안서를 금요일까지 보내드리겠습니다."],
      ["S1", "다음 주 화요일에 다시 뵙겠습니다."],
    ]);
    expect(t.segments[1]).toMatchObject({ startMs: 4600, endMs: 7200 });
    expect(t.segments[2]!.startMs).toBe(50_200); // part offset applied

    const ready = await q<any>("SELECT payload FROM outbox_events WHERE event_type='meeting.transcript.ready' AND aggregate_id=$1", [m.id]);
    expect(ready).toHaveLength(1);
    expect(ready[0].payload).toEqual({ meeting_id: m.id, transcript_ref: rec.id });

    const full = await meeting.getMeeting(owner.id, m.id);
    const promiseSeg = t.segments[1]!.id;
    expect(full.suggestedActions).toHaveLength(1);
    expect(full.suggestedActions[0]).toMatchObject({ description: "제가 제안서를 금요일까지 보내드리겠습니다.", dueHint: "금요일", provenance: "rules", sourceSegmentIds: [promiseSeg] });
    expect(full.ai.decisions[0]).toMatchObject({ text: "3개 병원 파일럿으로 진행하기로 했습니다.", segmentIds: [t.segments[0]!.id] });
    expect(full.actionItems).toHaveLength(0);

    // saving the card never drops pending suggestions; confirming promotes one to an open To-do with its evidence
    await meeting.saveMeeting(ctx(owner.id), meeting.meetingInput.parse({ title: "파일럿 논의", decisions: ["파일럿"] }), m.id);
    expect((await meeting.getMeeting(owner.id, m.id)).suggestedActions).toHaveLength(1);
    await recording.confirmSuggestedAction(ctx(owner.id), m.id, full.suggestedActions[0]!.id, true, { dueAt: "2026-10-09T09:00:00.000Z" });
    const after = await meeting.getMeeting(owner.id, m.id);
    expect(after.suggestedActions).toHaveLength(0);
    expect(after.actionItems[0]).toMatchObject({ status: "open", sourceSegmentIds: [promiseSeg], provenance: "rules" });
    await expect(recording.confirmSuggestedAction(ctx(owner.id), m.id, full.suggestedActions[0]!.id, false)).rejects.toMatchObject({ status: 404 });

    // consent withdrawn → no further uploads
    const rec2 = await meeting.createRecording(ctx(owner.id), m.id);
    await meeting.setRecordingConsent(ctx(owner.id), m.id, { ownerConsent: false, participantsAcknowledged: true, policy: "all_party" });
    await expect(recording.uploadPart(ctx(owner.id), m.id, rec2.id, 0, webm(0), { offsetMs: 0 })).rejects.toMatchObject({ code: "recording_consent_required" });
  });

  it("Whisper-compatible adapter: speaker labels + language, rule-based suggestions grounded in segments", async () => {
    Object.assign(process.env, { STT_PROVIDER: "whisper", WHISPER_API_URL: `${stt.url}/v1`, WHISPER_API_KEY: "sk-test" });
    const m = await consentedMeeting("견적 논의");
    const rec = await meeting.createRecording(ctx(owner.id), m.id);
    await recording.uploadPart(ctx(owner.id), m.id, rec.id, 0, webm(0), { offsetMs: 0 });
    await recording.finalizeRecording(ctx(owner.id), m.id, rec.id, { durationSeconds: 6 });
    await recording.processTranscriptions();
    expect(stt.lastAuth).toBe("Bearer sk-test");
    const t = await recording.getTranscript(ctx(owner.id), m.id);
    expect(t.segments.map((s) => s.speaker)).toEqual(["SPEAKER_00", "SPEAKER_01"]);
    expect(t.recordings[0]!.language).toBe("korean");
    expect(t.segments[0]!.confidence).toBeCloseTo(0.905, 2);
    const full = await meeting.getMeeting(owner.id, m.id);
    expect(full.suggestedActions.map((a: any) => [a.description, a.dueHint])).toEqual([["견적서는 내일까지 보내드리겠습니다.", "내일"]]);
    expect(full.ai.decisions.map((d: any) => d.text)).toContain("결정: 2차 미팅 진행.");
  });

  it("without STT the recording is still stored (encrypted) and reports stt_not_configured", async () => {
    delete process.env.STT_PROVIDER;
    const m = await consentedMeeting("STT 없음");
    const rec = await meeting.createRecording(ctx(owner.id), m.id);
    expect(rec.transcription).toBeNull();
    await recording.uploadPart(ctx(owner.id), m.id, rec.id, 0, webm(0), { offsetMs: 0 });
    expect(await recording.finalizeRecording(ctx(owner.id), m.id, rec.id, {})).toMatchObject({ status: "stored" });
    expect(await recording.processTranscriptions()).toBe(0);
    expect((await recording.getTranscript(ctx(owner.id), m.id)).recordings[0]).toMatchObject({ status: "stored", error: "stt_not_configured" });
  });
});
