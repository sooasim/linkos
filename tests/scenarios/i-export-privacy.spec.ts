// I. 내보내기 · 개인정보 · 연동 (S-087 ~ S-094)
import { expect, test } from "@playwright/test";
import { db, signup } from "./helpers";

async function withContacts() {
  const u = await signup();
  await u.api.post("/api/v1/contacts", { data: { fullName: "=HYPERLINK(\"http://x\")", email: "a@b.kr", phone: "010-7777-8888", tags: ["vip"] } });
  return u;
}
async function exportAs(u: Awaited<ReturnType<typeof signup>>, format: string, fields = ["fullName", "email"]) {
  const job = await (await u.api.post("/api/v1/exports", { data: { format, fields } })).json();
  return u.api.get(job.downloadUrl);
}

test("S-087 CSV: 수식 주입 방지 + 선택 필드만 + UTF-8 BOM", async () => {
  const u = await withContacts();
  const body = await (await exportAs(u, "csv")).body();
  const t = body.toString("utf8");
  expect(body[0]).toBe(0xef);
  expect(t).toContain("'=HYPERLINK");
  expect(t).not.toContain("010-7777-8888");
});

test("S-088 Excel(XLSX) 파일은 유효한 OOXML(zip)", async () => {
  const r = await exportAs(await withContacts(), "xlsx");
  expect(r.headers()["content-type"]).toContain("spreadsheetml");
  expect((await r.body()).subarray(0, 2).toString()).toBe("PK");
});

test("S-089 Word(DOCX) 파일은 유효한 OOXML(zip)", async () => {
  const r = await exportAs(await withContacts(), "docx");
  expect(r.headers()["content-type"]).toContain("wordprocessingml");
  expect((await r.body()).subarray(0, 2).toString()).toBe("PK");
});

test("S-090 JSON/TXT/vCard 내보내기", async () => {
  const u = await withContacts();
  expect(JSON.parse(await (await exportAs(u, "json")).text())[0].email).toBe("a@b.kr");
  expect(await (await exportAs(u, "txt")).text()).toContain("email: a@b.kr");
  expect(await (await exportAs(u, "vcard", ["fullName", "email"])).text()).toContain("BEGIN:VCARD");
});

test("S-091 남의 내보내기 파일은 다운로드 불가(404)", async () => {
  const a = await withContacts();
  const job = await (await a.api.post("/api/v1/exports", { data: { format: "csv", fields: ["fullName"] } })).json();
  const b = await signup();
  expect((await b.api.get(job.downloadUrl)).status()).toBe(404);
});

test("S-092 내 데이터 내보내기는 내 것만 포함", async () => {
  const a = await withContacts();
  const b = await signup();
  await b.api.post("/api/v1/contacts", { data: { fullName: "B의연락처" } });
  const r = await a.api.post("/api/v1/me/privacy/export", { data: {} });
  expect(r.status()).toBe(202);
  const t = await r.text();
  expect(t).toContain("HYPERLINK");
  expect(t).not.toContain("B의연락처");
});

test("S-093 계정 삭제 요청 즉시 로그아웃·교환 링크 중지, 감사로그 기록", async () => {
  const u = await signup();
  const r = await u.api.post("/api/v1/me/privacy/delete", { data: {} });
  expect(r.status()).toBe(202);
  expect((await u.api.get("/api/v1/me")).status()).toBe(401);
  const a = await db.query("SELECT 1 FROM audit_logs WHERE actor_user_id=$1 AND action='privacy.delete_requested'", [u.id]);
  expect(a.rowCount).toBe(1);
});

test("S-094 Google 미설정 서버에서 연결 시도는 503으로 명확히 안내", async () => {
  const u = await signup();
  const r = await u.api.post("/api/v1/integrations/google/connect", { data: { purpose: "sheets" } });
  expect(r.status()).toBe(503);
  expect((await r.json()).code).toBe("google_not_configured");
  const s = await (await u.api.get("/api/v1/integrations")).json();
  expect(s.googleConfigured).toBe(false);
});
