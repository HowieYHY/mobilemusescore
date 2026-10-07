// Service worker: keeps the whole app on the device so scores open and play
// offline after the first visit. The list of files comes from precache.json,
// written at build time by scripts/gen-precache.mjs.

// Replaced with the build's content hash by scripts/gen-precache.mjs, so every
// build is a new service worker and a new cache (old ones are deleted).
const VERSION = "__BUILD_VERSION__";
const CACHE = "pocketscore-" + VERSION;

self.addEventListener("install", (event) => {
    event.waitUntil((async () => {
        const cache = await caches.open(CACHE);
        const res = await fetch("precache.json", { cache: "no-store" });
        const { files } = await res.json();
        // big files first is fine; addAll fails as a whole, so add one by one
        for (const f of files) {
            try {
                const r = await fetch(f.url, { cache: "no-store" });
                if (r.ok) {
                    await cache.put(new URL(f.url, self.registration.scope).href, r);
                }
            } catch (err) {
                // offline during install: the fetch handler fills gaps later
            }
        }
        await self.skipWaiting();
    })());
});

self.addEventListener("activate", (event) => {
    event.waitUntil((async () => {
        for (const key of await caches.keys()) {
            if (key !== CACHE) {
                await caches.delete(key);
            }
        }
        await self.clients.claim();
    })());
});

// Cache first (everything here is versioned by the build), falling back to the
// network and remembering what it returns.
self.addEventListener("fetch", (event) => {
    const req = event.request;
    if (req.method !== "GET" || new URL(req.url).origin !== self.location.origin) {
        return;
    }
    event.respondWith((async () => {
        const cache = await caches.open(CACHE);
        const url = new URL(req.url);
        const key = url.pathname.endsWith("/") ? url.href + "index.html" : url.href;
        const hit = await cache.match(key, { ignoreSearch: true }) || await cache.match(req, { ignoreSearch: true });
        if (hit) {
            return hit;
        }
        try {
            const res = await fetch(req);
            if (res.ok && res.type === "basic") {
                cache.put(key, res.clone());
            }
            return res;
        } catch (err) {
            if (req.mode === "navigate") {
                const shell = await cache.match(new URL("index.html", self.registration.scope).href);
                if (shell) {
                    return shell;
                }
            }
            throw err;
        }
    })());
});
