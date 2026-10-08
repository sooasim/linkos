import { relationship } from "@linkos/api";
import { MERGEABLE_FIELDS } from "@linkos/domain";
import { z } from "zod";
import { parse, route } from "@/lib/server";

const schema = z.object({ secondaryId: z.string().uuid(), choices: z.partialRecord(z.enum(MERGEABLE_FIELDS), z.enum(["primary", "secondary"])).default({}) });

// mergeContact (F-021)
export const POST = route<{ id: string }>(async ({ ctx, params, body }) => {
  const b = parse(schema, body);
  return relationship.mergeContact(ctx, params.id, b.secondaryId, b.choices);
});
