// The owner's private usage count: how many installs there are, how often they come back and for how
// long. It sends one anonymous heartbeat (a random id made on this device, the version, installed or
// browser, seconds in front and seconds of playing) to the owner's own counter (tracker/worker.js).
// No score name, file, note, IP address or account is sent. It stays off when no counter address was
// built in (VITE_USAGE_URL: the dev server and the tests have none), inside the Reso website's
// preview, and when the reader switches it off in Settings.

export const USAGE_URL: string = ((import.meta.env.VITE_USAGE_URL as string | undefined) || "").replace(/\/+$/, "");

const ID_KEY = "pocketscore.usage.id";
const BEAT_MS = 30_000;       // a heartbeat while the app is in front
const TICK_MS = 5_000;        // time is counted in steps of this
const NEW_VISIT_MS = 30 * 60_000; // away longer than this: the next time is a new visit

function randomId(): string {
    try {
        return crypto.randomUUID();
    } catch {
        return Array.from({ length: 4 }, () => Math.random().toString(16).slice(2, 10)).join("-");
    }
}

function installId(): string | null {
    try {
        let id = localStorage.getItem(ID_KEY);
        if (!id || !/^[a-z0-9-]{8,40}$/.test(id)) {
            id = randomId();
            localStorage.setItem(ID_KEY, id);
        }
        return id;
    } catch {
        return null; // storage blocked: without a stable id nothing can be counted honestly
    }
}

export interface UsageHooks {
    version: string;
    /** false in a preview, or when the reader has switched sharing off */
    enabled: () => boolean;
    playing: () => boolean;
}

/** Returns the function that stops it (every subscription gives one back). */
export function startUsage(hooks: UsageHooks): () => void {
    if (!USAGE_URL) {
        return () => {};
    }
    const id = installId();
    if (!id) {
        return () => {};
    }
    const mode = (matchMedia("(display-mode: standalone)").matches || (navigator as any).standalone) ? "app" : "tab";
    let sid = randomId();
    let secs = 0;
    let play = 0;
    let last = Date.now();
    let sentSecs = -1;
    let sentPlay = -1;
    let lastBeat = 0;
    let hiddenAt = 0;

    function send(force = false) {
        if (!hooks.enabled() || (!force && secs === sentSecs && play === sentPlay)) {
            return;
        }
        sentSecs = secs;
        sentPlay = play;
        lastBeat = Date.now();
        // text/plain keeps it a plain request (no preflight); keepalive lets it finish as the page closes
        fetch(USAGE_URL + "/ping", {
            method: "POST",
            body: JSON.stringify({ id, sid, v: hooks.version, mode, secs: Math.round(secs), play: Math.round(play) }),
            headers: { "content-type": "text/plain" },
            keepalive: true,
            credentials: "omit",
        }).catch(() => {}); // offline or blocked: the next one carries the same totals
    }

    // `count`: the page was in front since the last step (also true as it goes away)
    function tick(count = document.visibilityState === "visible") {
        const now = Date.now();
        if (count) {
            const dt = Math.min((now - last) / 1000, TICK_MS / 500); // a frozen page doesn't count the gap
            secs += dt;
            if (hooks.playing()) {
                play += dt;
            }
            if (now - lastBeat >= BEAT_MS) {
                send(true);
            }
        }
        last = now;
    }

    function onVisibility() {
        const now = Date.now();
        if (document.visibilityState === "hidden") {
            tick(true);
            hiddenAt = now;
            send();
        } else {
            if (hiddenAt && now - hiddenAt > NEW_VISIT_MS) {
                sid = randomId();
                secs = 0;
                play = 0;
                sentSecs = sentPlay = -1;
            }
            last = now;
            send(true);
        }
    }

    function onGone() {
        tick(true);
        send(true);
    }

    const timer = window.setInterval(() => tick(), TICK_MS);
    document.addEventListener("visibilitychange", onVisibility);
    window.addEventListener("pagehide", onGone);
    if (document.visibilityState === "visible") {
        // a moment in, so a page closed at once isn't counted
        window.setTimeout(() => send(true), 3000);
    }
    return () => {
        window.clearInterval(timer);
        document.removeEventListener("visibilitychange", onVisibility);
        window.removeEventListener("pagehide", onGone);
    };
}
