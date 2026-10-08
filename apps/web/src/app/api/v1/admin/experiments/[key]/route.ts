import { growth } from "@linkos/api";
import { z } from "zod";
import { parse, route } from "@/lib/server";

export const GET = route<{ key: string }>(async ({ ctx, params }) => growth.experimentResults(ctx, params.key));
export const POST = route<{ key: string }>(async ({ ctx, params, body }) => growth.setExperimentStatus(ctx, params.key, parse(z.object({ status: z.enum(["running", "stopped"]) }), body).status));
