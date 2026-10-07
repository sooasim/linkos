import { files } from "@linkos/api";
import { parse, route } from "@/lib/server";

// F-156 공유 링크
export const POST = route<{ id: string }>(async ({ ctx, params, body }) => files.addRoomLink(ctx, params.id, parse(files.roomLinkInput, body)), { status: 201 });
