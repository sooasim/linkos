import Constants from "expo-constants";

/** LINKOS web/API origin (same Next.js app serves /api/v1). Override with EXPO_PUBLIC_API_ORIGIN. */
export const API_ORIGIN: string = (
  process.env.EXPO_PUBLIC_API_ORIGIN ??
  ((Constants.expoConfig?.extra as { apiOrigin?: string } | undefined)?.apiOrigin) ??
  "https://linkos.app"
).replace(/\/$/, "");

export const APP_USER_AGENT = "LINKOS-Mobile/1.0";
