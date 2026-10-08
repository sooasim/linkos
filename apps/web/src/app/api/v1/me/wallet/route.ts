import { shareKit } from "@linkos/api";
import { route } from "@/lib/server";

// X-004 which wallet integrations are configured (missing env var names only — never their values)
export const GET = route(async () => shareKit.walletStatus());
