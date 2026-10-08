// Page-side controller: starts the score engine worker and the audio engine
// worklet, connects them with a MessageChannel (MuseScore's audio RPC), and
// exposes a small promise-based API to the UI.

import type { CursorInfo, PracticeInfo, ScoreInfo, SoundList, TrackInfo, ViewMode, WorkerReply, WorkerRequest } from "./protocol";

type Listener = (data: any) => void;

// Requests without the id field; distributes over the union.
type Cmd = WorkerRequest extends infer R ? (R extends any ? Omit<R, "id"> : never) : never;

export const SOUND_FONT_PATH = "/sound/MS Basic.sf3";

export class Engine {
    private worker: Worker;
    private nextId = 1;
    private pending = new Map<number, { resolve: (v: any) => void; reject: (e: Error) => void }>();
    private listeners = new Map<string, Set<Listener>>();
    private ctx: AudioContext | null = null;
    private node: AudioWorkletNode | null = null;
    private rpcForAudio: MessagePort;
    private audioStarting: Promise<void> | null = null;
    private audioWorker: Worker | null = null;
    private lastLatency = -1;
    private clock = { t: 0, perf: 0, raw: 0, set: false };
    /** Gaps in the sound while playing (the device fell behind). */
    underruns = 0;
    /**
     * Playback self-check: recent problems (gaps in the sound, frames where the
     * page froze), newest last, for diagnosing a device (`app.engine.health`
     * in the console, e.g. over USB debugging). Not shown on screen.
     */
    health: { at: string; kind: string; detail: string }[] = [];

    note(kind: string, detail: string) {
        this.health.push({ at: new Date().toISOString().slice(11, 23), kind, detail });
        if (this.health.length > 100) {
            this.health.shift();
        }
    }
    /** For the playback check: how the audio engine is keeping up. */
    // load: share of the time the audio engine spends rendering while music
    // plays (null until measured); loadUnder: an upper bound instead, on
    // devices whose timer is too coarse to measure it (iPad)
    stats = { load: null as number | null, loadUnder: null as number | null, slowestMs: 0, queuedSecs: 0, targetSecs: 0 };
    readonly base: string;

    private lastStatus = "";

    constructor(base = import.meta.env.BASE_URL) {
        this.base = new URL(base, location.href).href;
        this.worker = new Worker(new URL("./core.worker.ts", import.meta.url), { type: "module" });
        this.worker.onmessage = (e: MessageEvent<WorkerReply>) => this.onWorkerMessage(e.data);
        this.worker.onerror = (e) => this.emit("error", { message: e.message });

        const channel = new MessageChannel();
        this.rpcForAudio = channel.port2;
        this.request({ cmd: "init", base: this.base, rpcPort: channel.port1 }, [channel.port1])
            .then(() => this.emit("engineReady", {}))
            .catch((err) => this.emit("error", { message: "Score engine failed to start: " + err.message }));
        this.on("status", (s) => {
            this.lastStatus = s.status;
            this.setPlaying(s.status === "playing");
        });
    }

    on(event: string, fn: Listener): () => void {
        if (!this.listeners.has(event)) {
            this.listeners.set(event, new Set());
        }
        this.listeners.get(event)!.add(fn);
        return () => this.listeners.get(event)!.delete(fn);
    }

    private emit(event: string, data: any) {
        this.listeners.get(event)?.forEach((fn) => fn(data));
    }

    private onWorkerMessage(msg: WorkerReply) {
        if (msg.type === "reply") {
            const p = this.pending.get(msg.id);
            if (p) {
                this.pending.delete(msg.id);
                msg.error ? p.reject(new Error(msg.error)) : p.resolve(msg.result);
            }
        } else if (msg.type === "event") {
            this.emit(msg.event, msg.data);
        } else if (msg.type === "log") {
            if (/ERROR|WARN/.test(msg.text)) {
                console.warn("[score engine]", msg.text);
            }
        }
    }

    private request<T = unknown>(cmd: Cmd, transfer: Transferable[] = []): Promise<T> {
        const id = this.nextId++;
        return new Promise<T>((resolve, reject) => {
            this.pending.set(id, { resolve, reject });
            this.worker.postMessage({ ...cmd, id }, transfer);
        });
    }

    // Can be called when a score opens, so the sounds load early: the audio
    // context then starts suspended (browsers only let sound out after a tap),
    // and calling this again from a tap resumes it.
    startAudio(): Promise<void> {
        if (this.audioStarting) {
            if (this.ctx && this.ctx.state !== "running") {
                void this.ctx.resume();
            }
            return this.audioStarting;
        }

        // iOS: play through the ringer/silent switch, like a music app
        const nav = navigator as any;
        if (nav.audioSession) {
            try {
                nav.audioSession.type = "playback";
            } catch (err) {
                // older Safari
            }
        }

        const ctx = new AudioContext({ latencyHint: "playback" });
        this.ctx = ctx;
        void ctx.resume();
        // "suspended" or (Safari) "interrupted" while playing means the device stopped the sound
        ctx.onstatechange = () => this.emit("audioState", ctx.state);

        this.audioStarting = (async () => {
            this.emit("audioStatus", { text: "Loading MS Basic sound font…" });
            const [sf] = await Promise.all([
                this.fetchSoundFont(),
                ctx.audioWorklet.addModule(this.base + "worklet/msaudio-worklet.js"),
            ]);

            // MuseScore's audio engine renders ahead in its own worker; the
            // AudioWorklet only plays from the queue it is sent.
            const node = new AudioWorkletNode(ctx, "msaudio", { numberOfInputs: 0, outputChannelCount: [2] });
            this.node = node;
            node.connect(ctx.destination);
            node.port.onmessage = (e) => {
                if (e.data.type === "queued") {
                    this.onQueued(e.data.frames);
                }
            };

            const worker = new Worker(this.base + "worklet/msaudio-worker.js", { type: "module" });
            this.audioWorker = worker;
            const ready = new Promise<void>((resolve, reject) => {
                worker.onmessage = (e) => {
                    const m = e.data;
                    if (m.type === "ready") {
                        resolve();
                    } else if (m.type === "stats") {
                        this.stats.load = m.load;
                        this.stats.loadUnder = m.loadUnder;
                        this.stats.slowestMs = m.slowestMs;
                        this.stats.targetSecs = m.target / ctx.sampleRate;
                    } else if (m.type === "underrun") {
                        this.underruns = m.count;
                        this.note("gap", `sound gap ${m.count}; queue now ${(this.stats.targetSecs * 1000).toFixed(0)} ms, engine load ${this.stats.load === null ? "?" : (this.stats.load * 100).toFixed(0) + "%"}`);
                        this.emit("stutter", { count: m.count });
                    } else if (m.type === "error") {
                        reject(new Error(m.text));
                    } else if (m.type === "log" && /ERROR|WARN|underrun/.test(m.text)) {
                        console.warn("[audio engine]", m.text);
                    }
                };
                worker.onerror = (e) => reject(new Error(e.message || "audio worker failed"));
            });

            const audioPath = new MessageChannel(); // engine worker -> worklet
            node.port.postMessage({ type: "init", inPort: audioPath.port2 }, [audioPath.port2]);

            // The score engine must be listening before the audio engine announces itself
            await this.request({ cmd: "startAudio", sampleRate: ctx.sampleRate, blockSize: 1024, soundFontUri: "file://" + SOUND_FONT_PATH });
            worker.postMessage({ type: "init", rpcPort: this.rpcForAudio, outPort: audioPath.port1, soundFont: sf, soundFontPath: SOUND_FONT_PATH, sampleRate: ctx.sampleRate },
                [this.rpcForAudio, audioPath.port1, sf]);
            await ready;
            this.emit("audioStatus", { text: "" });
        })();

        this.audioStarting.catch((err) => this.emit("error", { message: "Audio failed to start: " + err.message }));
        return this.audioStarting;
    }

    private async fetchSoundFont(): Promise<ArrayBuffer> {
        const res = await fetch(this.base + "sound/MS%20Basic.sf3");
        if (!res.ok) {
            throw new Error("MS Basic sound font not found (" + res.status + ")");
        }
        if (!res.body) {
            return res.arrayBuffer();
        }
        // Content-Length is the size on the wire, which is smaller than the data
        // when the server compresses it (GitHub Pages does), so it only drives
        // the progress estimate; the chunks are collected as they come.
        const SF_SIZE = 51278610; // MS Basic.sf3, for progress when compressed
        const wire = Number(res.headers.get("content-length")) || 0;
        const expected = res.headers.get("content-encoding") ? SF_SIZE : (wire || SF_SIZE);
        const chunks: Uint8Array[] = [];
        let received = 0;
        const reader = res.body.getReader();
        for (;;) {
            const { done, value } = await reader.read();
            if (done) {
                break;
            }
            chunks.push(value);
            received += value.length;
            const pct = Math.min(99, Math.round(received / expected * 100));
            this.emit("audioStatus", { text: `Loading MS Basic sound font… ${pct}%` });
        }
        const buf = new Uint8Array(received);
        let off = 0;
        for (const c of chunks) {
            buf.set(c, off);
            off += c.length;
        }
        return buf.buffer;
    }

    // How far the engine is ahead of the speaker: the queued audio plus the
    // device's own output latency. The score engine shifts the cursor and the
    // pause point by this much so they match what is heard.
    private onQueued(frames: number) {
        if (!this.ctx) {
            return;
        }
        this.stats.queuedSecs = frames / this.ctx.sampleRate;
        const out = (this.ctx as any).outputLatency || 0;
        const latency = frames / this.ctx.sampleRate + (this.ctx.baseLatency || 0) + out;
        if (Math.abs(latency - this.lastLatency) > 0.01) {
            this.lastLatency = latency;
            void this.request({ cmd: "latency", secs: latency });
        }
    }

    // Drop audio queued ahead of the speaker, so a seek, pause or stop is heard at once
    private flush() {
        this.node?.port.postMessage({ type: "flush" });
    }

    // The audio clock, in seconds (0 before audio starts). currentTime only
    // moves when the device takes a batch of audio, which on Android can be
    // ~10 times a second; the output timestamp says when that was, so the
    // clock can be read smoothly between batches.
    //
    // Both readings still move in steps on Android (some devices give no output
    // timestamp at all), so the clock used for the cursor runs on the system
    // clock and is pulled gently toward the audio clock whenever that gives a
    // new reading. It never steps backwards; a big difference (start, a stall,
    // resuming) is followed at once.
    get audioTime(): number {
        const ctx = this.ctx;
        if (!ctx) {
            return 0;
        }
        let raw = ctx.currentTime;
        const ts = ctx.state === "running" ? ctx.getOutputTimestamp?.() : null;
        if (ts && ts.performanceTime && ts.contextTime) {
            raw = ts.contextTime + (performance.now() - ts.performanceTime) / 1000;
        }
        const now = performance.now();
        const c = this.clock;
        if (!c.set || ctx.state !== "running") {
            Object.assign(c, { t: raw, perf: now, raw, set: true });
            return raw;
        }
        let t = c.t + (now - c.perf) / 1000;
        if (raw !== c.raw) { // a new reading of the audio clock
            const err = raw - t;
            if (Math.abs(err) > 0.25) {
                t = raw;
            } else {
                t += err * 0.1;
            }
        }
        t = Math.max(t, c.t);
        Object.assign(c, { t, perf: now, raw });
        return t;
    }

    /** Tests: freeze the audio engine for `ms`, as a busy phone might. */
    testStall(ms: number) {
        this.audioWorker?.postMessage({ type: "testStall", ms });
    }

    // Tell the audio engine whether music is playing: while stopped it keeps
    // only a little audio queued, so tapped notes sound without delay.
    private setPlaying(on: boolean) {
        this.audioWorker?.postMessage({ type: "playing", on });
    }

    timeline(): Promise<[number, number, number, number, number][]> { return this.request({ cmd: "timeline" }); }

    /** How long after Play the music reaches the speaker: the audio queued ahead while playing plus the device's own delay. */
    get playLatency(): number {
        const ctx = this.ctx;
        if (!ctx) {
            return 0;
        }
        const queued = this.stats.targetSecs || (16 * 1024) / ctx.sampleRate; // the worker's playing queue
        return queued + (ctx.baseLatency || 0) + ((ctx as any).outputLatency || 0);
    }

    get sampleRate(): number {
        return this.ctx ? this.ctx.sampleRate : 0;
    }

    get audioRunning() {
        return this.ctx?.state === "running";
    }

    /** Resolves once sound can be heard (after startAudio was called from a tap). */
    whenRunning(): Promise<void> {
        return this.ctx && this.ctx.state !== "running" ? this.ctx.resume() : Promise.resolve();
    }

    async load(name: string, data: ArrayBuffer): Promise<{ ok: boolean; error?: string; score?: ScoreInfo }> {
        return this.request({ cmd: "load", name, data }, [data]);
    }

    setViewMode(mode: ViewMode): Promise<ScoreInfo> { return this.request({ cmd: "viewMode", mode }); }
    page(index: number): Promise<string> { return this.request({ cmd: "page", index }); }
    cursor(secs: number): Promise<CursorInfo> { return this.request({ cmd: "cursor", secs }); }
    tracks(): Promise<TrackInfo[]> { return this.request({ cmd: "tracks" }); }
    play() { this.setPlaying(true); return this.request({ cmd: "play" }); }
    async pause() { await this.request({ cmd: "pause" }); this.setPlaying(false); this.flush(); }
    async stop() { await this.request({ cmd: "stop" }); this.setPlaying(false); this.flush(); }
    async seek(secs: number) { await this.request({ cmd: "seek", secs }); this.flush(); this.emit("seeked", {}); }
    // Move to the note or beat at a point on a page (page units); `radius` is
    // how far from the point a note may be. While stopped, that note sounds.
    async seekAt(page: number, x: number, y: number, radius = 0, playNote = false): Promise<CursorInfo | null> {
        const playing = this.lastStatus === "playing";
        const c = await this.request<CursorInfo | null>({ cmd: "seekAt", page, x, y, radius, playNote });
        if (playing) {
            this.flush(); // only playing audio is queued far ahead
        }
        if (c) {
            this.emit("seeked", {});
        }
        return c;
    }
    setVolume(key: number, db: number) { return this.request({ cmd: "volume", key, db }); }
    setBalance(key: number, value: number) { return this.request({ cmd: "balance", key, value }); }
    setMute(key: number, on: boolean) { return this.request({ cmd: "mute", key, on }); }
    setSolo(key: number, on: boolean) { return this.request({ cmd: "solo", key, on }); }
    setReverb(key: number, amount: number) { return this.request({ cmd: "reverb", key, amount }); }
    setSound(key: number, soundId: string) { return this.request({ cmd: "sound", key, soundId }); }
    sounds(): Promise<SoundList> { return this.request({ cmd: "sounds" }); }
    /** The master volume in dB (the score's saved setting until changed). */
    masterVolume(): Promise<number> { return this.request({ cmd: "getMasterVolume" }); }
    setMasterVolume(db: number) { return this.request({ cmd: "masterVolume", db }); }

    // Practice (desktop's Speed and Loop playback), at the play position the
    // reader sees (`at`, seconds). Changing the speed jumps the engine to the
    // same place in the music, so the queued audio is dropped.
    async setSpeed(multiplier: number, at: number): Promise<PracticeInfo> {
        const r: PracticeInfo = await this.request({ cmd: "speed", multiplier, at });
        this.flush();
        return r;
    }
    setLoopMarker(right: boolean, at: number): Promise<PracticeInfo> { return this.request({ cmd: "loopMarker", right, at }); }
    setLoop(on: boolean): Promise<PracticeInfo> { return this.request({ cmd: "loop", on }); }
    practice(): Promise<PracticeInfo> { return this.request({ cmd: "practice" }); }
}
