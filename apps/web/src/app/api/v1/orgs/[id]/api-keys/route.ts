import { enterprise } from "@linkos/api";
import { parse, route } from "@/lib/server";

// F-140 API keys (sha256-hashed; plaintext returned once)
export const GET = route<{ id: string }>(async ({ ctx, params }) => ({ keys: await enterprise.listApiKeys(ctx, params.id) }));
export const POST = route<{ id: string }>(async ({ ctx, params, body }) => enterprise.createApiKey(ctx, params.id, parse(enterprise.apiKeyInput, body)), { status: 201 });
