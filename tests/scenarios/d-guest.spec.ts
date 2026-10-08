// D. 비회원 교환 · Claim (S-036 ~ S-050) — 동시성 시뮬레이션 포함
import { expect, test } from "@playwright/test";
import { GUEST_CARD, anon, db, reply, session, signup, withProfile } from "./helpers";

async function setup() {
  const s = await signup();
  await withProfile(s);
  return { s, x: await session(s) };
}

test("S-036 비회원은 로그인 없이 3초 카드를 받는다", async () => {
  const { x } = await setup();
  const r = await (await anon()).get(`/api/v1/exchange/sessions/${x.token}`);
  expect(r.status()).toBe(200);
  const b = await r.json();
  expect(b.sender.name).toBe("홍길동");
  expect(b.acceptsReply).toBe(true);
  expect(r.headers()["cache-control"]).toContain("no-store");
});

test("S-037 게스트 랜딩에 trusted/private 값이 절대 포함되지 않음", async () => {
  const { x } = await setup();
  const t = await (await (await anon()).get(`/api/v1/exchange/sessions/${x.token}`)).text();
  expect(t).not.toContain("010-1111-2222");
  expect(t).not.toContain("PRIVATE-NOTE-XYZ");
});

test("S-038 교환 동의 없이 회신하면 400", async () => {
  const { x } = await setup();
  const r = await (await anon()).post(`/api/v1/exchange/sessions/${x.token}/reply`, { data: { card: GUEST_CARD, sharedFields: ["fullName"], consent: { exchange: false }, provenance: {} } });
  expect(r.status()).toBe(400);
});

test("S-039 보낼 항목을 하나도 고르지 않으면 400", async () => {
  const { x } = await setup();
  expect((await reply(await anon(), x.token, GUEST_CARD, [])).status()).toBe(400);
});

test("S-040 체크한 항목만 저장된다(전화번호 미선택 → 미저장)", async () => {
  const { s, x } = await setup();
  expect((await reply(await anon(), x.token)).status()).toBe(201);
  const { contacts } = await (await s.api.get("/api/v1/contacts")).json();
  expect(contacts[0].fullName).toBe("김영희");
  expect(contacts[0].email).toBe("yh@medi.test");
  expect(contacts[0].phone).toBeNull();
});

test("S-041 일회성 링크에 두 번째 회신은 409", async () => {
  const { x } = await setup();
  const api = await anon();
  await reply(api, x.token);
  const r = await reply(api, x.token);
  expect(r.status()).toBe(409);
});

test("S-042 [동시성] 같은 일회성 링크에 10명이 동시에 회신해도 정확히 1건만 성공", async () => {
  const { s, x } = await setup();
  const results = await Promise.all(Array.from({ length: 10 }, async (_, i) => (await reply(await anon(), x.token, { fullName: `동시${i}` }, ["fullName"])).status()));
  expect(results.filter((r) => r === 201)).toHaveLength(1);
  expect(results.filter((r) => r !== 201).every((r) => r === 409)).toBe(true);
  const { contacts } = await (await s.api.get("/api/v1/contacts")).json();
  expect(contacts).toHaveLength(1);
});

test("S-043 회신 후 Claim 토큰 발급, 미리보기 가능", async () => {
  const { x } = await setup();
  const api = await anon();
  const r = await (await reply(api, x.token)).json();
  expect(r.claimToken).toMatch(/^[A-Za-z0-9_-]{22,}$/);
  const p = await (await api.post("/api/v1/guest/claim/preview", { data: { claimToken: r.claimToken } })).json();
  expect(p.guest.fullName).toBe("김영희");
  expect(p.senderName).toBe("홍길동");
});

test("S-044 Claim은 로그인이 필요(401)", async () => {
  const { x } = await setup();
  const api = await anon();
  const r = await (await reply(api, x.token)).json();
  expect((await api.post("/api/v1/guest/claim", { data: { claimToken: r.claimToken } })).status()).toBe(401);
});

test("S-045 Claim하면 내 카드 생성 + 상대가 내 주소록에, 데이터 유실 없음", async () => {
  const { s, x } = await setup();
  const r = await (await reply(await anon(), x.token)).json();
  const g = await signup();
  const c = await (await g.api.post("/api/v1/guest/claim", { data: { claimToken: r.claimToken } })).json();
  expect(c.claimed).toBe(true);
  const { profiles } = await (await g.api.get("/api/v1/profiles")).json();
  expect(profiles[0].name).toBe("김영희");
  const { contacts } = await (await g.api.get("/api/v1/contacts")).json();
  expect(contacts[0].fullName).toBe("홍길동");
  const st = await (await s.api.get(`/api/v1/exchange/manage/${x.sessionId}`)).json();
  expect(st.state).toBe("CLAIMED");
});

test("S-046 같은 사용자가 다시 Claim해도 중복 생성 없음(멱등)", async () => {
  const { x } = await setup();
  const r = await (await reply(await anon(), x.token)).json();
  const g = await signup();
  await g.api.post("/api/v1/guest/claim", { data: { claimToken: r.claimToken } });
  const again = await (await g.api.post("/api/v1/guest/claim", { data: { claimToken: r.claimToken } })).json();
  expect(again.alreadyClaimed).toBe(true);
  const { contacts } = await (await g.api.get("/api/v1/contacts")).json();
  expect(contacts).toHaveLength(1);
});

test("S-047 다른 사용자가 이미 Claim한 토큰은 409", async () => {
  const { x } = await setup();
  const r = await (await reply(await anon(), x.token)).json();
  await (await signup()).api.post("/api/v1/guest/claim", { data: { claimToken: r.claimToken } });
  const third = await signup();
  expect((await third.api.post("/api/v1/guest/claim", { data: { claimToken: r.claimToken } })).status()).toBe(409);
});

test("S-048 로그인 상태로 회신하면 양쪽 관계가 즉시 생기고 Claim 토큰 없음", async () => {
  const { s, x } = await setup();
  const g = await signup();
  await withProfile(g, { name: "로그인수신자" });
  const r = await (await reply(g.api, x.token)).json();
  expect(r.claimToken).toBeNull();
  const { contacts } = await (await g.api.get("/api/v1/contacts")).json();
  expect(contacts[0].fullName).toBe("홍길동");
  const sc = (await (await s.api.get("/api/v1/contacts")).json()).contacts;
  expect(sc[0].linkedUserId).toBe(g.id);
});

test("S-049 자기 자신의 링크에 회신은 400", async () => {
  const { s, x } = await setup();
  expect((await reply(s.api, x.token)).status()).toBe(400);
});

test("S-050 비정상적으로 큰 입력은 400 (입력 길이 제한)", async () => {
  const { x } = await setup();
  const r = await reply(await anon(), x.token, { fullName: "가".repeat(1000) }, ["fullName"]);
  expect(r.status()).toBe(400);
  const left = await db.query("SELECT count(*)::int AS n FROM contacts WHERE full_name LIKE '가가가%'");
  expect(left.rows[0].n).toBe(0);
});
