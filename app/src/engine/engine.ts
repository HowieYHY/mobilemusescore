// Page-side controller: starts the score engine worker and the audio engine
// worklet, connects them with a MessageChannel (MuseScore's audio RPC), and
// exposes a small promise-based API to the UI.

import type { CursorInfo, ScoreInfo, TrackInfo, ViewMode, WorkerReply, WorkerRequest } from "./protocol";

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
    readonly base: string;

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

    // Must be called from a user gesture on iOS (tap), since browsers only
    // allow audio to start after one.
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

        this.audioStarting = (async () => {
            this.emit("audioStatus", { text: "Loading MS Basic sound font…" });
            const [sf] = await Promise.all([
                this.fetchSoundFont(),
                ctx.audioWorklet.addModule(this.base + "worklet/msaudio-worklet.js"),
            ]);

            const node = new AudioWorkletNode(ctx, "msaudio", { numberOfInputs: 0, outputChannelCount: [2] });
            this.node = node;
            node.connect(ctx.destination);

            const ready = new Promise<void>((resolve, reject) => {
                node.port.onmessage = (e) => {
                    const m = e.data;
                    if (m.type === "ready") {
                        resolve();
                    } else if (m.type === "error") {
                        reject(new Error(m.text));
                    } else if (m.type === "log" && /ERROR|WARN/.test(m.text)) {
                        console.warn("[audio engine]", m.text);
                    }
                };
            });

            // The worker must be listening before the engine announces itself
            await this.request({ cmd: "startAudio", sampleRate: ctx.sampleRate, blockSize: 128, soundFontUri: "file://" + SOUND_FONT_PATH });
            node.port.postMessage({ type: "init", rpcPort: this.rpcForAudio, soundFont: sf, soundFontPath: SOUND_FONT_PATH },
                [this.rpcForAudio, sf]);
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
        const total = Number(res.headers.get("content-length")) || 0;
        if (!res.body || !total) {
            return res.arrayBuffer();
        }
        const buf = new Uint8Array(total);
        const reader = res.body.getReader();
        let off = 0;
        for (;;) {
            const { done, value } = await reader.read();
            if (done) {
                break;
            }
            buf.set(value, off);
            off += value.length;
            this.emit("audioStatus", { text: `Loading MS Basic sound font… ${Math.round(off / total * 100)}%` });
        }
        return buf.buffer;
    }

    get audioRunning() {
        return this.ctx?.state === "running";
    }

    async load(name: string, data: ArrayBuffer): Promise<{ ok: boolean; error?: string; score?: ScoreInfo }> {
        return this.request({ cmd: "load", name, data }, [data]);
    }

    setViewMode(mode: ViewMode): Promise<ScoreInfo> { return this.request({ cmd: "viewMode", mode }); }
    page(index: number): Promise<string> { return this.request({ cmd: "page", index }); }
    cursor(secs: number): Promise<CursorInfo> { return this.request({ cmd: "cursor", secs }); }
    tracks(): Promise<TrackInfo[]> { return this.request({ cmd: "tracks" }); }
    play() { return this.request({ cmd: "play" }); }
    pause() { return this.request({ cmd: "pause" }); }
    stop() { return this.request({ cmd: "stop" }); }
    seek(secs: number) { return this.request({ cmd: "seek", secs }); }
    seekAt(page: number, x: number, y: number): Promise<CursorInfo | null> { return this.request({ cmd: "seekAt", page, x, y }); }
    setVolume(key: number, db: number) { return this.request({ cmd: "volume", key, db }); }
    setBalance(key: number, value: number) { return this.request({ cmd: "balance", key, value }); }
    setMute(key: number, on: boolean) { return this.request({ cmd: "mute", key, on }); }
    setSolo(key: number, on: boolean) { return this.request({ cmd: "solo", key, on }); }
    setReverb(key: number, amount: number) { return this.request({ cmd: "reverb", key, amount }); }
    setMasterVolume(db: number) { return this.request({ cmd: "masterVolume", db }); }
}
