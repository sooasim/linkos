import { buildInfo, llmEnabled, llmActiveModels, one } from "@linkos/api";
import { NextResponse } from "next/server";

export const dynamic = "force-dynamic";

export async function GET() {
  const started = Date.now();
  try {
    const r = await one<{ migrations: number }>("SELECT count(*)::int AS migrations FROM schema_migrations");
    const { version, revision } = buildInfo();
    // revision 은 "이 응답을 주는 빌드가 어느 커밋인가" 다. 배포가 실제로 교체됐는지 확인할 때 쓴다.
    // ai 는 "키가 꽂혀 있는가 + 지금 어느 모델로 라우팅되는가". 모델 ID 는 공개 정보라 숨길 게 없고,
    // 새 모델이 나왔을 때 자동 전환이 실제로 일어났는지 여기서 바로 확인할 수 있다.
    // 캐시된 값만 읽는다 — 헬스체크가 외부 API 를 호출하면 안 된다.
    const ai = llmEnabled() ? { enabled: true as const, models: llmActiveModels() } : { enabled: false as const };
    return NextResponse.json({ status: "ok", db: "ok", migrations: r?.migrations ?? 0, latencyMs: Date.now() - started, version, revision, ai });
  } catch {
    return NextResponse.json({ status: "degraded", db: "unreachable" }, { status: 503 });
  }
}
