import { integration } from "@linkos/api";
import { parse, route } from "@/lib/server";

// createExport — XLSX/CSV/vCard/TXT/JSON with field selection + audit
export const POST = route(async ({ ctx, body }) => integration.createExport(ctx, parse(integration.exportInput, body)), { status: 202 });
