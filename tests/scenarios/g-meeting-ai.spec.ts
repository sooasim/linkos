// G. 미팅 · AI (S-073 ~ S-080)
import { expect, test } from "@playwright/test";
import { reply, session, signup, withProfile } from "./helpers";

async function meetingFor() {
  const u = await signup();
  const c = await (await u.api.post("/api/v1/contacts", { data: { fullName: "오현우", company: "헬스AI", jobTitle: "대표", encounter: { placeLabel: "코엑스 메디컬 엑스포" } } })).json();
  const m = await (await u.api.post("/api/v1/meetings", { data: { title: "파일럿 논의", participantContactIds: [c.contactId], decisions: ["파일럿"], actionItems: [{ description: "제안서 송부", contactId: c.contactId }] } })).json();
  return { u, c, m };
}

test("S-073 Meeting Card 생성(결정·To-do·참석자)", async () => {
  const { m } = await meetingFor();
  expect(m.decisions).toEqual(["파일럿"]);
  expect(m.actionItems[0].description).toBe("제안서 송부");
  expect(m.participants[0].fullName).toBe("오현우");
});

test("S-074 동의 기록 없이 녹음 시작 409", async () => {
  const { u, m } = await meetingFor();
  const r = await u.api.post(`/api/v1/meetings/${m.id}/recordings`, { data: {} });
  expect(r.status()).toBe(409);
  expect((await r.json()).code).toBe("recording_consent_required");
});

test("S-075 참여자 동의가 빠지면 여전히 차단", async () => {
  const { u, m } = await meetingFor();
  const c = await (await u.api.post(`/api/v1/meetings/${m.id}/consent`, { data: { ownerConsent: true, participantsAcknowledged: false } })).json();
  expect(c.consentStatus).toBe("denied");
  expect((await u.api.post(`/api/v1/meetings/${m.id}/recordings`, { data: {} })).status()).toBe(409);
});

test("S-076 동의 완료 후에는 게이트 통과 → 녹음 생성, 파트 업로드(암호화 저장), 종료", async () => {
  const { u, m } = await meetingFor();
  await u.api.post(`/api/v1/meetings/${m.id}/consent`, { data: { ownerConsent: true, participantsAcknowledged: true } });
  const r = await u.api.post(`/api/v1/meetings/${m.id}/recordings`, { data: { mimeType: "audio/webm" } });
  expect(r.status()).toBe(201);
  const rec = await r.json();
  expect(rec.status).toBe("recording");
  const part = Buffer.concat([Buffer.from([0x1a, 0x45, 0xdf, 0xa3]), Buffer.alloc(64, 1)]);
  const up = await u.api.put(`/api/v1/meetings/${m.id}/recordings/${rec.id}/parts/0?offsetMs=0`, { data: part, headers: { "content-type": "audio/webm" } });
  expect(up.status()).toBe(201);
  // a non-audio payload is rejected by magic-byte validation (F-172)
  const bad = await u.api.put(`/api/v1/meetings/${m.id}/recordings/${rec.id}/parts/1?offsetMs=50000`, { data: Buffer.from("<html>not audio</html>!!"), headers: { "content-type": "audio/webm" } });
  expect(bad.status()).toBe(415);
  const fin = await (await u.api.post(`/api/v1/meetings/${m.id}/recordings/${rec.id}/finalize`, { data: { durationSeconds: 3 } })).json();
  expect(["stored", "transcribing"]).toContain(fin.status);
});

test("S-077 30초 브리핑: 마지막 만남·미완료 To-do", async () => {
  const { u, m } = await meetingFor();
  const b = await (await u.api.get(`/api/v1/meetings/${m.id}/brief`)).json();
  expect(b.people[0].lastEncounter.place_label).toContain("코엑스");
  expect(b.people[0].openActions[0].description).toBe("제안서 송부");
});

test("S-078 노트에서 결정/할 일 추출은 표시된 줄만(확인 필요 라벨)", async () => {
  const { u, m } = await meetingFor();
  const r = await (await u.api.post(`/api/v1/meetings/${m.id}/extract`, { data: { text: "결정: 2차 미팅\n할 일: 견적서 발송 내일\n잡담" } })).json();
  expect(r.needsConfirmation).toBe(true);
  expect(r.result.decisions).toEqual(["2차 미팅"]);
  expect(r.result.actionItems[0].dueHint).toBe("내일");
});

test("S-079 자연어 관계 기억 검색(장소·업종·직책)", async () => {
  const { u } = await meetingFor();
  const r = await (await u.api.post("/api/v1/ai/search", { data: { query: "코엑스에서 만난 헬스 대표" } })).json();
  expect(r.results[0].fullName).toBe("오현우");
  expect(r.results[0].evidence.length).toBeGreaterThan(0);
});

test("S-080 Need↔Offer 매칭은 설명과 ai_inferred 라벨 포함", async () => {
  const s = await signup();
  await withProfile(s, { needs: ["병원 유통 파트너"], offers: ["의료 영상 AI"] });
  const g = await signup();
  await withProfile(g, { name: "유통사", offers: ["전국 병원 유통 파트너 네트워크"], needs: ["의료 AI 제품"] });
  await reply(g.api, (await session(s)).token);
  const m = await (await s.api.get("/api/v1/matches")).json();
  expect(m.results[0].candidateName).toBe("유통사");
  expect(m.results[0].provenance).toBe("ai_inferred");
  expect(m.results[0].reasons[0].text).toContain("Need");
});
