"use client";
// F-181 client helper: one cached fetch of evaluated, client-visible flags per page load.
// F-196 client helper: deterministic experiment assignment (exposure is recorded server-side).
import { useEffect, useState } from "react";

let flagsPromise: Promise<Record<string, boolean>> | null = null;

export function loadFlags(): Promise<Record<string, boolean>> {
  flagsPromise ??= fetch("/api/v1/flags", { credentials: "same-origin" })
    .then((r) => (r.ok ? r.json() : { flags: {} }))
    .then((j: { flags?: Record<string, boolean> }) => j.flags ?? {})
    .catch(() => ({}));
  return flagsPromise;
}

/** `undefined` while loading; unknown flags resolve to false (safe default). */
export function useFlag(key: string): boolean | undefined {
  const [on, setOn] = useState<boolean | undefined>(undefined);
  useEffect(() => {
    let live = true;
    void loadFlags().then((f) => live && setOn(f[key] ?? false));
    return () => {
      live = false;
    };
  }, [key]);
  return on;
}

/** Variant key, `null` when not enrolled / not running (render the default), `undefined` while loading. */
export function useExperiment(key: string): string | null | undefined {
  const [v, setV] = useState<string | null | undefined>(undefined);
  useEffect(() => {
    let live = true;
    fetch(`/api/v1/experiments/${encodeURIComponent(key)}/assignment`, { credentials: "same-origin", cache: "no-store" })
      .then((r) => (r.ok ? r.json() : { variant: null }))
      .then((j: { variant: string | null }) => live && setV(j.variant))
      .catch(() => live && setV(null));
    return () => {
      live = false;
    };
  }, [key]);
  return v;
}

/** First-party product event (allowlisted names only; never send PII in props). */
export function trackClient(name: "page_viewed" | "cta_clicked" | "share_opened", props?: Record<string, string | number | boolean>) {
  void fetch("/api/v1/analytics/events", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ name, props }), credentials: "same-origin", keepalive: true }).catch(() => undefined);
}
