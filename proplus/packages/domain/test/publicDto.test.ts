/**
 * P-026 공개 DTO allowlist · P-029 연락처 공개 설정
 *
 * N-4 / ADR-002 를 지키는 테스트다.
 * 핵심 주장: **새 컬럼이 추가돼도 공개되지 않는다.** 블랙리스트라면 조용히 뚫린다.
 */

import { describe, expect, it } from "vitest";
import {
  NEVER_PUBLIC_KEYS,
  PUBLIC_METRIC_FIELDS,
  PUBLIC_PROFILE_FIELDS,
  assertNoPrivateKeys,
  findPrivateKey,
  pickPublic,
  publicContact,
} from "../src/publicDto";

describe("P-026 / N-4: allowlist 는 '남길 키'만 안다 (ADR-002)", () => {
  it("allowlist 에 있는 필드만 남는다", () => {
    const src = {
      slug: "kim",
      displayName: "김영업",
      headline: "의료기기 유통",
      bio: "소개",
      specialties: ["의료기기"],
      languages: ["ko"],
      region: "서울",
      publishedAt: "2026-10-01T00:00:00.000Z",
      // 아래는 전부 떨어져야 한다
      email: "a@b.com",
      phone: "010-1234-5678",
      userId: "u1",
      internalNote: "내부 메모",
    };
    const out = pickPublic(src, PUBLIC_PROFILE_FIELDS);
    expect(Object.keys(out).sort()).toEqual([...PUBLIC_PROFILE_FIELDS].sort());
    expect(out).not.toHaveProperty("email");
    expect(out).not.toHaveProperty("userId");
    expect(out).not.toHaveProperty("internalNote");
  });

  it("나중에 추가된 컬럼은 **기본적으로 비공개**다 — 이것이 allowlist 를 쓰는 이유다", () => {
    // 마이그레이션으로 profiles 에 민감한 컬럼이 하나 붙은 상황을 흉내낸다.
    const srcAfterMigration = {
      slug: "kim",
      displayName: "김영업",
      headline: null,
      bio: null,
      specialties: [],
      languages: [],
      region: null,
      publishedAt: "2026-10-01T00:00:00.000Z",
      residentRegistrationNumber: "900101-1234567", // ← 새 컬럼. allowlist 를 안 고쳤다.
      riskFlag: "watch",
    };
    const out = pickPublic(srcAfterMigration, PUBLIC_PROFILE_FIELDS);
    expect(out).not.toHaveProperty("residentRegistrationNumber");
    expect(out).not.toHaveProperty("riskFlag");
  });

  it("undefined 값인 키는 응답에서 빠진다", () => {
    const out = pickPublic(
      { slug: "a", displayName: "n", headline: undefined, bio: undefined, specialties: [], languages: [], region: undefined, publishedAt: "x" },
      PUBLIC_PROFILE_FIELDS,
    );
    expect(out).not.toHaveProperty("headline");
    expect(out).toHaveProperty("slug");
  });
});

describe("비공개 키 트립와이어 (allowlist 를 우회한 경로를 잡는다)", () => {
  it("중첩된 객체 안의 비공개 키도 찾는다", () => {
    const res = { profile: { slug: "a" }, badges: [{ id: "b", evidenceId: "e1" }] };
    expect(findPrivateKey(res)).toBe("$.badges[0].evidenceId");
  });

  it("배열 안쪽까지 재귀한다", () => {
    const res = { offers: [{ title: "a" }, { title: "b", objectKey: "s3://x" }] };
    expect(findPrivateKey(res)).toBe("$.offers[1].objectKey");
  });

  it("깨끗한 응답은 null 을 돌려준다", () => {
    const res = { profile: { slug: "a", displayName: "n" }, badges: [{ id: "b", label: "확인", scope: "범위" }] };
    expect(findPrivateKey(res)).toBeNull();
  });

  it("assertNoPrivateKeys 는 비공개 키를 만나면 던진다", () => {
    expect(() => assertNoPrivateKeys({ a: { reviewerNote: "메모" } })).toThrow(/N-4/);
    expect(() => assertNoPrivateKeys({ a: { label: "ok" } })).not.toThrow();
  });

  it("N-3: 신뢰점수 계열 키는 비공개 목록에 있다 (단일 점수 금지)", () => {
    for (const k of ["trustScore", "score", "ranking", "completeness"]) {
      expect(NEVER_PUBLIC_KEYS).toContain(k);
    }
    expect(() => assertNoPrivateKeys({ profile: { trustScore: 87 } })).toThrow();
  });

  it("증거 원본 식별자 계열은 공개 응답에 들어갈 수 없다 (N-5 / ADR-004)", () => {
    for (const k of ["objectKey", "evidenceId", "encryptionRef", "sha256"]) {
      expect(NEVER_PUBLIC_KEYS).toContain(k);
    }
  });

  it("고객 PII 와 내부 메모 계열도 막는다", () => {
    for (const k of ["email", "phone", "contactChannelEncrypted", "reviewerNote", "accessPurpose"]) {
      expect(NEVER_PUBLIC_KEYS).toContain(k);
    }
  });
});

describe("P-029: 연락처는 별도 동의 없이 공개되지 않는다 (기술백서 §6)", () => {
  it("기본값은 비공개다", () => {
    expect(publicContact({}, { email: "a@b.com", phone: "010-1111-2222" })).toEqual({});
    expect(publicContact(null, { email: "a@b.com" })).toEqual({});
    expect(publicContact(undefined, { phone: "010-1111-2222" })).toEqual({});
  });

  it("명시적으로 켠 항목만 공개된다", () => {
    expect(publicContact({ showEmail: true }, { email: "a@b.com", phone: "010-1111-2222" })).toEqual({ email: "a@b.com" });
    expect(publicContact({ showPhone: true }, { email: "a@b.com", phone: "010-1111-2222" })).toEqual({ phone: "010-1111-2222" });
  });

  it("truthy 한 다른 값으로는 열리지 않는다 — === true 만 통과한다", () => {
    // '0'/'false'/1 같은 값이 JSON 설정에 섞여도 공개되지 않아야 한다.
    expect(publicContact({ showEmail: "true" }, { email: "a@b.com" })).toEqual({});
    expect(publicContact({ showEmail: 1 }, { email: "a@b.com" })).toEqual({});
  });

  it("설정이 켜져 있어도 값이 없으면 키를 만들지 않는다", () => {
    expect(publicContact({ showEmail: true }, { email: null })).toEqual({});
  });
});

describe("N-8: 공개 지표는 기간·분모·근거를 함께 들고 다닌다", () => {
  it("allowlist 에 기간·표본·근거가 포함돼 있다 — 수치만 떼서 보낼 수 없다", () => {
    for (const f of ["periodStart", "periodEnd", "sampleSize", "basis"]) {
      expect(PUBLIC_METRIC_FIELDS).toContain(f);
    }
  });
});
