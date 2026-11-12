// Service worker: keeps the whole app on the device so scores open and play
// offline after the first visit. The list of files comes from precache.json,
// written at build time by scripts/gen-precache.mjs.

// Replaced with the build's content hash by scripts/gen-precache.mjs, so every
// build is a new service worker and a new cache (old ones are deleted).
const VERSION = "aeb87b405b1b7dff";
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
        // files that could not be downloaded (the connection dropped, the server said no)
        let missing = 0;
        // one by one (addAll fails as a whole). An update keeps the files that
        // haven't changed (same content hash) instead of downloading the whole
        // app again, so it finishes quickly, before the app is closed.
        for (const f of files) {
            const url = new URL(f.url, self.registration.scope).href;
            try {
                // stored already by an earlier try of this same install that did not finish
                const mine = f.h ? await cache.match(url) : null;
                if (!mine || await sha1(mine) !== f.h) {
                    const prev = f.h ? await previous(url) : null;
                    if (prev && await sha1(prev.clone()) === f.h) {
                        await cache.put(url, prev);
                    } else {
                        const r = await fetch(f.url, { cache: "no-store" });
                        if (r.ok) {
                            await cache.put(url, r);
                        } else {
                            missing++;
                        }
                    }
                }
            } catch (err) {
                // a device with no room left keeps what fits, as before: the room comes back when
                // the older version's copy goes, and the fetch handler fills the gaps then
                if (!err || err.name !== "QuotaExceededError") {
                    missing++;
                }
            }
            done += f.size;
            if (done - lastTold > total / 50) {
                lastTold = done;
                await tellPages({ type: "sw-progress", done, total });
            }
        }
        // An update with files missing must not take over: activating deletes the older version's
        // complete copy, and the app would then need the network for what is missing (no sound, or no
        // engine, offline, where it worked before). Failing here keeps the older version as it is;
        // the browser tries again at the next visit, and what was downloaded this time is kept.
        // (A first install has nothing to lose: it goes on, and the fetch handler fills the gaps.)
        if (missing && self.registration.active) {
            await tellPages({ type: "sw-update-failed", missing });
            throw new Error(`update not installed: ${missing} file(s) could not be downloaded`);
        }
        await self.skipWaiting();
    })());
});

self.addEventListener("activate", (event) => {
    event.waitUntil((async () => {
        for (const key of await caches.keys()) {
            if (key !== CACHE && key !== SHARED) {
                await caches.delete(key);
            }
        }
        await self.clients.claim();
    })());
});

// A score shared to PocketScore from another app (Android's Share list, from
// the manifest's share_target) arrives as a form POST. Keep it until the app
// picks it up (main.ts, ?shared=1), then show the app.
const SHARED = "shared-score";

async function receiveShared(req) {
    try {
        const file = (await req.formData()).getAll("score").find((f) => f instanceof File);
        if (file) {
            const cache = await caches.open(SHARED);
            await cache.put(new URL("shared-score", self.registration.scope).href, new Response(file, {
                headers: { "x-name": encodeURIComponent(file.name || "shared.mscz") },
            }));
        }
    } catch (err) {
        // the app says there was nothing to open
    }
    return Response.redirect(new URL("./?shared=1", self.registration.scope).href, 303);
}

// Cache first (everything here is versioned by the build), falling back to the
// network and remembering what it returns.
self.addEventListener("fetch", (event) => {
    const req = event.request;
    if (req.method === "POST" && new URL(req.url).pathname.endsWith("/share")) {
        event.respondWith(receiveShared(req));
        return;
    }
    if (req.method !== "GET" || new URL(req.url).origin !== self.location.origin) {
        return;
    }
    event.respondWith((async () => {
        const cache = await caches.open(CACHE);
        const url = new URL(req.url);
        // a folder's page is kept as its index.html, whatever follows the "?" (href would put the
        // query in the middle: "/?shared=1index.html")
        const key = url.pathname.endsWith("/") ? url.origin + url.pathname + "index.html" : url.href;
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
