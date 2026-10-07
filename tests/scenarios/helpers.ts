import { type APIRequestContext, type Browser, request as pwRequest } from "@playwright/test";
import pg from "pg";

export const BASE = `http://localhost:${process.env.E2E_PORT ?? 3100}`;
export const db = new pg.Pool({ connectionString: process.env.DATABASE_URL ?? "postgres://linkos:linkos@localhost:5432/linkos", max: 4 });
export const uniq = () => `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 7)}`;

export const CONSENTS = ["terms", "privacy", "age_14"].map((type) => ({ type, granted: true }));

export interface User {
  api: APIRequestContext;
  email: string;
  id: string;
}

/** Sign up through the real HTTP API (email OTP, dev echo) and return an authenticated request context. */
export async function signup(email = `u${uniq()}@scn.test`): Promise<User> {
  const api = await pwRequest.newContext({ baseURL: BASE });
  const otp = await (await api.post("/api/v1/auth/otp", { data: { email } })).json();
  const r = await api.post("/api/v1/auth/verify", { data: { email, code: otp.devCode, consents: CONSENTS } });
  if (!r.ok()) throw new Error(`signup failed ${r.status()} ${await r.text()}`);
  const me = await (await api.get("/api/v1/me")).json();
  return { api, email, id: me.user.id };
}

export async function anon(): Promise<APIRequestContext> {
  return pwRequest.newContext({ baseURL: BASE });
}

export const PROFILE = {
  name: "홍길동",
  company: "링코스랩",
  jobTitle: "대표",
  keywords: ["의료AI"],
  fields: [
    { type: "email", value: "hong@linkos.test", visibility: "business" },
    { type: "mobile", value: "010-1111-2222", visibility: "trusted" },
    { type: "website", value: "linkos.test", visibility: "public" },
    { type: "other", label: "secret", value: "PRIVATE-NOTE-XYZ", visibility: "private" },
  ],
  offers: ["의료 영상 AI 솔루션"],
  needs: ["병원 유통 파트너"],
};

export async function withProfile(u: User, extra: Record<string, unknown> = {}) {
  const r = await u.api.post("/api/v1/profiles", { data: { ...PROFILE, ...extra } });
  if (r.status() !== 201) throw new Error(`profile ${r.status()} ${await r.text()}`);
  return r.json();
}

export async function session(u: User, data: Record<string, unknown> = {}) {
  const r = await u.api.post("/api/v1/exchange/sessions", { data: { capabilities: { webShare: true }, ...data } });
  if (r.status() !== 201) throw new Error(`session ${r.status()} ${await r.text()}`);
  return r.json();
}

export const GUEST_CARD = { fullName: "김영희", company: "메디파트너스", jobTitle: "이사", email: "yh@medi.test", phone: "010-9999-8888" };

export async function reply(api: APIRequestContext, tokenOrCode: string, card: Record<string, unknown> = GUEST_CARD, shared = ["fullName", "company", "jobTitle", "email"]) {
  return api.post(`/api/v1/exchange/sessions/${tokenOrCode}/reply`, { data: { card, sharedFields: shared, consent: { exchange: true }, provenance: {} } });
}

export type { Browser };
