// C. 교환 · Adaptive Handoff (S-021 ~ S-035)
import { expect, test } from "@playwright/test";
import { BASE, anon, db, reply, session, signup, withProfile } from "./helpers";

test("S-021 Living Card 없이 교환 시작은 422 profile_required", async () => {
  const u = await signup();
  const r = await u.api.post("/api/v1/exchange/sessions", { data: {} });
  expect(r.status()).toBe(422);
});

test("S-022 Web Share 가능 기기: OS 공유 → 단축코드 → QR(마지막)", async () => {
  const u = await signup();
  await withProfile(u);
  const s = await session(u, { capabilities: { webShare: true } });
  expect(s.channelPlan).toEqual(["os_share", "short_code", "qr"]);
});

test("S-023 Web Share 미지원 데스크톱: 단축코드가 먼저, QR은 여전히 마지막", async () => {
  const u = await signup();
  await withProfile(u);
  const s = await session(u, { capabilities: { webShare: false } });
  expect(s.channelPlan[0]).toBe("short_code");
  expect(s.channelPlan.at(-1)).toBe("qr");
});

test("S-024 NFC 액세서리 보유 시 NFC 단계가 사다리에 포함", async () => {
  const u = await signup();
  await withProfile(u);
  const s = await session(u, { capabilities: { webShare: true, nfcAccessoryEnabled: true } });
  expect(s.channelPlan).toEqual(["os_share", "nfc_accessory", "short_code", "qr"]);
});

test("S-025 채널 실패/시간초과가 이어지면 QR로 자동 폴백, 시도 로그 기록", async () => {
  const u = await signup();
  await withProfile(u);
  const s = await session(u);
  let r = await (await u.api.post(`/api/v1/exchange/manage/${s.sessionId}/attempts`, { data: { channel: "os_share", outcome: "cancelled", latencyMs: 900 } })).json();
  expect(r.nextChannel).toBe("short_code");
  r = await (await u.api.post(`/api/v1/exchange/manage/${s.sessionId}/attempts`, { data: { channel: "short_code", outcome: "timeout", latencyMs: 45000 } })).json();
  expect(r.nextChannel).toBe("qr");
  const n = await db.query("SELECT count(*)::int AS n FROM exchange_attempts WHERE exchange_session_id=$1", [s.sessionId]);
  expect(n.rows[0].n).toBe(2);
});

test("S-026 같은 Idempotency-Key 재시도는 같은 세션을 반환", async () => {
  const u = await signup();
  await withProfile(u);
  const h = { "idempotency-key": `k-${Date.now()}` };
  const a = await (await u.api.post("/api/v1/exchange/sessions", { data: { capabilities: {} }, headers: h })).json();
  const b = await (await u.api.post("/api/v1/exchange/sessions", { data: { capabilities: {} }, headers: h })).json();
  expect(b.sessionId).toBe(a.sessionId);
});

test("S-027 같은 Idempotency-Key로 다른 본문은 409", async () => {
  const u = await signup();
  await withProfile(u);
  const h = { "idempotency-key": `k2-${Date.now()}` };
  await u.api.post("/api/v1/exchange/sessions", { data: { capabilities: {} }, headers: h });
  const r = await u.api.post("/api/v1/exchange/sessions", { data: { capabilities: {}, group: true }, headers: h });
  expect(r.status()).toBe(409);
});

test("S-028 교환 토큰: ≥128bit URL-safe, DB에는 해시만, PII 미포함", async () => {
  const u = await signup();
  await withProfile(u);
  const s = await session(u);
  expect(s.token).toMatch(/^[A-Za-z0-9_-]{22,}$/);
  expect(s.token).not.toMatch(/hong|010|linkos/i);
  const r = await db.query("SELECT token_hash FROM exchange_sessions WHERE id=$1", [s.sessionId]);
  expect(r.rows[0].token_hash).not.toBe(s.token);
  expect(r.rows[0].token_hash).toMatch(/^[0-9a-f]{64}$/);
});

test("S-029 단축코드는 소문자/공백 입력도 허용", async () => {
  const u = await signup();
  await withProfile(u);
  const s = await session(u);
  const api = await anon();
  const pretty = `${s.shortCode.slice(0, 3)} ${s.shortCode.slice(3)}`.toLowerCase();
  const r = await api.get(`/api/v1/exchange/sessions/${encodeURIComponent(pretty)}`);
  expect(r.status()).toBe(200);
});

test("S-030 존재하지 않는 단축코드/토큰은 404 (열거 방지)", async () => {
  const api = await anon();
  expect((await api.get("/api/v1/exchange/sessions/ZZZZZZ")).status()).toBe(404);
  expect((await api.get("/api/v1/exchange/sessions/AAAAAAAAAAAAAAAAAAAAAAAAAAAA")).status()).toBe(404);
  expect((await api.get("/api/v1/exchange/sessions/x")).status()).toBe(404);
});

test("S-031 보낸 사람이 취소한 링크는 410", async () => {
  const u = await signup();
  await withProfile(u);
  const s = await session(u);
  await u.api.delete(`/api/v1/exchange/manage/${s.sessionId}`);
  const r = await (await anon()).get(`/api/v1/exchange/sessions/${s.token}`);
  expect(r.status()).toBe(410);
  expect((await r.json()).code).toBe("exchange_revoked");
});

test("S-032 만료된 링크는 410, 회신도 410", async () => {
  const u = await signup();
  await withProfile(u);
  const s = await session(u);
  await db.query("UPDATE exchange_sessions SET expires_at = now() - interval '1 second' WHERE id=$1", [s.sessionId]);
  const api = await anon();
  expect((await api.get(`/api/v1/exchange/sessions/${s.token}`)).status()).toBe(410);
  expect((await reply(api, s.token)).status()).toBe(410);
});

test("S-033 SSE 스트림이 교환 상태를 실시간으로 전달", async () => {
  const u = await signup();
  await withProfile(u);
  const s = await session(u);
  await reply(await anon(), s.token);
  const cookies = (await u.api.storageState()).cookies.map((c) => `${c.name}=${c.value}`).join("; ");
  const ctrl = new AbortController();
  const res = await fetch(`${BASE}/api/v1/exchange/manage/${s.sessionId}/events`, { headers: { cookie: cookies }, signal: ctrl.signal });
  expect(res.headers.get("content-type")).toContain("text/event-stream");
  const reader = res.body!.getReader();
  const started = Date.now();
  const { value } = await reader.read();
  ctrl.abort();
  const text = new TextDecoder().decode(value);
  expect(Date.now() - started).toBeLessThan(1000); // 백서 20: status propagation p95 < 1s
  expect(text).toContain("event: status");
  expect(text).toContain("CLAIM_PENDING");
});

test("S-034 다른 사용자는 남의 교환 상태를 볼 수 없음(404)", async () => {
  const u = await signup();
  await withProfile(u);
  const s = await session(u);
  const other = await signup();
  expect((await other.api.get(`/api/v1/exchange/manage/${s.sessionId}`)).status()).toBe(404);
  expect((await other.api.delete(`/api/v1/exchange/manage/${s.sessionId}`)).status()).toBe(404);
});

test("S-035 그룹 교환: 정원 3명까지 받고 4번째는 409", async () => {
  const u = await signup();
  await withProfile(u);
  const s = await session(u, { group: true, maxUses: 3 });
  const api = await anon();
  for (let i = 0; i < 3; i++) expect((await reply(api, s.token, { fullName: `참가${i}` }, ["fullName"])).status()).toBe(201);
  const r = await reply(api, s.token, { fullName: "초과" }, ["fullName"]);
  expect([409]).toContain(r.status());
  const st = await (await u.api.get(`/api/v1/exchange/manage/${s.sessionId}`)).json();
  expect(st.received.length).toBe(3);
});
