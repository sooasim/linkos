import { one } from "@linkos/api";
import { NextResponse } from "next/server";

export const dynamic = "force-dynamic";

export async function GET() {
  const started = Date.now();
  try {
    const r = await one<{ migrations: number }>("SELECT count(*)::int AS migrations FROM schema_migrations");
    return NextResponse.json({ status: "ok", db: "ok", migrations: r?.migrations ?? 0, latencyMs: Date.now() - started, version: process.env.APP_VERSION ?? "1.0.0" });
  } catch {
    return NextResponse.json({ status: "degraded", db: "unreachable" }, { status: 503 });
  }
}
