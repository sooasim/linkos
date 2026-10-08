/**
 * CSRF guard for state-changing requests: the browser's Origin must be this site.
 * "This site" is the Host the request arrived on (X-Forwarded-Host behind a proxy) or the configured public
 * origin (APP_ORIGIN). The second covers proxies that rewrite the host, e.g. GitHub Codespaces port forwarding
 * sends X-Forwarded-Host: localhost:3000 while the browser is on https://<name>-3000.app.github.dev.
 * No Origin header (same-origin GET forms, server-to-server, API keys) is left to the other checks.
 */
export function isAllowedOrigin(origin: string | null | undefined, host: string | null | undefined, appOrigin?: string | null): boolean {
  if (!origin) return true;
  let originHost: string;
  try {
    originHost = new URL(origin).host;
  } catch {
    return false;
  }
  if (host && originHost === host) return true;
  if (appOrigin) {
    try {
      if (new URL(appOrigin).origin === new URL(origin).origin) return true;
    } catch {
      /* malformed APP_ORIGIN never widens access */
    }
  }
  return !host; // no Host to compare against: unchanged from before (allowed)
}
