import { integration } from "@linkos/api";
import { parse, route } from "@/lib/server";

// F-117 Google Sheets export — creates a new spreadsheet with the selected fields
export const POST = route(async ({ ctx, body }) => integration.exportToGoogleSheets(ctx, parse(integration.sheetsExportInput, body)), { status: 201 });
