/**
 * P-104 리드 단계(stage) 변경 — 모듈명세 M07.
 *
 * 수용기준은 "허용된 단계 전이만, 변경 이력 보존"이다. 이력이 `lead_stage_history` 에 남는다는
 * 전제이므로 전이표는 느슨하고(오기입 정정 허용), **딱 하나**를 강하게 막는다 —
 * 종료(won|lost) 에서 'new' 로의 복귀. 'new' 는 "아직 아무도 연락하지 않음"이라서
 * 되돌리면 응답시간 지표(P-111 / N-8)의 분모가 조용히 오염된다.
 */

import { describe, expect, it } from "vitest";
import { LEAD_STAGE_LABEL_KO, canChangeStage, isClosed } from "../src/leadStage";
import { LEAD_STAGES, type LeadStage } from "../src/types";

const CLOSED_STAGES: readonly LeadStage[] = ["won", "lost"];

/** 수용기준에서 직접 유도한 기대값 — 구현을 베끼지 않는다. */
function expectedAllowed(from: LeadStage, to: LeadStage): boolean {
  if (from === to) return false;
  if (CLOSED_STAGES.includes(from)) return to !== "new";
  return true;
}

describe("P-104: LEAD_STAGES 전수 × 전수 전이 매트릭스", () => {
  it("36개 조합이 전부 기대값과 같다", () => {
    for (const from of LEAD_STAGES) {
      for (const to of LEAD_STAGES) {
        expect(canChangeStage(from, to), `${from} → ${to}`).toBe(expectedAllowed(from, to));
      }
    }
  });

  it("같은 단계로의 변경은 전수로 거부된다 — 이력만 늘리고 뜻이 없다", () => {
    for (const s of LEAD_STAGES) {
      expect(canChangeStage(s, s), `${s} → ${s}`).toBe(false);
    }
  });

  it("종료 상태에서 'new' 로의 복귀는 전수로 거부된다", () => {
    for (const from of CLOSED_STAGES) {
      expect(canChangeStage(from, "new"), `${from} → new`).toBe(false);
    }
  });

  it("종료 상태에서 'contacted' 이후로의 재개는 허용된다 (재개의 하한은 '연락함')", () => {
    for (const from of CLOSED_STAGES) {
      for (const to of ["contacted", "qualified", "proposal"] as LeadStage[]) {
        expect(canChangeStage(from, to), `${from} → ${to}`).toBe(true);
      }
    }
  });

  it("종료 간 수정(won↔lost)은 허용된다 — 되돌리기가 아니라 결과 정정이다", () => {
    expect(canChangeStage("won", "lost")).toBe(true);
    expect(canChangeStage("lost", "won")).toBe(true);
  });

  it("진행 중 단계에서는 전진·후퇴가 모두 허용된다 (오기입 정정)", () => {
    expect(canChangeStage("new", "contacted")).toBe(true);
    expect(canChangeStage("contacted", "qualified")).toBe(true);
    expect(canChangeStage("qualified", "proposal")).toBe(true);
    expect(canChangeStage("proposal", "contacted")).toBe(true);
    // 진행 중 단계에서 'new' 로 되돌리는 것은 막지 않는다 (종료 상태만 막는다).
    expect(canChangeStage("contacted", "new")).toBe(true);
    expect(canChangeStage("proposal", "new")).toBe(true);
  });

  it("단계 건너뛰기는 허용된다 — 파이프라인은 순차 강제가 아니다", () => {
    expect(canChangeStage("new", "won")).toBe(true);
    expect(canChangeStage("new", "lost")).toBe(true);
    expect(canChangeStage("new", "proposal")).toBe(true);
  });
});

describe("P-104: enum 밖의 값은 런타임에 거부한다 (타입은 HTTP 본문을 지키지 못한다)", () => {
  it("알 수 없는 출발 단계는 거부한다", () => {
    for (const to of LEAD_STAGES) {
      expect(canChangeStage("archived" as LeadStage, to), `archived → ${to}`).toBe(false);
    }
  });

  it("알 수 없는 도착 단계는 거부한다", () => {
    for (const from of LEAD_STAGES) {
      expect(canChangeStage(from, "archived" as LeadStage), `${from} → archived`).toBe(false);
    }
  });

  it("빈 문자열·대문자 변형도 거부한다", () => {
    expect(canChangeStage("" as LeadStage, "contacted")).toBe(false);
    expect(canChangeStage("new", "WON" as LeadStage)).toBe(false);
    expect(canChangeStage("New" as LeadStage, "contacted")).toBe(false);
  });
});

describe("P-104: isClosed 는 종료 리드의 유일한 기준이다 (알림·응답시간 집계 제외 조건)", () => {
  it("전수: won·lost 만 종료다", () => {
    for (const s of LEAD_STAGES) {
      expect(isClosed(s), s).toBe(CLOSED_STAGES.includes(s));
    }
  });

  it("진입 상태와 진행 중 단계는 종료가 아니다", () => {
    expect(isClosed("new")).toBe(false);
    expect(isClosed("proposal")).toBe(false);
  });

  it("알 수 없는 값은 종료로 보지 않는다 — 잘못된 데이터로 리드를 닫지 않는다", () => {
    expect(isClosed("archived" as LeadStage)).toBe(false);
  });
});

describe("P-104 / 브랜드 §7: 단계 라벨은 코드 상수다 (색만으로 상태를 말하지 않는다)", () => {
  it("전수: 모든 단계에 비어 있지 않은 한국어 라벨이 있다", () => {
    for (const s of LEAD_STAGES) {
      const label = LEAD_STAGE_LABEL_KO[s];
      expect(typeof label, s).toBe("string");
      expect(label.trim().length, s).toBeGreaterThan(0);
    }
  });

  it("라벨 키 집합이 LEAD_STAGES 와 정확히 같다 — 빠뜨린 단계가 없다", () => {
    expect(Object.keys(LEAD_STAGE_LABEL_KO).sort()).toEqual([...LEAD_STAGES].sort());
  });

  it("라벨이 서로 겹치지 않는다 — 두 단계가 같은 글자로 보이면 안 된다", () => {
    const labels = LEAD_STAGES.map((s) => LEAD_STAGE_LABEL_KO[s]);
    expect(new Set(labels).size).toBe(LEAD_STAGES.length);
  });
});
