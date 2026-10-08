// H. 소개 · Connection Room · 행사 (S-081 ~ S-086)
import { expect, test } from "@playwright/test";
import { signup, withProfile } from "./helpers";

async function twoContacts() {
  const u = await signup();
  const a = await (await u.api.post("/api/v1/contacts", { data: { fullName: "투자자A" } })).json();
  const b = await (await u.api.post("/api/v1/contacts", { data: { fullName: "창업자B" } })).json();
  const i = await (await u.api.post("/api/v1/introductions", { data: { partyAContactId: a.contactId, partyBContactId: b.contactId, reason: "시리즈A 논의" } })).json();
  return { u, i };
}

test("S-081 양측 동의 후에만 Connection Room 생성", async () => {
  const { u, i } = await twoContacts();
  expect(i.contactsRevealed).toBe(false);
  const a = await (await u.api.post(`/api/v1/introductions/${i.id}/consent`, { data: { party: "a", accepted: true } })).json();
  expect(a.roomId).toBeNull();
  const b = await (await u.api.post(`/api/v1/introductions/${i.id}/consent`, { data: { party: "b", accepted: true } })).json();
  expect(b.state).toBe("ROOM_CREATED");
  expect(b.roomId).toBeTruthy();
});

test("S-082 한쪽이 거절하면 DECLINED, Room 없음, 이후 변경 불가", async () => {
  const { u, i } = await twoContacts();
  const r = await (await u.api.post(`/api/v1/introductions/${i.id}/consent`, { data: { party: "a", accepted: false } })).json();
  expect(r.state).toBe("DECLINED");
  expect(r.roomId).toBeNull();
  expect((await u.api.post(`/api/v1/introductions/${i.id}/consent`, { data: { party: "b", accepted: true } })).status()).toBe(409);
});

test("S-083 Room 기록·Next Action·성사 처리", async () => {
  const { u, i } = await twoContacts();
  await u.api.post(`/api/v1/introductions/${i.id}/consent`, { data: { party: "a", accepted: true } });
  const { roomId } = await (await u.api.post(`/api/v1/introductions/${i.id}/consent`, { data: { party: "b", accepted: true } })).json();
  await u.api.post(`/api/v1/rooms/${roomId}/messages`, { data: { body: "IR 자료 공유" } });
  const r = await (await u.api.patch(`/api/v1/rooms/${roomId}`, { data: { nextAction: "다음 주 미팅", status: "won" } })).json();
  expect(r.messages.map((m: { body: string }) => m.body)).toContain("IR 자료 공유");
  expect(r.introduction.state).toBe("WON");
});

test("S-084 행사: 추천 비공개(opt-out) 참가자는 매칭에 나오지 않음", async () => {
  const host = await signup();
  await withProfile(host, { name: "주최", needs: ["시리즈A 투자"] });
  const e = await (await host.api.post("/api/v1/events", { data: { name: "데모데이" } })).json();
  const vc = await signup();
  await withProfile(vc, { name: "공개VC", offers: ["시리즈A 투자 집행"] });
  await vc.api.post("/api/v1/events/join", { data: { joinCode: e.joinCode, optIn: true } });
  const hidden = await signup();
  await withProfile(hidden, { name: "비공개VC", offers: ["시리즈A 투자"] });
  await hidden.api.post("/api/v1/events/join", { data: { joinCode: e.joinCode, optIn: false } });
  const m = await (await host.api.get(`/api/v1/events/${e.id}/matches`)).json();
  expect(m.results.map((r: { candidateName: string }) => r.candidateName)).toEqual(["공개VC"]);
});

test("S-085 잘못된 참가 코드는 404", async () => {
  const u = await signup();
  await withProfile(u);
  expect((await u.api.post("/api/v1/events/join", { data: { joinCode: "ZZZZZZ", optIn: true } })).status()).toBe(404);
});

test("S-086 참가하지 않은 행사의 매칭/정보는 볼 수 없음", async () => {
  const host = await signup();
  await withProfile(host);
  const e = await (await host.api.post("/api/v1/events", { data: { name: "비공개행사" } })).json();
  const outsider = await signup();
  expect((await outsider.api.get(`/api/v1/events/${e.id}`)).status()).toBe(404);
  expect((await outsider.api.get(`/api/v1/events/${e.id}/matches`)).status()).toBe(404);
});
