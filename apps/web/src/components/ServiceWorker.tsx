"use client";
import dynamic from "next/dynamic";
import { usePathname } from "next/navigation";
import { useEffect } from "react";

// Loaded only inside the signed-in app shell so the guest landing (/x/…) stays light (LCP budget).
const OfflineAgent = dynamic(() => import("./OfflineAgent"), { ssr: false });

/** PWA offline shell (F-043 Android PWA landing) + F-150/F-179 offline indicator and outbox replay. */
export function ServiceWorker() {
  const pathname = usePathname();
  useEffect(() => {
    if (process.env.NODE_ENV !== "production" || !("serviceWorker" in navigator)) return;
    navigator.serviceWorker.register("/sw.js", { scope: "/" }).catch(() => undefined);
  }, []);
  return pathname?.startsWith("/app") ? <OfflineAgent /> : null;
}
