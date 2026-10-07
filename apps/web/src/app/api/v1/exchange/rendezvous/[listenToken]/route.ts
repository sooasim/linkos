import { channels } from "@linkos/api";
import { NextResponse } from "next/server";
import { route } from "@/lib/server";

// F-046: receiver polls its rendezvous; the exchange link is handed over once after the sender confirms.
export const GET = route<{ listenToken: string }>(async ({ ctx, params }) => NextResponse.json(await channels.pollRendezvous(params.listenToken, ctx), { headers: { "cache-control": "no-store", "referrer-policy": "no-referrer" } }), { auth: false });

export const DELETE = route<{ listenToken: string }>(async ({ params }) => channels.cancelRendezvous(params.listenToken), { auth: false });
