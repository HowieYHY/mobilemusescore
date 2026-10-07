import { Engine } from "./engine/engine";
import type { CursorInfo, ScoreInfo, TrackInfo, ViewMode } from "./engine/protocol";
import { CSS_PX_PER_INCH, UNITS_PER_INCH, drawPage, ensureFonts, ensureImages } from "./render/pagerenderer";

const $ = <T extends HTMLElement>(id: string) => document.getElementById(id) as T;

const ui = {
    fileInput: $<HTMLInputElement>("file-input"),
    title: $("score-title"),
    viewMode: $<HTMLSelectElement>("view-mode"),
    status: $("status"),
    viewer: $("viewer"),
    empty: $("empty"),
    pages: $("pages"),
    zoomIn: $<HTMLButtonElement>("zoom-in"),
    zoomOut: $<HTMLButtonElement>("zoom-out"),
    zoomLabel: $("zoom-label"),
    rewind: $<HTMLButtonElement>("rewind"),
    play: $<HTMLButtonElement>("play"),
    seek: $<HTMLInputElement>("seek"),
    time: $("time"),
    bar: $("bar"),
    duration: $("duration"),
    mixerToggle: $<HTMLButtonElement>("mixer-toggle"),
    mixer: $("mixer"),
    mixerBody: $("mixer-body"),
    mixerClose: $<HTMLButtonElement>("mixer-close"),
};

const engine = new Engine();

const ICON_PLAY = `<svg viewBox="0 0 24 24" width="24" height="24" aria-hidden="true"><path d="M8 5v14l11-7z" fill="currentColor"/></svg>`;
const ICON_PAUSE = `<svg viewBox="0 0 24 24" width="24" height="24" aria-hidden="true"><path d="M6 5h4v14H6zM14 5h4v14h-4z" fill="currentColor"/></svg>`;

const state = {
    score: null as ScoreInfo | null,
    zoom: 1,
    pageOps: new Map<number, any[]>(),
    pageEls: [] as HTMLDivElement[],
    rendered: new Set<number>(),
    playing: false,
    duration: 0,
    position: 0,
    seeking: false,
    followUntil: 0, // pause auto-follow while the reader scrolls
    tracks: [] as TrackInfo[],
    playbackReady: false,
    masterDb: 0,
};

// ---------------------------------------------------------------- status

let statusTimer = 0;
function setStatus(text: string, kind: "info" | "error" = "info", autoHideMs = 0) {
    ui.status.hidden = !text;
    ui.status.textContent = text;
    ui.status.classList.toggle("error", kind === "error");
    clearTimeout(statusTimer);
    if (autoHideMs) {
        statusTimer = window.setTimeout(() => (ui.status.hidden = true), autoHideMs);
    }
}

engine.on("error", (e) => setStatus(e.message, "error"));
engine.on("resources", (p) => {
    if (p.done < p.total) {
        setStatus(`Preparing MuseScore engine… ${Math.round(p.done / p.total * 100)}%`);
    }
});
engine.on("engineReady", () => setStatus("Ready. Open a score.", "info", 2500));
engine.on("audioStatus", (s) => {
    if (s.text) {
        setStatus(s.text);
    } else if (!state.playbackReady && state.score) {
        setStatus("Loading instrument sounds…");
    } else {
        setStatus("");
    }
});

// ---------------------------------------------------------------- time

function fmt(secs: number) {
    secs = Math.max(0, secs);
    const m = Math.floor(secs / 60);
    const s = Math.floor(secs % 60);
    return `${m}:${String(s).padStart(2, "0")}`;
}

// ---------------------------------------------------------------- pages

function unitsToCss(u: number) {
    return u / UNITS_PER_INCH * CSS_PX_PER_INCH * state.zoom;
}

function buildPages() {
    ui.pages.innerHTML = "";
    state.pageEls = [];
    state.rendered.clear();
    const score = state.score;
    if (!score) {
        return;
    }
    const horizontal = ui.viewMode.value === "continuous_v";
    ui.pages.style.flexDirection = horizontal ? "row" : "column";
    score.pages.forEach((p, i) => {
        const el = document.createElement("div");
        el.className = "page";
        el.dataset.index = String(i);
        el.style.width = unitsToCss(p.w) + "px";
        el.style.height = unitsToCss(p.h) + "px";
        ui.pages.appendChild(el);
        state.pageEls.push(el);
        observer.observe(el);
    });
    ui.zoomLabel.textContent = Math.round(state.zoom * 100) + "%";
}

const observer = new IntersectionObserver((entries) => {
    for (const e of entries) {
        const i = Number((e.target as HTMLElement).dataset.index);
        if (e.isIntersecting) {
            void renderPage(i);
        }
    }
}, { root: ui.viewer, rootMargin: "600px" });

let renderGeneration = 0;

async function renderPage(i: number) {
    if (state.rendered.has(i) || !state.score) {
        return;
    }
    state.rendered.add(i);
    const gen = renderGeneration;
    let ops = state.pageOps.get(i);
    if (!ops) {
        ops = JSON.parse(await engine.page(i)) as any[];
        if (gen !== renderGeneration) {
            return;
        }
        state.pageOps.set(i, ops);
    }
    await Promise.all([ensureFonts(ops, engine.base), ensureImages(ops)]);
    if (gen !== renderGeneration) {
        return;
    }

    const el = state.pageEls[i];
    const page = state.score.pages[i];
    const dpr = Math.min(window.devicePixelRatio || 1, 3);
    // keep canvases within mobile limits (about 16 megapixels)
    let scale = unitsToCss(1) * dpr;
    const maxPixels = 16e6;
    if (page.w * page.h * scale * scale > maxPixels) {
        scale = Math.sqrt(maxPixels / (page.w * page.h));
    }
    const canvas = document.createElement("canvas");
    canvas.width = Math.ceil(page.w * scale);
    canvas.height = Math.ceil(page.h * scale);
    const ctx = canvas.getContext("2d")!;
    ctx.fillStyle = "#fff";
    ctx.fillRect(0, 0, canvas.width, canvas.height);
    drawPage(ctx, ops, scale);
    el.querySelector("canvas")?.remove();
    el.prepend(canvas);
}

function rerenderAll(keepOps: boolean) {
    renderGeneration++;
    if (!keepOps) {
        state.pageOps.clear();
    }
    // keep the reader's place: remember the fraction scrolled
    const v = ui.viewer;
    const fx = v.scrollLeft / Math.max(1, v.scrollWidth);
    const fy = v.scrollTop / Math.max(1, v.scrollHeight);
    buildPages();
    v.scrollLeft = fx * v.scrollWidth;
    v.scrollTop = fy * v.scrollHeight;
    showCursor(lastCursor);
}

// Zoom at which the first page fills the screen width (capped at 100%)
function fitWidthZoom() {
    const p = state.score?.pages[0];
    if (!p) {
        return 1;
    }
    const pageCss = p.w / UNITS_PER_INCH * CSS_PX_PER_INCH;
    return Math.min(1, Math.max(0.3, (ui.viewer.clientWidth - 16) / pageCss));
}

function setZoom(z: number) {
    state.zoom = Math.min(4, Math.max(0.3, z));
    rerenderAll(true);
}

ui.zoomIn.onclick = () => setZoom(state.zoom * 1.25);
ui.zoomOut.onclick = () => setZoom(state.zoom / 1.25);

// pinch to zoom: scale with CSS during the gesture, redraw at the end
{
    let startDist = 0;
    let startZoom = 1;
    let pinching = false;
    const dist = (t: TouchList) => Math.hypot(t[0].clientX - t[1].clientX, t[0].clientY - t[1].clientY);
    ui.viewer.addEventListener("touchstart", (e) => {
        if (e.touches.length === 2) {
            pinching = true;
            startDist = dist(e.touches);
            startZoom = state.zoom;
        }
    }, { passive: true });
    ui.viewer.addEventListener("touchmove", (e) => {
        if (pinching && e.touches.length === 2) {
            e.preventDefault();
            const f = dist(e.touches) / startDist;
            ui.pages.style.transform = `scale(${f})`;
        }
    }, { passive: false });
    ui.viewer.addEventListener("touchend", (e) => {
        if (pinching && e.touches.length < 2) {
            pinching = false;
            const m = /scale\(([\d.]+)\)/.exec(ui.pages.style.transform);
            ui.pages.style.transform = "";
            if (m) {
                setZoom(startZoom * Number(m[1]));
            }
        }
    });
}

// Tap a note or rest to play from there (a tap, not a scroll or pinch)
{
    let down: { x: number; y: number; t: number; id: number } | null = null;
    ui.pages.addEventListener("pointerdown", (e) => {
        down = e.isPrimary ? { x: e.clientX, y: e.clientY, t: performance.now(), id: e.pointerId } : null;
    });
    ui.pages.addEventListener("pointercancel", () => (down = null));
    ui.pages.addEventListener("pointerup", async (e) => {
        const d = down;
        down = null;
        if (!d || d.id !== e.pointerId || !state.score) {
            return;
        }
        if (Math.hypot(e.clientX - d.x, e.clientY - d.y) > 10 || performance.now() - d.t > 500) {
            return;
        }
        const pageEl = (e.target as HTMLElement).closest(".page") as HTMLElement | null;
        if (!pageEl) {
            return;
        }
        const r = pageEl.getBoundingClientRect();
        const toUnits = (css: number) => css / (CSS_PX_PER_INCH * state.zoom) * UNITS_PER_INCH;
        const c = await engine.seekAt(Number(pageEl.dataset.index), toUnits(e.clientX - r.left), toUnits(e.clientY - r.top));
        if (c) {
            state.followUntil = 0;
        }
    });
}

// pause following the cursor while the reader scrolls by hand
for (const ev of ["wheel", "touchmove"]) {
    ui.viewer.addEventListener(ev, () => (state.followUntil = performance.now() + 2500), { passive: true });
}

// ---------------------------------------------------------------- cursor

let lastCursor: CursorInfo | null = null;
let cursorEl: HTMLDivElement | null = null;
let lastFollowCheck = 0;

function showCursor(c: CursorInfo | null) {
    lastCursor = c;
    if (!c || c.page === undefined || !state.pageEls[c.page]) {
        cursorEl?.remove();
        return;
    }
    if (!cursorEl) {
        cursorEl = document.createElement("div");
        cursorEl.className = "cursor";
    }
    const pageEl = state.pageEls[c.page];
    if (cursorEl.parentElement !== pageEl) {
        pageEl.appendChild(cursorEl);
    }
    const w = Math.max(3, unitsToCss(c.w!));
    cursorEl.style.transform = `translate(${unitsToCss(c.x!)}px, ${unitsToCss(c.y!)}px)`;
    cursorEl.style.width = w + "px";
    cursorEl.style.height = unitsToCss(c.h!) + "px";

    // checking the view means reading layout, so a few times a second is enough
    const now = performance.now();
    if (state.playing && now > state.followUntil && now - lastFollowCheck > 200) {
        lastFollowCheck = now;
        followCursor(pageEl);
    }
}

// Follow in one step when the cursor nears the edge of the view
function followCursor(pageEl: HTMLElement) {
    if (!cursorEl) {
        return;
    }
    const v = ui.viewer.getBoundingClientRect();
    const r = cursorEl.getBoundingClientRect();
    const margin = 0.15;
    if (r.bottom > v.bottom - v.height * margin || r.top < v.top) {
        ui.viewer.scrollTop += r.top - v.top - v.height * 0.2;
    }
    if (r.right > v.right - v.width * margin || r.left < v.left) {
        ui.viewer.scrollLeft += r.left - v.left - v.width * 0.25;
    }
    void pageEl;
}

// The audio engine renders ahead and reports its position in bursts, so while
// playing the cursor is moved every frame from the audio clock, anchored to
// those reports, using the score's timeline (see Session::timelineJson).
type TimelinePoint = [number, number, number, number, number]; // secs, page, x, y, h
let timeline: TimelinePoint[] = [];
const anchor = { secs: 0, clock: 0 };

async function loadTimeline() {
    timeline = await engine.timeline();
}

function cursorFromTimeline(secs: number): CursorInfo | null {
    if (!timeline.length) {
        return null;
    }
    let lo = 0;
    let hi = timeline.length - 1;
    if (secs < timeline[0][0]) {
        hi = 0;
    }
    while (lo < hi) {
        const mid = (lo + hi + 1) >> 1;
        if (timeline[mid][0] <= secs) {
            lo = mid;
        } else {
            hi = mid - 1;
        }
    }
    const a = timeline[lo];
    const b = timeline[lo + 1];
    let x = a[2];
    if (b && b[1] === a[1] && b[3] === a[3] && b[0] > a[0]) {
        x = a[2] + (b[2] - a[2]) * Math.min(1, (secs - a[0]) / (b[0] - a[0]));
    }
    return { secs, duration: state.duration, page: a[1], x, y: a[3], w: 0.4 * (state.score?.spatium || 25), h: a[4] };
}

engine.on("position", (c: CursorInfo) => {
    state.duration = c.duration || state.duration;
    ui.bar.textContent = c.measure ? `Bar ${c.measure}` : "";
    const clock = engine.audioTime;
    if (state.playing && clock > 0) {
        // re-anchor only when the clock estimate has drifted (reports come in bursts)
        const predicted = anchor.secs + (clock - anchor.clock);
        if (Math.abs(predicted - c.secs) > 0.08) {
            anchor.secs = c.secs;
            anchor.clock = clock;
        }
        return;
    }
    anchor.secs = c.secs;
    anchor.clock = clock;
    showPosition(c.secs, c);
});

function showPosition(secs: number, fallback?: CursorInfo) {
    state.position = secs;
    if (!state.seeking) {
        ui.seek.value = String(Math.round(secs / Math.max(1, state.duration) * 1000));
    }
    ui.time.textContent = fmt(secs);
    showCursor(cursorFromTimeline(secs) || fallback || null);
}

function animate() {
    if (state.playing) {
        const secs = Math.min(state.duration, Math.max(0, anchor.secs + (engine.audioTime - anchor.clock)));
        showPosition(secs);
    }
    requestAnimationFrame(animate);
}
requestAnimationFrame(animate);

engine.on("status", (s) => {
    const nowPlaying = s.status === "playing";
    if (nowPlaying && !state.playing) {
        anchor.secs = state.position;
        anchor.clock = engine.audioTime;
    }
    state.playing = nowPlaying;
    ui.play.innerHTML = state.playing ? ICON_PAUSE : ICON_PLAY;
    ui.play.setAttribute("aria-label", state.playing ? "Pause" : "Play");
});

// ---------------------------------------------------------------- transport

ui.play.onclick = async () => {
    if (!state.score) {
        return;
    }
    if (!engine.audioRunning || !state.playbackReady) {
        setStatus("Starting audio…");
        try {
            await engine.startAudio();
        } catch (err: any) {
            setStatus("Audio could not start: " + (err && err.message || err), "error");
            return;
        }
        if (!state.playbackReady) {
            pendingPlay = true;
            return;
        }
    }
    state.playing ? engine.pause() : engine.play();
};

let pendingPlay = false;

ui.rewind.onclick = () => {
    void engine.stop();
    void engine.seek(0);
};

ui.seek.addEventListener("input", () => {
    state.seeking = true;
    const secs = Number(ui.seek.value) / 1000 * state.duration;
    ui.time.textContent = fmt(secs);
});
ui.seek.addEventListener("change", () => {
    const secs = Number(ui.seek.value) / 1000 * state.duration;
    state.seeking = false;
    state.followUntil = 0;
    void engine.seek(secs);
});

// ---------------------------------------------------------------- mixer

function dbLabel(db: number) {
    return (db > 0 ? "+" : "") + db.toFixed(1) + " dB";
}

function buildMixer() {
    ui.mixerBody.innerHTML = "";

    const master = document.createElement("div");
    master.className = "strip master";
    master.innerHTML = `<div class="name">Master</div><span class="m"></span><span class="s"></span>
        <input class="vol" type="range" min="-60" max="12" step="0.5" aria-label="Master volume">
        <span class="db"></span>`;
    const mvol = master.querySelector<HTMLInputElement>(".vol")!;
    const mdb = master.querySelector<HTMLElement>(".db")!;
    mvol.value = String(state.masterDb);
    mdb.textContent = dbLabel(state.masterDb);
    mvol.oninput = () => {
        state.masterDb = Number(mvol.value);
        mdb.textContent = dbLabel(state.masterDb);
        void engine.setMasterVolume(state.masterDb);
    };
    ui.mixerBody.appendChild(master);

    for (const t of state.tracks) {
        const row = document.createElement("div");
        row.className = "strip" + (t.forceMute ? " forced" : "");
        row.innerHTML = `
            <div class="name"></div>
            <button class="toggle m" aria-label="Mute">M</button>
            <button class="toggle s" aria-label="Solo">S</button>
            <input class="vol" type="range" min="-60" max="12" step="0.5" aria-label="Volume">
            <span class="db"></span>
            <div class="note"></div>
            <label class="rev">Reverb <input type="range" min="0" max="100" step="1" aria-label="Reverb send"></label>`;
        const name = row.querySelector<HTMLElement>(".name")!;
        name.textContent = t.title;
        if (t.sound) {
            const small = document.createElement("small");
            small.textContent = t.sound;
            name.appendChild(small);
        }
        row.querySelector<HTMLElement>(".note")!.textContent = t.note ? "⚠ " + t.note + " — playing MS Basic instead." : "";
        const m = row.querySelector<HTMLButtonElement>(".m")!;
        const s = row.querySelector<HTMLButtonElement>(".s")!;
        const vol = row.querySelector<HTMLInputElement>(".vol")!;
        const db = row.querySelector<HTMLElement>(".db")!;
        const rev = row.querySelector<HTMLInputElement>(".rev input")!;
        m.classList.toggle("on", t.mute);
        s.classList.toggle("on", t.solo);
        vol.value = String(t.volume);
        db.textContent = dbLabel(t.volume);
        rev.value = String(Math.round(t.reverb * 100));
        if (t.metronome) {
            s.style.visibility = "hidden";
            row.querySelector<HTMLElement>(".rev")!.style.visibility = "hidden";
        }

        m.onclick = async () => {
            await engine.setMute(t.key, !t.mute);
            await refreshTracks();
        };
        s.onclick = async () => {
            await engine.setSolo(t.key, !t.solo);
            await refreshTracks();
        };
        vol.oninput = () => {
            t.volume = Number(vol.value);
            db.textContent = dbLabel(t.volume);
            void engine.setVolume(t.key, t.volume);
        };
        rev.oninput = () => void engine.setReverb(t.key, Number(rev.value) / 100);

        ui.mixerBody.appendChild(row);
    }
}

async function refreshTracks() {
    state.tracks = await engine.tracks();
    buildMixer();
}

ui.mixerToggle.onclick = () => {
    ui.mixer.hidden = !ui.mixer.hidden;
    if (!ui.mixer.hidden) {
        void refreshTracks();
    }
};
ui.mixerClose.onclick = () => (ui.mixer.hidden = true);

engine.on("playbackReady", (tracks: TrackInfo[]) => {
    state.playbackReady = true;
    state.tracks = tracks;
    ui.mixerToggle.disabled = false;
    if (!ui.mixer.hidden) {
        buildMixer();
    }
    setStatus("");
    if (pendingPlay) {
        pendingPlay = false;
        void engine.play();
    }
});

// ---------------------------------------------------------------- opening

ui.fileInput.onchange = async () => {
    const file = ui.fileInput.files?.[0];
    ui.fileInput.value = "";
    if (file) {
        await openScore(file.name, await file.arrayBuffer());
    }
};

async function openScore(name: string, data: ArrayBuffer) {
    if (!/\.(mscz|mscx)$/i.test(name)) {
        setStatus(`"${name}" is not a MuseScore file. Choose a .mscz file.`, "error");
        return;
    }
    setStatus(`Opening ${name}…`);
    state.playbackReady = false;
    state.pageOps.clear();
    ui.mixerToggle.disabled = true;
    const res = await engine.load(name, data);
    if (!res.ok || !res.score) {
        setStatus(res.error || "Could not open this score.", "error");
        return;
    }
    state.score = res.score;
    state.duration = res.score.duration;
    state.position = 0;
    state.tracks = res.score.tracks;
    lastCursor = null;
    ui.title.textContent = res.score.title || name.replace(/\.(mscz|mscx)$/i, "");
    ui.empty.hidden = true;
    ui.viewMode.disabled = false;
    ui.viewMode.value = "page";
    ui.play.disabled = false;
    ui.rewind.disabled = false;
    ui.seek.disabled = false;
    ui.duration.textContent = fmt(state.duration);
    ui.time.textContent = "0:00";
    ui.seek.value = "0";
    state.zoom = fitWidthZoom();
    renderGeneration++;
    buildPages();
    void loadTimeline();
    ui.viewer.scrollTop = 0;
    ui.viewer.scrollLeft = 0;
    setStatus(engine.audioRunning ? "Loading instrument sounds…" : "Tap Play to start playback.", "info", engine.audioRunning ? 0 : 4000);
}

ui.viewMode.onchange = async () => {
    setStatus("Laying out…");
    state.score = await engine.setViewMode(ui.viewMode.value as ViewMode);
    await loadTimeline();
    rerenderAll(false);
    setStatus("");
};

// Offline: keep the app, engine and sounds on the device (production builds only)
// Not inside the Android app, which already ships every file.
const inNativeApp = !!(window as any).Capacitor?.isNativePlatform?.();
if ("serviceWorker" in navigator && import.meta.env.PROD && !inNativeApp) {
    navigator.serviceWorker.register("./sw.js").catch((err) => console.warn("service worker:", err));
}

// The Android app used to register the service worker; remove it so it can't
// serve a stale copy of the app.
if (inNativeApp && "serviceWorker" in navigator) {
    navigator.serviceWorker.getRegistrations().then((regs) => regs.forEach((r) => r.unregister())).catch(() => {});
    caches?.keys().then((keys) => keys.forEach((k) => caches.delete(k))).catch(() => {});
}

// Let tests and the console drive the app
(window as any).app = { engine, state, openScore };
