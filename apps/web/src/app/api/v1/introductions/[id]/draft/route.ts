import { intro } from "@linkos/api";
import { parse, route } from "@/lib/server";

// F-155 3-party intro message: generate a draft (POST), save the user's edit (PUT). Never sent by LINKOS.
export const GET = route<{ id: string }>(async ({ ctx, params }) => intro.getIntroDraft(ctx, params.id));
export const POST = route<{ id: string }>(async ({ ctx, params }) => intro.draftIntroMessage(ctx, params.id));
export const PUT = route<{ id: string }>(async ({ ctx, params, body }) => intro.saveIntroDraft(ctx, params.id, parse(intro.introDraftInput, body)));
