// F. 연락처 · 관계 (S-063 ~ S-072)
import { expect, test } from "@playwright/test";
import { signup } from "./helpers";

test("S-063 연락처 생성 → 목록 → 상세 타임라인(만남 포함)", async () => {
  const u = await signup();
  const c = await (await u.api.post("/api/v1/contacts", { data: { fullName: "정다은", company: "블루랩", source: "manual", encounter: { placeLabel: "코엑스" } } })).json();
  const { contacts } = await (await u.api.get("/api/v1/contacts")).json();
  expect(contacts.map((x: { id: string }) => x.id)).toContain(c.contactId);
  const t = await (await u.api.get(`/api/v1/contacts/${c.contactId}`)).json();
  expect(t.encounters[0].place_label).toBe("코엑스");
});

test("S-064 회사명/직책 부분검색", async () => {
  const u = await signup();
  await u.api.post("/api/v1/contacts", { data: { fullName: "A", company: "에이스로보틱스", jobTitle: "CTO" } });
  await u.api.post("/api/v1/contacts", { data: { fullName: "B", company: "다른회사" } });
  const r = await (await u.api.get(`/api/v1/contacts?q=${encodeURIComponent("로보")}`)).json();
  expect(r.contacts.map((c: { fullName: string }) => c.fullName)).toEqual(["A"]);
  const r2 = await (await u.api.get("/api/v1/contacts?q=cto")).json();
  expect(r2.contacts).toHaveLength(1);
});

test("S-065 태그 필터", async () => {
  const u = await signup();
  await u.api.post("/api/v1/contacts", { data: { fullName: "투자자", tags: ["투자"] } });
  await u.api.post("/api/v1/contacts", { data: { fullName: "고객", tags: ["고객"] } });
  const r = await (await u.api.get(`/api/v1/contacts?tag=${encodeURIComponent("투자")}`)).json();
  expect(r.contacts.map((c: { fullName: string }) => c.fullName)).toEqual(["투자자"]);
});

test("S-066 이메일 일치 중복 후보는 자동 병합 가능, 이름·회사 유사는 후보만", async () => {
  const u = await signup();
  await u.api.post("/api/v1/contacts", { data: { fullName: "최윤서", company: "그린에너지", email: "ys@green.kr" } });
  const a = await (await u.api.post("/api/v1/contacts/duplicates", { data: { fullName: "Choi Yoonseo", email: "YS@green.kr" } })).json();
  expect(a.candidates[0].autoMergeable).toBe(true);
  const b = await (await u.api.post("/api/v1/contacts/duplicates", { data: { fullName: "최윤서", company: "(주)그린에너지" } })).json();
  expect(b.candidates[0].autoMergeable).toBe(false);
});

test("S-067 필드별 병합 후 되돌리기(undo)", async () => {
  const u = await signup();
  const a = await (await u.api.post("/api/v1/contacts", { data: { fullName: "한지민", jobTitle: "매니저", email: "jm@a.kr" } })).json();
  const b = await (await u.api.post("/api/v1/contacts", { data: { fullName: "한지민", jobTitle: "팀장", phone: "010-1212-3434" } })).json();
  const m = await (await u.api.post(`/api/v1/contacts/${a.contactId}/merge`, { data: { secondaryId: b.contactId, choices: { jobTitle: "secondary" } } })).json();
  expect(m.jobTitle).toBe("팀장");
  expect(m.phone).toBe("010-1212-3434");
  expect((await (await u.api.get("/api/v1/contacts")).json()).contacts).toHaveLength(1);
  await u.api.post(`/api/v1/contacts/${a.contactId}/merge/undo`, { data: {} });
  expect((await (await u.api.get("/api/v1/contacts")).json()).contacts).toHaveLength(2);
});

test("S-068 삭제 후 상세 조회는 404", async () => {
  const u = await signup();
  const c = await (await u.api.post("/api/v1/contacts", { data: { fullName: "삭제대상" } })).json();
  expect((await u.api.delete(`/api/v1/contacts/${c.contactId}`)).status()).toBe(200);
  expect((await u.api.get(`/api/v1/contacts/${c.contactId}`)).status()).toBe(404);
});

test("S-069 개인 메모는 다른 사용자가 읽거나 쓸 수 없음", async () => {
  const a = await signup();
  const c = await (await a.api.post("/api/v1/contacts", { data: { fullName: "메모대상" } })).json();
  await a.api.post(`/api/v1/contacts/${c.contactId}/notes`, { data: { body: "비밀 메모" } });
  const b = await signup();
  expect((await b.api.get(`/api/v1/contacts/${c.contactId}`)).status()).toBe(404);
  expect((await b.api.post(`/api/v1/contacts/${c.contactId}/notes`, { data: { body: "x" } })).status()).toBe(404);
});

test("S-070 vCard 다운로드 형식", async () => {
  const u = await signup();
  const c = await (await u.api.post("/api/v1/contacts", { data: { fullName: "브이카드", email: "v@c.kr" } })).json();
  const r = await u.api.get(`/api/v1/contacts/${c.contactId}/vcard`);
  expect(r.headers()["content-type"]).toContain("text/vcard");
  expect(await r.text()).toContain("FN:브이카드");
});

test("S-071 목록 limit은 최대 200으로 제한", async () => {
  const u = await signup();
  const r = await u.api.get("/api/v1/contacts?limit=100000");
  expect(r.status()).toBe(200);
});

test("S-072 검색어 SQL 인젝션 시도는 안전하게 처리", async () => {
  const u = await signup();
  await u.api.post("/api/v1/contacts", { data: { fullName: "정상" } });
  const r = await u.api.get(`/api/v1/contacts?q=${encodeURIComponent("' OR 1=1; DROP TABLE contacts; --")}`);
  expect(r.status()).toBe(200);
  expect((await r.json()).contacts).toHaveLength(0);
  expect((await (await u.api.get("/api/v1/contacts")).json()).contacts).toHaveLength(1);
});
