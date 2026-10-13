import { netintel } from "@linkos/api";
import { parse, route } from "@/lib/server";

// N-018 프로젝트 (S10 Project Command Center)
export const GET = route(async ({ ctx }) => netintel.listProjects(ctx));
export const POST = route(async ({ ctx, body }) => netintel.createProject(ctx, parse(netintel.projectInput, body)), { status: 201 });
