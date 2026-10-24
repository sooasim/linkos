/**
 * P-182 헬스체크 — 수용기준: "db 상태·마이그레이션 수·빌드 revision 을 보고한다".
 *
 * 이 라우트만 `route()` 래퍼를 쓰지 않는다. 래퍼는 들어온 쿠키로 세션을 조회·회전하는데,
 * 헬스체크는 **인증 계층이 고장난 상태에서도 답해야** 하는 엔드포인트다
 * (배포 런북의 기동 확인과 nginx/업스트림 감시가 이 응답만 보고 판단한다).
 *
 * LINKOS 의 apps/web/src/app/api/v1/health/route.ts 와 같은 모양이지만 `ai` 필드가 없다 —
 * PROPLUS 에는 LLM 라우팅이 없다(전략 §1: 공유하지 않는 것).
 */

import { appliedMigrationCount, buildInfo } from "@proplus/api";
import { NextResponse } from "next/server";

// 캐시된 응답은 "지금 살아 있는가"를 답하지 못한다.
export const dynamic = "force-dynamic";

export async function GET(): Promise<NextResponse> {
  const started = Date.now();
  // 빌드 식별자는 DB 가 죽어 있어도 돌려준다 — 장애 중에 "어느 커밋이 떠 있나"가 가장 먼저 필요하다.
  const { version, revision } = buildInfo();
  try {
    // 라우트에서 SQL 을 쓰지 않는다(CLAUDE.md §3). 개수 집계는 migrate 러너가 내보내는 함수가 한다.
    const migrations = await appliedMigrationCount();
    return NextResponse.json({
      status: "ok",
      db: "ok",
      migrations,
      latencyMs: Date.now() - started,
      version,
      revision,
    });
  } catch {
    // 실패 원인(접속 문자열·호스트명)은 응답에 넣지 않는다 (P-187: stack trace·내부 정보 비노출).
    return NextResponse.json(
      { status: "degraded", db: "unreachable", latencyMs: Date.now() - started, version, revision },
      { status: 503 },
    );
  }
}
