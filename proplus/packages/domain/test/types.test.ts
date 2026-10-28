/**
 * P-055 검증 강도 4단계 (보안정책 §4.1) · 공통 enum 과 DB 스키마의 일치
 *
 * 이 파일이 지키는 것:
 *   1. 강도 순서는 문서(보안정책 §4.1)의 나열 순서이고, 비교 함수가 그 순서를 따른다.
 *   2. 네 강도 **전부**에 한글 라벨이 있다 — 라벨이 없으면 UI 가 색만으로 상태를 말하게 되고
 *      그것이 브랜드 §7 위반이다.
 *   3. 코드의 enum 배열이 실제 스키마(`db/migrations/0001_proplus_core.sql`)와 **정확히** 같다.
 *      코드와 스키마가 갈라지면 INSERT 가 런타임에만 실패한다. 여기서 먼저 잡는다.
 */

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import {
  CONSENT_PURPOSES,
  type EvidenceSource,
  LEAD_STAGES,
  METHOD_LABEL_KO,
  METHOD_RANK,
  type MemberRole,
  PROOF_STATUSES,
  type PlatformRole,
  VERIFICATION_METHODS,
  type VerificationMethod,
  isAtLeast,
} from "../src/types";

const SCHEMA_PATH = fileURLToPath(new URL("../../../db/migrations/0001_proplus_core.sql", import.meta.url));
const SCHEMA_SQL = readFileSync(SCHEMA_PATH, "utf8");

/** `CREATE TYPE <name> AS ENUM ('a', 'b')` 에서 값 목록을 **순서 그대로** 뽑는다. */
function sqlEnum(name: string): string[] {
  const m = new RegExp(`CREATE\\s+TYPE\\s+${name}\\s+AS\\s+ENUM\\s*\\(([^)]*)\\)`, "i").exec(SCHEMA_SQL);
  const body = m?.[1];
  if (body === undefined) throw new Error(`스키마에 ${name} enum 이 없다: ${SCHEMA_PATH}`);
  return body
    .split(",")
    .map((s) => s.trim().replace(/^'/, "").replace(/'$/, ""))
    .filter((s) => s.length > 0);
}

/** `CHECK (<column> IN ('a', 'b'))` 형태의 열거도 스키마의 일부다. */
function sqlCheckValues(column: string): string[] {
  const m = new RegExp(`${column}\\s+IN\\s*\\(([^)]*)\\)`, "i").exec(SCHEMA_SQL);
  const body = m?.[1];
  if (body === undefined) throw new Error(`스키마에 ${column} CHECK 열거가 없다: ${SCHEMA_PATH}`);
  return body
    .split(",")
    .map((s) => s.trim().replace(/^'/, "").replace(/'$/, ""))
    .filter((s) => s.length > 0);
}

describe("P-055 / 보안정책 §4.1: 검증 강도 순서", () => {
  it("self_declared < document_reviewed < issuer_confirmed < system_integrated 순이다", () => {
    expect(METHOD_RANK.self_declared).toBeLessThan(METHOD_RANK.document_reviewed);
    expect(METHOD_RANK.document_reviewed).toBeLessThan(METHOD_RANK.issuer_confirmed);
    expect(METHOD_RANK.issuer_confirmed).toBeLessThan(METHOD_RANK.system_integrated);
  });

  it("VERIFICATION_METHODS 의 나열 순서가 곧 강도 순이다 (문서 순서 = 코드 순서)", () => {
    // 배열 순서로 강도를 읽는 코드(UI 의 단계 표시 등)가 어긋나지 않게 고정한다.
    VERIFICATION_METHODS.forEach((m, i) => {
      expect(METHOD_RANK[m], `${m} 의 순위가 배열 위치와 다르다`).toBe(i);
    });
  });

  it("순위가 네 강도 전부에 있고 중복이 없다", () => {
    const ranks = VERIFICATION_METHODS.map((m) => METHOD_RANK[m]);
    expect(ranks).toHaveLength(4);
    expect(new Set(ranks).size).toBe(4);
    expect(Object.keys(METHOD_RANK).sort()).toEqual([...VERIFICATION_METHODS].sort());
  });
});

describe("P-055: isAtLeast 전수 매트릭스 (4×4)", () => {
  it("문서 순서상 뒤(또는 같은 자리)면 true, 앞이면 false 다", () => {
    VERIFICATION_METHODS.forEach((method, i) => {
      VERIFICATION_METHODS.forEach((min, j) => {
        // 기준은 구현의 METHOD_RANK 가 아니라 **문서의 나열 순서**다.
        expect(isAtLeast(method, min), `isAtLeast(${method}, ${min})`).toBe(i >= j);
      });
    });
  });

  it("같은 강도는 항상 충족한다 (경계)", () => {
    for (const m of VERIFICATION_METHODS) expect(isAtLeast(m, m), `${m}`).toBe(true);
  });

  it("self_declared 는 자기 자신 외에 아무 기준도 충족하지 못한다 (N-1 의 토대)", () => {
    for (const min of VERIFICATION_METHODS) {
      expect(isAtLeast("self_declared", min), `min=${min}`).toBe(min === "self_declared");
    }
  });

  it("system_integrated 는 모든 기준을 충족한다", () => {
    for (const min of VERIFICATION_METHODS) expect(isAtLeast("system_integrated", min), `min=${min}`).toBe(true);
  });

  it("최소 기준이 self_declared 면 모든 방식이 통과한다 — 게이트가 없는 상태와 같다", () => {
    for (const m of VERIFICATION_METHODS) expect(isAtLeast(m, "self_declared"), `${m}`).toBe(true);
  });
});

describe("P-055 / 브랜드 §7: 강도 라벨은 색이 아니라 텍스트다", () => {
  it("네 강도 전부에 한글 라벨이 있다 — 하나라도 비면 UI 가 색만으로 상태를 말하게 된다", () => {
    for (const m of VERIFICATION_METHODS) {
      const label = METHOD_LABEL_KO[m];
      expect(label, `${m} 라벨이 없다`).toBeTruthy();
      expect(label.trim(), `${m} 라벨이 공백이다`).not.toBe("");
      expect(label, `${m} 라벨에 한글이 없다`).toMatch(/[가-힣]/);
    }
  });

  it("라벨 키는 VERIFICATION_METHODS 와 정확히 같다 (빠짐·잉여 없음)", () => {
    expect(Object.keys(METHOD_LABEL_KO).sort()).toEqual([...VERIFICATION_METHODS].sort());
  });

  it("라벨이 서로 구별된다 — 두 강도가 같은 문구면 사용자가 구분할 수 없다", () => {
    const labels = VERIFICATION_METHODS.map((m) => METHOD_LABEL_KO[m]);
    expect(new Set(labels).size).toBe(labels.length);
  });

  it("self_declared 는 '자기기재'로 표기한다 (기획서 §5-4 / N-1 의 공개 표기)", () => {
    expect(METHOD_LABEL_KO.self_declared).toBe("자기기재");
  });

  it("라벨이 '검증됨' 같은 확정 표현으로 자기기재를 포장하지 않는다", () => {
    expect(METHOD_LABEL_KO.self_declared).not.toMatch(/검증|확인|인증/);
  });
});

describe("보안정책 §4.1 / 데이터모델 §1: 코드 enum 과 DB 스키마가 일치한다", () => {
  it("VERIFICATION_METHODS = verification_method (순서까지)", () => {
    expect([...VERIFICATION_METHODS]).toEqual(sqlEnum("verification_method"));
  });

  it("PROOF_STATUSES = proof_status (순서까지)", () => {
    // postgres enum 은 선언 순서가 비교·정렬 순서다. 순서가 갈라지면 ORDER BY 결과가 달라진다.
    expect([...PROOF_STATUSES]).toEqual(sqlEnum("proof_status"));
  });

  it("LEAD_STAGES = lead_stage (순서까지) — 파이프라인 단계 순서가 보고서와 같아야 한다", () => {
    expect([...LEAD_STAGES]).toEqual(sqlEnum("lead_stage"));
  });

  it("CONSENT_PURPOSES = consent_purpose (순서까지) — service 와 marketing 이 분리돼 있다 (N-11)", () => {
    expect([...CONSENT_PURPOSES]).toEqual(sqlEnum("consent_purpose"));
    expect(CONSENT_PURPOSES).toContain("service");
    expect(CONSENT_PURPOSES).toContain("marketing");
    expect(CONSENT_PURPOSES).toContain("recording");
  });

  it("타입만 있는 union 도 스키마와 맞는다 (런타임 배열이 없어 Record 로 전수를 강제한다)", () => {
    // Record 의 키는 컴파일러가 전수로 요구한다 — union 에 값이 추가되면 이 파일이 typecheck 에서 터지고,
    // 스키마에만 추가되면 아래 비교에서 터진다. 양방향 드리프트가 둘 다 드러난다.
    const evidenceSources: Record<EvidenceSource, true> = { user: true, platform: true, organization: true, third_party: true };
    expect(Object.keys(evidenceSources).sort()).toEqual(sqlEnum("evidence_source").sort());

    const memberRoles: Record<MemberRole, true> = { member: true, manager: true, owner: true };
    expect(Object.keys(memberRoles).sort()).toEqual(sqlEnum("member_role").sort());

    // platform_role 은 enum 이 아니라 users 테이블의 CHECK 열거다 (0001_proplus_core.sql).
    const platformRoles: Record<PlatformRole, true> = { none: true, reviewer: true, admin: true };
    expect(Object.keys(platformRoles).sort()).toEqual(sqlCheckValues("platform_role").sort());
  });

  it("스키마에서 값을 못 찾으면 테스트가 조용히 통과하지 않는다", () => {
    // 추출 헬퍼가 빈 배열을 돌려주면 `toEqual([])` 로 양쪽이 '맞는' 것처럼 보인다. 그 함정을 막는다.
    expect(() => sqlEnum("no_such_enum")).toThrow(/no_such_enum/);
    expect(() => sqlCheckValues("no_such_column")).toThrow(/no_such_column/);
    expect(sqlEnum("proof_status").length).toBeGreaterThan(0);
  });
});

describe("P-055: Provenance — 검증되지 않은 값은 강도가 없다", () => {
  it("null provenance 에 대응하는 라벨 키가 없다 — 호출부가 '자기기재'로 표기해야 한다", () => {
    // 기획서 §5-4: 검증되지 않은 값은 method 가 null 이고 공개 시 "자기기재"로 적는다.
    // METHOD_LABEL_KO 에는 null 키가 없으므로 `METHOD_LABEL_KO[method!]` 식 접근은 undefined 를 낸다.
    // 즉 라벨 결정 책임이 호출부에 있다는 사실을 테스트로 기록한다 (보고서의 지적 사항).
    const asRecord = METHOD_LABEL_KO as Record<string, string | undefined>;
    expect(asRecord["null"]).toBeUndefined();
    expect(asRecord[""]).toBeUndefined();
  });

  it("라벨 조회는 VerificationMethod 에만 정의된다", () => {
    const method: VerificationMethod = "issuer_confirmed";
    expect(METHOD_LABEL_KO[method]).toBe("발급기관 확인");
  });
});
