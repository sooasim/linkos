import { inbox } from "@linkos/api";
import { NextResponse } from "next/server";
import { route } from "@/lib/server";

// bell badge count
export const GET = route(async ({ ctx }) => NextResponse.json({ unread: await inbox.unreadCount(ctx.userId!) }, { headers: { "cache-control": "no-store" } }));
