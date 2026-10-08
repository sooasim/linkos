import { growth } from "@linkos/api";
import { parse, route } from "@/lib/server";

// F-196 experiments (admin)
export const GET = route(async ({ ctx }) => ({ experiments: await growth.listExperiments(ctx) }));
export const POST = route(async ({ ctx, body }) => growth.createExperiment(ctx, parse(growth.experimentInput, body)), { status: 201 });
