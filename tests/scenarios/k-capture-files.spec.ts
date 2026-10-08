// K. Track C over HTTP — F-019 원본 보관(서명 URL), F-172 업로드 검사, F-024 미디어 ACL, F-156 공유 파일, F-144 배지 리드, F-179 멱등 재전송
import { expect, test } from "@playwright/test";
import { anon, signup, withProfile } from "./helpers";

// 1x1 PNG
const PNG = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==", "base64");
const PDF = Buffer.from("%PDF-1.4\n1 0 obj << /Type /Catalog >> endobj\ntrailer << /Root 1 0 R >>\n%%EOF\n");

test("S-101 명함 원본: opt-in 업로드 → 서명 URL 다운로드, 위조 서명 403, 폼 전송(CSRF)·가짜 이미지 거부", async () => {
  const u = await signup();
  const job = await (await u.api.post("/api/v1/capture/cards", { data: { lines: [{ text: "홍길동 대표" }] } })).json();
  const up = await u.api.put(`/api/v1/capture/cards/${job.id}/images/front`, { data: PNG, headers: { "content-type": "image/png" } });
  expect(up.status()).toBe(201);
  const img = await up.json();
  expect(img.scanStatus).toBe("clean");
  const a = await anon();
  const dl = await a.get(img.url);
  expect(dl.status()).toBe(200);
  expect(dl.headers()["content-type"]).toBe("image/png");
  expect(dl.headers()["cache-control"]).toContain("no-store");
  expect((await a.get(img.url.replace(/sig=[0-9a-f]+/, "sig=" + "0".repeat(64)))).status()).toBe(403);
  // a cross-site <form> can only send safelisted types → refused
  expect((await u.api.put(`/api/v1/capture/cards/${job.id}/images/front`, { data: PNG, headers: { "content-type": "multipart/form-data; boundary=x" } })).status()).toBe(415);
  expect((await u.api.put(`/api/v1/capture/cards/${job.id}/images/front`, { data: Buffer.from("GIF-but-actually-html<script>"), headers: { "content-type": "image/gif" } })).status()).toBe(415);
  const other = await signup();
  expect((await other.api.put(`/api/v1/capture/cards/${job.id}/images/front`, { data: PNG, headers: { "content-type": "image/png" } })).status()).toBe(404);
});

test("S-102 딥 프로필 미디어: 공개 범위에 따라 비로그인에게는 public 만", async () => {
  const u = await signup();
  const p = await withProfile(u);
  expect((await u.api.post(`/api/v1/profiles/${p.id}/media?title=${encodeURIComponent("회사소개서")}&visibility=public`, { data: PDF, headers: { "content-type": "application/pdf", "x-file-name": "intro.pdf" } })).status()).toBe(201);
  expect((await u.api.post(`/api/v1/profiles/${p.id}/media?title=secret&visibility=trusted`, { data: PNG, headers: { "content-type": "image/png" } })).status()).toBe(201);
  const pub = await (await (await anon()).get(`/api/v1/profiles/${p.id}/media`)).json();
  expect(pub.media.map((m: any) => m.title)).toEqual(["회사소개서"]);
  const mine = await (await u.api.get(`/api/v1/profiles/${p.id}/media`)).json();
  expect(mine.media).toHaveLength(2);
});

test("S-103 배지 스캔 리드: 같은 Idempotency-Key 재전송은 1건만 생성", async () => {
  const u = await signup();
  await withProfile(u);
  const ev = await (await u.api.post("/api/v1/events", { data: { name: "Badge Expo" } })).json();
  const body = { capture: { kind: "badge", lines: [{ text: "EXHIBITOR" }, { text: "Jane Doe" }, { text: "Acme Labs Inc." }] }, contact: { fullName: "Jane Doe", company: "Acme Labs Inc." } };
  const h = { "idempotency-key": `lead-${Date.now()}` };
  const r1 = await u.api.post(`/api/v1/events/${ev.id}/leads`, { data: body, headers: h });
  const r2 = await u.api.post(`/api/v1/events/${ev.id}/leads`, { data: body, headers: h });
  expect(r1.status()).toBe(201);
  expect((await r2.json()).contactId).toBe((await r1.json()).contactId);
  const detail = await (await u.api.get(`/api/v1/events/${ev.id}`)).json();
  expect(detail.leads.filter((l: any) => l.fullName === "Jane Doe")).toHaveLength(1);
});
