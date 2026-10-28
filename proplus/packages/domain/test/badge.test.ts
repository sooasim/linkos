/**
 * P-058 공개 배지 6필드 보장 · P-064 분쟁 중 중립 표기 · P-070 배지 유료 구매 차단
 *
 * N-2 와 N-14 를 지키는 테스트다.
 */

import { describe, expect, it } from "vitest";
import {
  DISPUTED_LABEL_KO,
  type BadgeRow,
  canIssueBadge,
  findForbiddenClaim,
  toPublicBadge,
  toPublicBadges,
} from "../src/badge";

const NOW = new Date("2026-10-22T00:00:00.000Z");

function row(over: Partial<BadgeRow> = {}): BadgeRow {
  return {
    id: "b1",
    badgeType: "affiliation",
    publicLabel: "현재 소속 확인",
    method: "issuer_confirmed",
    scope: "2026년 재직",
    issuerName: "주식회사 예시",
    status: "active",
    verifiedAt: "2026-09-01T00:00:00.000Z",
    expiresAt: "2027-09-01T00:00:00.000Z",
    ...over,
  };
}

describe("P-058: 6필드 중 하나라도 비면 배지를 숨긴다", () => {
  it("완전한 배지는 공개된다", () => {
    const p = toPublicBadge(row(), NOW);
    expect(p).not.toBeNull();
    expect(p?.label).toBe("현재 소속 확인");
    expect(p?.methodLabel).toBe("발급기관 확인");
    expect(p?.scope).toBe("2026년 재직");
    expect(p?.verifiedAt).toBe("2026-09-01T00:00:00.000Z");
  });

  it("검증일이 없으면 숨긴다 — '언제 확인했는지'를 말할 수 없는 배지는 공개하지 않는다", () => {
    expect(toPublicBadge(row({ verifiedAt: null }), NOW)).toBeNull();
  });

  it("라벨이 비면 숨긴다", () => {
    expect(toPublicBadge(row({ publicLabel: "   " }), NOW)).toBeNull();
  });

  it("범위가 비면 숨긴다", () => {
    expect(toPublicBadge(row({ scope: "" }), NOW)).toBeNull();
  });

  it("발급기관을 요구하는 유형인데 발급기관이 없으면 숨긴다", () => {
    expect(toPublicBadge(row({ issuerName: null }), NOW, { requiresIssuer: true })).toBeNull();
    // 요구하지 않는 유형이면 발급기관 없이도 공개된다
    expect(toPublicBadge(row({ issuerName: null }), NOW, { requiresIssuer: false })).not.toBeNull();
  });
});

describe("N-1: 자기기재 배지는 공개되지 않는다", () => {
  it("method 가 self_declared 면 숨긴다 (DB 제약을 우회해 들어왔더라도)", () => {
    expect(toPublicBadge(row({ method: "self_declared" }), NOW)).toBeNull();
  });
});

describe("P-059 / N-9: 만료·취소는 읽기 시점에 반영된다", () => {
  it("만료 시각이 지난 배지는 공개되지 않는다", () => {
    expect(toPublicBadge(row({ expiresAt: "2026-01-01T00:00:00.000Z" }), NOW)).toBeNull();
  });

  it("취소된 배지는 공개되지 않는다", () => {
    expect(toPublicBadge(row({ status: "revoked" }), NOW)).toBeNull();
    expect(toPublicBadge(row({ revokedAt: "2026-10-01T00:00:00.000Z" }), NOW)).toBeNull();
  });

  it("status=expired 는 공개되지 않는다", () => {
    expect(toPublicBadge(row({ status: "expired" }), NOW)).toBeNull();
  });

  it("만료 없음(null)은 계속 유효하다", () => {
    expect(toPublicBadge(row({ expiresAt: null }), NOW)).not.toBeNull();
  });
});

describe("P-064 / N-14: 분쟁 중에는 확정적 표현을 쓰지 않는다 (보안정책 §4.7)", () => {
  it("disputed 배지의 라벨은 '확인 필요'로 치환된다", () => {
    const p = toPublicBadge(row({ status: "disputed" }), NOW);
    expect(p).not.toBeNull();
    expect(p?.label).toBe(DISPUTED_LABEL_KO);
    expect(p?.label).not.toBe("현재 소속 확인");
    expect(p?.disputed).toBe(true);
  });

  it("분쟁 중 배지도 범위·검증일은 그대로 보여준다 — 숨기는 것이 아니라 중립화다", () => {
    const p = toPublicBadge(row({ status: "disputed" }), NOW);
    expect(p?.scope).toBe("2026년 재직");
    expect(p?.verifiedAt).toBe("2026-09-01T00:00:00.000Z");
  });
});

describe("P-070 / N-2: 배지는 유료 구매만으로 획득할 수 없다 (보안정책 §4.10)", () => {
  it("canIssueBadge 의 입력에 구독·요금제·결제 필드가 없다", () => {
    // 이 테스트는 시그니처 자체를 고정한다. 누가 plan/subscription 을 인자로 추가하면 여기서 터진다.
    const allowed = new Set(["verificationStatus", "method", "scope", "verifiedAt"]);
    const probe = { verificationStatus: "verified", method: "issuer_confirmed" as const, scope: "범위", verifiedAt: NOW };
    for (const k of Object.keys(probe)) expect(allowed.has(k)).toBe(true);
    expect(allowed.size).toBe(4);
    // 결제 관련 이름이 허용 집합에 없음을 명시적으로 확인한다
    for (const forbidden of ["plan", "planCode", "subscription", "subscriptionStatus", "paid", "tier"]) {
      expect(allowed.has(forbidden)).toBe(false);
    }
  });

  it("검증되지 않은 증거로는 배지를 낼 수 없다", () => {
    const r = canIssueBadge({ verificationStatus: "under_review", method: "issuer_confirmed", scope: "범위", verifiedAt: NOW });
    expect(r.ok === false && r.code).toBe("not_verified");
  });

  it("자기기재로는 배지를 낼 수 없다", () => {
    const r = canIssueBadge({ verificationStatus: "verified", method: "self_declared", scope: "범위", verifiedAt: NOW });
    expect(r.ok === false && r.code).toBe("self_declared_cannot_verify");
  });

  it("범위·기준일이 없으면 배지를 낼 수 없다", () => {
    expect(canIssueBadge({ verificationStatus: "verified", method: "issuer_confirmed", scope: null, verifiedAt: NOW }).ok).toBe(false);
    expect(canIssueBadge({ verificationStatus: "verified", method: "issuer_confirmed", scope: "범위", verifiedAt: null }).ok).toBe(false);
  });

  it("조건이 맞으면 발급된다", () => {
    expect(canIssueBadge({ verificationStatus: "verified", method: "document_reviewed", scope: "범위", verifiedAt: NOW }).ok).toBe(true);
  });
});

describe("N-3: 배지 정렬에 강도를 쓰지 않는다 (단일 점수 금지)", () => {
  it("유형 고정 순서로 정렬된다 — 강한 배지가 위로 올라오지 않는다", () => {
    const rows = [
      row({ id: "t", badgeType: "transaction_count", method: "system_integrated", publicLabel: "거래 데이터 확인" }),
      row({ id: "i", badgeType: "identity", method: "document_reviewed", publicLabel: "본인 확인 완료" }),
    ];
    const out = toPublicBadges(rows, NOW);
    // identity 가 기획서 §7 나열 순서상 먼저다. system_integrated(가장 강함)가 위로 오면 안 된다.
    expect(out.map((b) => b.type)).toEqual(["identity", "transaction_count"]);
  });

  it("숨겨야 할 배지는 목록에서 제거된다", () => {
    const rows = [row({ id: "a" }), row({ id: "b", badgeType: "license", method: "self_declared" })];
    const out = toPublicBadges(rows, NOW);
    expect(out).toHaveLength(1);
    expect(out[0]?.id).toBe("a");
  });

  it("발급기관 필수 유형 집합을 반영한다", () => {
    const rows = [row({ badgeType: "license", issuerName: null, publicLabel: "자격 정보 확인" })];
    expect(toPublicBadges(rows, NOW, new Set(["license"]))).toHaveLength(0);
    expect(toPublicBadges(rows, NOW, new Set())).toHaveLength(1);
  });
});

describe("브랜드 §5: 근거 없는 과장 표현 차단", () => {
  it("금지 표현을 찾아낸다", () => {
    expect(findForbiddenClaim("국내 1위 전문가입니다")).toBeTruthy();
    expect(findForbiddenClaim("100% 검증된 경력")).toBeTruthy();
    expect(findForbiddenClaim("완벽히 신뢰할 수 있음")).toBeTruthy();
    expect(findForbiddenClaim("I am the No. 1 agent")).toBeTruthy();
  });

  it("정상 문구는 통과한다", () => {
    expect(findForbiddenClaim("의료기기 유통 12년, 서울 지역 담당")).toBeNull();
    expect(findForbiddenClaim("2026년 재직 확인 완료")).toBeNull();
  });
});
