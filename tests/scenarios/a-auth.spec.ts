// A. 인증·세션 (S-001 ~ S-010)
import { expect, test } from "@playwright/test";
import { BASE, CONSENTS, anon, db, signup, uniq } from "./helpers";

test("S-001 잘못된 이메일 형식은 400", async () => {
  const api = await anon();
  const r = await api.post("/api/v1/auth/otp", { data: { email: "not-an-email" } });
  expect(r.status()).toBe(400);
  expect((await r.json()).code).toBe("invalid_email");
});

test("S-002 틀린 코드는 400, 세션 없음", async () => {
  const api = await anon();
  const email = `w${uniq()}@scn.test`;
  await api.post("/api/v1/auth/otp", { data: { email } });
  const r = await api.post("/api/v1/auth/verify", { data: { email, code: "000001", consents: CONSENTS } });
  expect(r.status()).toBe(400);
  expect((await api.get("/api/v1/me")).status()).toBe(401);
});

test("S-003 신규 가입은 필수 동의 없이 불가(422), OTP는 소모되지 않음", async () => {
  const api = await anon();
  const email = `c${uniq()}@scn.test`;
  const { devCode } = await (await api.post("/api/v1/auth/otp", { data: { email } })).json();
  const r = await api.post("/api/v1/auth/verify", { data: { email, code: devCode, consents: [] } });
  expect(r.status()).toBe(422);
  expect((await r.json()).details.missing).toEqual(["terms", "privacy", "age_14"]);
  const ok = await api.post("/api/v1/auth/verify", { data: { email, code: devCode, consents: CONSENTS } });
  expect(ok.status()).toBe(200);
});

test("S-004 가입 시 httpOnly·SameSite 세션 쿠키 발급, 토큰 평문 미저장", async () => {
  const api = await anon();
  const email = `k${uniq()}@scn.test`;
  const { devCode } = await (await api.post("/api/v1/auth/otp", { data: { email } })).json();
  const r = await api.post("/api/v1/auth/verify", { data: { email, code: devCode, consents: CONSENTS } });
  const cookie = r.headers()["set-cookie"]!;
  expect(cookie).toMatch(/lk_session=/);
  expect(cookie).toMatch(/HttpOnly/i);
  expect(cookie).toMatch(/SameSite=lax/i);
  const token = cookie.match(/lk_session=([^;]+)/)![1]!;
  const leak = await db.query("SELECT 1 FROM auth_sessions WHERE refresh_hash=$1", [token]);
  expect(leak.rowCount).toBe(0);
});

test("S-005 쿠키 없이 보호 API 호출은 401 + 표준 Error 스키마", async () => {
  const api = await anon();
  const r = await api.get("/api/v1/contacts");
  expect(r.status()).toBe(401);
  const b = await r.json();
  expect(b).toMatchObject({ code: "unauthorized" });
  expect(b.traceId).toBeTruthy();
});

test("S-006 로그아웃 후 같은 쿠키로 접근 불가", async () => {
  const u = await signup();
  expect((await u.api.get("/api/v1/me")).status()).toBe(200);
  await u.api.post("/api/v1/auth/logout", { data: {} });
  expect((await u.api.get("/api/v1/me")).status()).toBe(401);
});

test("S-007 OTP 무차별 대입: 5회 실패 후 올바른 코드도 거부", async () => {
  const api = await anon();
  const email = `b${uniq()}@scn.test`;
  const { devCode } = await (await api.post("/api/v1/auth/otp", { data: { email } })).json();
  const wrong = devCode === "123456" ? "654321" : "123456";
  for (let i = 0; i < 5; i++) await api.post("/api/v1/auth/verify", { data: { email, code: wrong, consents: CONSENTS } });
  const r = await api.post("/api/v1/auth/verify", { data: { email, code: devCode, consents: CONSENTS } });
  expect(r.status()).toBe(400);
});

test("S-008 다른 출처(Origin)의 변경 요청은 403 (CSRF)", async () => {
  const u = await signup();
  const r = await u.api.post("/api/v1/contacts", { data: { fullName: "x" }, headers: { origin: "https://evil.example" } });
  expect(r.status()).toBe(403);
  expect((await r.json()).code).toBe("bad_origin");
});

test("S-009 JSON이 아닌 본문(form)은 415", async () => {
  const u = await signup();
  const r = await u.api.post("/api/v1/contacts", { form: { fullName: "x" } });
  expect(r.status()).toBe(415);
});

test("S-010 다른 기기 세션 목록 확인 후 원격 로그아웃", async () => {
  const email = `d${uniq()}@scn.test`;
  const a = await signup(email);
  const b = await anon();
  const { devCode } = await (await b.post("/api/v1/auth/otp", { data: { email } })).json();
  await b.post("/api/v1/auth/verify", { data: { email, code: devCode, consents: [] } });
  const { devices } = await (await a.api.get("/api/v1/me/devices")).json();
  expect(devices.length).toBe(2);
  const bMe = await (await b.get("/api/v1/me")).json();
  expect(bMe.user.id).toBe(a.id);
  for (const d of devices) await a.api.delete(`/api/v1/me/devices/${d.id}`);
  expect((await b.get("/api/v1/me")).status()).toBe(401);
  expect(BASE).toContain("localhost");
});
