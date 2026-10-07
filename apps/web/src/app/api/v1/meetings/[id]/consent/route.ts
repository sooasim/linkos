import { meeting } from "@linkos/api";
import { z } from "zod";
import { parse, route } from "@/lib/server";

const schema = z.object({ ownerConsent: z.boolean(), participantsAcknowledged: z.boolean(), policy: z.enum(["all_party", "one_party_notice"]).default("all_party") });

export const POST = route<{ id: string }>(async ({ ctx, params, body }) => meeting.setRecordingConsent(ctx, params.id, parse(schema, body)));
