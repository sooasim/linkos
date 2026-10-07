// LINKOS service worker
// - offline app shell (F-150): network-first navigations; capture/sync/event shells are cached so scanning,
//   notes and badge leads keep working without a network. API responses and token-bearing exchange links
//   (/x/, /c/) are never cached.
// - F-179 Background Sync: replays the encrypted IndexedDB outbox written by src/lib/offline.ts
//   (same Idempotency-Key per write → no duplicates). If a page is open it does the replay instead.
const VERSION = "linkos-v2";
const SHELL = ["/", "/c", "/manifest.webmanifest", "/icon.svg"];
// signed-in shells that are safe to keep offline (client-rendered; no personal data in the HTML)
const APP_SHELL = /^\/app\/(scan(\/import)?|sync|events\/[0-9a-f-]{36})\/?$/;
const SYNC_TAG = "linkos-outbox";

self.addEventListener("install", (e) => {
  e.waitUntil(caches.open(VERSION).then((c) => c.addAll(SHELL)).then(() => self.skipWaiting()));
});

self.addEventListener("activate", (e) => {
  e.waitUntil(caches.keys().then((keys) => Promise.all(keys.filter((k) => k !== VERSION).map((k) => caches.delete(k)))).then(() => self.clients.claim()));
});

self.addEventListener("message", (e) => {
  // sign-out / privacy: drop cached shells
  if (e.data && e.data.type === "clear-caches") e.waitUntil(caches.keys().then((keys) => Promise.all(keys.map((k) => caches.delete(k)))));
});

self.addEventListener("fetch", (e) => {
  const url = new URL(e.request.url);
  if (e.request.method !== "GET" || url.origin !== location.origin) return;
  // Never cache API responses or token-bearing exchange pages
  if (url.pathname.startsWith("/api/") || url.pathname.startsWith("/x/") || url.pathname.startsWith("/c/")) return;
  if (url.pathname.startsWith("/_next/static/")) {
    e.respondWith(
      caches.match(e.request).then(
        (hit) =>
          hit ||
          fetch(e.request).then((res) => {
            if (res.ok) {
              const copy = res.clone();
              caches.open(VERSION).then((c) => c.put(e.request, copy));
            }
            return res;
          }),
      ),
    );
    return;
  }
  if (e.request.mode === "navigate") {
    const shell = APP_SHELL.test(url.pathname);
    e.respondWith(
      fetch(e.request)
        .then((res) => {
          if (shell && res.ok && !res.redirected) {
            const copy = res.clone();
            caches.open(VERSION).then((c) => c.put(url.pathname, copy));
          }
          return res;
        })
        .catch(() =>
          caches
            .match(shell ? url.pathname : e.request)
            .then((hit) => hit || (url.pathname.startsWith("/app") ? caches.match("/app/scan") : null))
            .then((hit) => hit || caches.match("/")),
        ),
    );
  }
});

// ---------------------------------------------------------------- Background Sync (outbox replay)
self.addEventListener("sync", (e) => {
  if (e.tag === SYNC_TAG) e.waitUntil(replay());
});

async function replay() {
  const clients = await self.clients.matchAll({ type: "window" });
  if (clients.length) {
    // an open page owns the queue logic (shared with the unit-tested domain module)
    clients.forEach((c) => c.postMessage({ type: "flush-outbox" }));
    return;
  }
  const db = await openDb();
  if (!db) return;
  const key = await req(db.transaction("keys").objectStore("keys").get("aes"));
  if (!key) return;
  const recs = (await req(db.transaction("outbox").objectStore("outbox").getAll())) || [];
  const items = [];
  for (const r of recs) {
    try {
      items.push(JSON.parse(new TextDecoder().decode(await crypto.subtle.decrypt({ name: "AES-GCM", iv: r.enc.iv }, key, r.enc.data))));
    } catch (_) {
      /* unreadable */
    }
  }
  items.sort((a, b) => a.createdAt - b.createdAt);
  const blocked = new Set();
  const now = Date.now();
  let networkDown = false;
  for (const it of items) {
    if (blocked.has(it.entityKey)) continue;
    blocked.add(it.entityKey);
    if (it.status !== "pending" || it.nextAttemptAt > now || networkDown) continue;
    let res;
    try {
      res = await fetch("/api/v1" + it.path, {
        method: it.method,
        headers: { "content-type": "application/json", "idempotency-key": it.idempotencyKey, "x-linkos-replay": "1" },
        body: it.body === undefined ? undefined : JSON.stringify(it.body),
        credentials: "same-origin",
      });
    } catch (_) {
      networkDown = true;
      continue;
    }
    if (res.ok) {
      await req(db.transaction("outbox", "readwrite").objectStore("outbox").delete(it.id));
      blocked.delete(it.entityKey);
      continue;
    }
    const body = await res.json().catch(() => ({}));
    const attempts = it.attempts + 1;
    let next;
    if (res.status === 409 && body.code === "version_conflict") {
      next = { ...it, attempts, status: "conflict", lastError: { status: 409, code: body.code, message: body.message || "" }, conflict: { serverVersion: (body.details && body.details.serverVersion) ?? null, current: (body.details && body.details.current) ?? null } };
    } else if (res.status >= 500 || res.status === 429 || res.status === 408 || res.status === 401) {
      const delay = Math.min(300000, 2000 * Math.pow(2, attempts - 1));
      next = { ...it, attempts, nextAttemptAt: Date.now() + delay, status: attempts >= 12 ? "failed" : "pending", lastError: { status: res.status, code: body.code || "http_" + res.status, message: body.message || "" } };
    } else {
      next = { ...it, attempts, status: "failed", lastError: { status: res.status, code: body.code || "http_" + res.status, message: body.message || "" } };
    }
    const iv = crypto.getRandomValues(new Uint8Array(12));
    const data = await crypto.subtle.encrypt({ name: "AES-GCM", iv }, key, new TextEncoder().encode(JSON.stringify(next)));
    await req(db.transaction("outbox", "readwrite").objectStore("outbox").put({ id: it.id, createdAt: it.createdAt, enc: { iv, data } }));
  }
  const after = await self.clients.matchAll({ type: "window" });
  after.forEach((c) => c.postMessage({ type: "outbox-replayed" }));
  if (networkDown) throw new Error("offline"); // let the browser retry the sync later
}

function openDb() {
  return new Promise((resolve) => {
    const r = indexedDB.open("linkos-offline");
    r.onsuccess = () => {
      const db = r.result;
      if (!db.objectStoreNames.contains("outbox") || !db.objectStoreNames.contains("keys")) {
        db.close();
        resolve(null);
      } else resolve(db);
    };
    r.onupgradeneeded = () => {
      // the page creates the schema; never create an empty DB from the worker
      r.transaction.abort();
    };
    r.onerror = () => resolve(null);
  });
}

function req(r) {
  return new Promise((resolve, reject) => {
    r.onsuccess = () => resolve(r.result);
    r.onerror = () => reject(r.error);
  });
}
