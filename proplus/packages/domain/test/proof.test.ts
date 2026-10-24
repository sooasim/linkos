/**
 * P-053 검증 상태 머신 · P-054 자기기재 배지 차단 · P-055 검증 강도 · P-056 범위·기준일 · P-059 만료 즉시 반영
 *
 * 이 파일은 전략 §2 의 N-1 과 N-9 를 지키는 테스트다. 깨지면 제품 신뢰 모델이 깨진 것이다.
 */

import { describe, expect, it } from "vitest";
import {
  allowedTransitions,
  canTransition,
  computeExpiry,
  effectiveStatus,
  isEffectivelyExpired,
  isExpiringSoon,
  isTerminal,
} from "../src/proof";
import { PROOF_STATUSES, VERIFICATION_METHODS, type ProofActor, type ProofStatus } from "../src/types";

const NOW = new Date("2026-10-22T00:00:00.000Z");

/** verified 로 가는 요청의 최소 필수 필드. 각 테스트가 필요한 것만 덮어쓴다. */
function ok(over: Partial<Parameters<typeof canTransition>[0]> = {}) {
  return canTransition({
    from: "under_review",
    to: "verified",
    actor: "reviewer",
    method: "document_reviewed",
    scope: "2026년 재직 확인",
    ...over,
  });
}

describe("P-054 / N-1: 자기기재는 절대 verified 가 될 수 없다 (보안정책 §4.2)", () => {
  it("self_declared → verified 를 거부한다", () => {
    const r = ok({ method: "self_declared" });
    expect(r.ok).toBe(false);
    expect(r.ok === false && r.code).toBe("self_declared_cannot_verify");
  });

  it("역할·출발상태를 바꿔도 self_declared 는 verified 가 되지 못한다", () => {
    // 전이표에 구멍이 생기더라도 강도 게이트가 먼저 막는지 — 전수로 확인한다.
    for (const from of PROOF_STATUSES) {
      for (const actor of ["owner", "reviewer", "system"] as ProofActor[]) {
        if (from === "verified") continue; // from===to 는 no_op
        const r = canTransition({ from, to: "verified", actor, method: "self_declared", scope: "범위" });
        expect(r.ok, `${from} / ${actor} 에서 self_declared 가 통과했다`).toBe(false);
      }
    }
  });

  it("document_reviewed 이상은 verified 가 될 수 있다", () => {
    for (const m of VERIFICATION_METHODS) {
      if (m === "self_declared") continue;
      expect(ok({ method: m }).ok, `${m} 가 막혔다`).toBe(true);
    }
  });
});

describe("P-055: 유형별 최소 강도 게이트", () => {
  it("min_method 보다 약한 방식은 거부한다", () => {
    const r = ok({ method: "document_reviewed", minMethod: "issuer_confirmed" });
    expect(r.ok === false && r.code).toBe("method_too_weak");
  });

  it("min_method 와 같거나 강하면 통과한다", () => {
    expect(ok({ method: "issuer_confirmed", minMethod: "issuer_confirmed" }).ok).toBe(true);
    expect(ok({ method: "system_integrated", minMethod: "issuer_confirmed" }).ok).toBe(true);
  });
});

describe("P-072: 발급기관 권한 확인 (보안정책 §4.4)", () => {
  it("발급기관을 요구하는 유형인데 권한 확인 기록이 없으면 거부한다", () => {
    const r = ok({ method: "issuer_confirmed", requiresIssuer: true, issuerAuthorityChecked: false });
    expect(r.ok === false && r.code).toBe("issuer_authority_unchecked");
  });

  it("권한 확인 기록이 있으면 통과한다", () => {
    expect(ok({ method: "issuer_confirmed", requiresIssuer: true, issuerAuthorityChecked: true }).ok).toBe(true);
  });
});

describe("P-056: verified 에는 범위와 사유가 필수다 (보안정책 §4.3)", () => {
  it("범위가 비면 거부한다", () => {
    expect(ok({ scope: null }).ok === false && ok({ scope: null }).ok).toBe(false);
    const r = ok({ scope: "   " });
    expect(r.ok === false && r.code).toBe("scope_required");
  });

  it("반려에는 사유 코드가 필수다 (데이터모델 §4)", () => {
    const r = canTransition({ from: "under_review", to: "rejected", actor: "reviewer", method: "document_reviewed" });
    expect(r.ok === false && r.code).toBe("reason_required");
    const r2 = canTransition({ from: "under_review", to: "rejected", actor: "reviewer", method: "document_reviewed", reasonCode: "doc_illegible" });
    expect(r2.ok).toBe(true);
  });

  it("취소에도 사유 코드가 필수다 (P-061)", () => {
    const r = canTransition({ from: "verified", to: "revoked", actor: "reviewer", method: "issuer_confirmed" });
    expect(r.ok === false && r.code).toBe("reason_required");
  });
});

describe("P-053: 전이표", () => {
  it("소유자는 스스로 verified 로 올릴 수 없다", () => {
    // 역할 분리의 핵심. 표 자체에 길이 없어야 한다.
    for (const from of PROOF_STATUSES) {
      if (from === "verified") continue;
      expect(allowedTransitions(from, "owner")).not.toContain("verified");
    }
  });

  it("소유자는 검토 전 철회와 이의제기를 할 수 있다", () => {
    expect(allowedTransitions("submitted", "owner")).toContain("revoked");
    expect(allowedTransitions("verified", "owner")).toContain("disputed");
    expect(allowedTransitions("rejected", "owner")).toContain("disputed");
  });

  it("추가 정보 요청 후 재제출 경로가 있다 (P-163)", () => {
    expect(allowedTransitions("needs_more_info", "owner")).toContain("submitted");
  });

  it("만료·취소 후 재검증이 가능하다 (P-062)", () => {
    expect(allowedTransitions("expired", "owner")).toContain("submitted");
    expect(allowedTransitions("revoked", "owner")).toContain("submitted");
  });

  it("같은 상태로의 전이는 no_op 으로 거부한다", () => {
    const r = canTransition({ from: "verified", to: "verified", actor: "reviewer", method: "issuer_confirmed", scope: "x" });
    expect(r.ok === false && r.code).toBe("no_op");
  });

  it("표에 없는 전이는 transition_not_allowed 다", () => {
    const r = canTransition({ from: "submitted", to: "expired", actor: "system", method: "issuer_confirmed" });
    expect(r.ok === false && r.code).toBe("transition_not_allowed");
  });

  it("종착 상태가 아닌 상태는 전이 경로를 가진다", () => {
    // revoked 는 재제출이 가능하므로 종착이 아니다 (전략 §4.2).
    expect(isTerminal("revoked")).toBe(false);
    expect(isTerminal("verified")).toBe(false);
  });
});

describe("P-059 / N-9: 만료는 읽기 시점에 판정한다 (보안정책 §4.5)", () => {
  it("만료 시각이 지난 배지는 즉시 만료로 본다", () => {
    expect(isEffectivelyExpired("2026-10-21T23:59:59.000Z", NOW)).toBe(true);
  });

  it("만료 시각이 남았으면 유효하다", () => {
    expect(isEffectivelyExpired("2026-10-23T00:00:00.000Z", NOW)).toBe(false);
  });

  it("만료 없음(null)은 만료되지 않는다", () => {
    expect(isEffectivelyExpired(null, NOW)).toBe(false);
    expect(isEffectivelyExpired(undefined, NOW)).toBe(false);
  });

  it("경계: 정확히 같은 시각은 만료로 본다", () => {
    // 모호한 경계를 유효 쪽으로 두면 "만료된 배지가 1틱 더 보인다". 안전한 쪽을 고른다.
    expect(isEffectivelyExpired(NOW, NOW)).toBe(true);
  });

  it("파싱 불가한 값은 만료로 보지 않는다 (잘못된 데이터로 배지를 지우지 않는다)", () => {
    expect(isEffectivelyExpired("nonsense", NOW)).toBe(false);
  });

  it("effectiveStatus 는 저장된 verified 를 시간으로 expired 로 바꾼다", () => {
    expect(effectiveStatus("verified", "2026-01-01T00:00:00.000Z", NOW)).toBe("expired");
    expect(effectiveStatus("verified", "2027-01-01T00:00:00.000Z", NOW)).toBe("verified");
    // verified 가 아닌 상태는 시간이 바꾸지 않는다
    expect(effectiveStatus("rejected", "2026-01-01T00:00:00.000Z", NOW)).toBe("rejected");
  });
});

describe("P-060: 만료 예정 알림 (판정과 분리돼 있다)", () => {
  it("30일 안에 만료되면 대상이다", () => {
    expect(isExpiringSoon("2026-11-01T00:00:00.000Z", NOW)).toBe(true);
  });

  it("이미 만료된 것은 '예정'이 아니다", () => {
    expect(isExpiringSoon("2026-10-01T00:00:00.000Z", NOW)).toBe(false);
  });

  it("먼 미래는 대상이 아니다", () => {
    expect(isExpiringSoon("2027-10-01T00:00:00.000Z", NOW)).toBe(false);
  });
});

describe("computeExpiry: 유형 TTL 로 만료일 계산 (보안정책 §4.3)", () => {
  it("TTL 일수를 더한다", () => {
    const e = computeExpiry(NOW, 365);
    expect(e?.toISOString()).toBe("2027-10-22T00:00:00.000Z");
  });

  it("TTL 이 없는 유형은 만료가 없다 — 발급기관 상태 변경으로 취소된다", () => {
    expect(computeExpiry(NOW, null)).toBeNull();
    expect(computeExpiry(NOW, 0)).toBeNull();
  });
});
