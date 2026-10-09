import { buildInfo, one } from "@linkos/api";
import { NextResponse } from "next/server";

export const dynamic = "force-dynamic";

export async function GET() {
  const started = Date.now();
  try {
    const r = await one<{ migrations: number }>("SELECT count(*)::int AS migrations FROM schema_migrations");
    const { version, revision } = buildInfo();
    // revision 은 "이 응답을 주는 빌드가 어느 커밋인가" 다. 배포가 실제로 교체됐는지 확인할 때 쓴다.
    return NextResponse.json({ status: "ok", db: "ok", migrations: r?.migrations ?? 0, latencyMs: Date.now() - started, version, revision });
  } catch {
    return NextResponse.json({ status: "degraded", db: "unreachable" }, { status: 503 });
  }
}
