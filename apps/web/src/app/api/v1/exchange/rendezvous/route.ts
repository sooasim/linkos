import { channels } from "@linkos/api";
import { NextResponse } from "next/server";
import { route } from "@/lib/server";

// F-046 웹-웹 페어링 — receiver "받기 모드": a 4-digit code to say out loud + a secret listen token. No login required.
export const POST = route(async ({ ctx }) => NextResponse.json(await channels.startRendezvous(ctx), { status: 201, headers: { "cache-control": "no-store" } }), { auth: false });
