import { integration } from "@linkos/api";
import { parse, route } from "@/lib/server";

// F-116 Google Drive — save an export file into the app-owned LINKOS folder (drive.file scope)
export const POST = route(async ({ ctx, body }) => integration.saveExportToDrive(ctx, parse(integration.driveSaveInput, body)), { status: 201 });
