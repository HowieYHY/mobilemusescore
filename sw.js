// Service worker: keeps the whole app on the device so scores open and play
// offline after the first visit. The list of files comes from precache.json,
// written at build time by scripts/gen-precache.mjs.

// Replaced with the build's content hash by scripts/gen-precache.mjs, so every
// build is a new service worker and a new cache (old ones are deleted).
const VERSION = "da69f21704e59b22";
const CACHE = "pocketscore-" + VERSION;

async function sha1(res) {
    const digest = await crypto.subtle.digest("SHA-1", await res.arrayBuffer());
    return Array.from(new Uint8Array(digest), (b) => b.toString(16).padStart(2, "0")).join("");
}

// The copy of `url` kept by an earlier version, if any
async function previous(url) {
    for (const key of await caches.keys()) {
        if (key !== CACHE && key.startsWith("pocketscore-")) {
            const hit = await (await caches.open(key)).match(url);
            if (hit) {
                return hit;
            }
        }
    }
    return null;
}

async function tellPages(msg) {
    for (const c of await self.clients.matchAll({ includeUncontrolled: true })) {
        c.postMessage(msg);
    }
}

self.addEventListener("install", (event) => {
    event.waitUntil((async () => {
        const cache = await caches.open(CACHE);
        const res = await fetch("precache.json", { cache: "no-store" });
        const { files } = await res.json();
        const total = files.reduce((a, f) => a + f.size, 0);
        let done = 0;
        let lastTold = 0;
        // one by one (addAll fails as a whole). An update keeps the files that
        // haven't changed (same content hash) instead of downloading the whole
        // app again, so it finishes quickly, before the app is closed.
        for (const f of files) {
            const url = new URL(f.url, self.registration.scope).href;
            try {
                const prev = f.h ? await previous(url) : null;
                if (prev && await sha1(prev.clone()) === f.h) {
                    await cache.put(url, prev);
                } else {
                    const r = await fetch(f.url, { cache: "no-store" });
                    if (r.ok) {
                        await cache.put(url, r);
                    }
                }
            } catch (err) {
                // offline during install: the fetch handler fills gaps later
            }
            done += f.size;
            if (done - lastTold > total / 50) {
                lastTold = done;
                await tellPages({ type: "sw-progress", done, total });
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
