// A player that plays the audio MuseScore's engine renders ahead (msaudio-worker.js) as buffer sources
// scheduled back to back on the audio clock, instead of through the AudioWorklet (public/worklet/
// msaudio-worklet.js). It speaks the worklet's protocol to the audio worker, so the worker is the same:
//   from the worker: {type:"audio", data (interleaved stereo Float32Array), gen, playing, target}
//   to the worker:   {type:"consumed", frames} | {type:"underrun", heard} | {type:"flush", gen}
//
// Why: on a Pixel 9a with AirPods (blind test, 17 Nov 2026) every AudioWorklet output crackled over
// Bluetooth, even a worklet that only copies memory, while buffer sources and a scheduled run of fresh
// buffers were clean (see docs/DEVELOPMENT.md, "Bluetooth crackle").
//
// The price: chunks are scheduled from the page's main thread when they arrive, so a main thread frozen
// for longer than the queue (512 ms or more) leaves a gap; the worklet only copied from its own queue. The
// worker's queue grows after each gap, as before.

// Audio wanted before the music resumes after a flush or at Play, as in the worklet (six blocks)
const PRIME_FRAMES = 6 * 1024;
// How far ahead of the clock a chunk is started when the queue was empty: long enough that the start
// is not already in the past by the time the buffer source is scheduled
const START_LEAD = 0.03;

interface Scheduled {
    src: AudioBufferSourceNode;
    start: number; // frame on the context's clock
    end: number;
    peak: number;
}

export interface ChunkPlayerHooks {
    /** about every 100 ms: frames queued ahead of the speaker, and the loudest sample playing since the last report */
    queued(frames: number, peak: number): void;
}

export class ChunkPlayer {
    private ctx: AudioContext;
    private dest: AudioNode;
    private port: MessagePort;
    private hooks: ChunkPlayerHooks;
    private pending: { data: Float32Array; peak: number }[] = []; // waiting for the priming to finish
    private pendingFrames = 0;
    private scheduled: Scheduled[] = [];
    private endFrame = 0; // where the next chunk goes, on the context's clock (0 = nothing scheduled)
    private lastAccounted = 0; // frame up to which played audio was reported as consumed
    private gen = 0;
    private priming = false;
    private primingSince = 0;
    private enginePlaying = false;
    private target = 0;
    private starved = false;
    private heard = false;
    private timer = 0;
    private lastReport = 0;
    private closed = false;

    constructor(ctx: AudioContext, dest: AudioNode, port: MessagePort, hooks: ChunkPlayerHooks) {
        this.ctx = ctx;
        this.dest = dest;
        this.port = port;
        this.hooks = hooks;
        port.onmessage = (e) => this.onAudio(e.data);
        this.timer = window.setInterval(() => this.tick(), 20);
    }

    private get now(): number {
        return Math.floor(this.ctx.currentTime * this.ctx.sampleRate);
    }

    private onAudio(m: { type: string; data: Float32Array; gen: number; playing: boolean; target: number }) {
        if (m.type !== "audio" || m.gen !== this.gen || this.closed) {
            return;
        }
        if (m.playing && !this.enginePlaying) { // Play: the playing queue fills first
            this.priming = true;
            this.primingSince = performance.now();
        }
        this.enginePlaying = m.playing;
        this.target = m.target || this.target;
        let peak = 0;
        const d = m.data;
        for (let i = 0; i < d.length; i++) {
            const v = d[i] < 0 ? -d[i] : d[i];
            if (v > peak) {
                peak = v;
            }
        }
        this.pending.push({ data: d, peak });
        this.pendingFrames += d.length / 2;
        this.starved = false;
        if (!this.priming) {
            this.schedulePending();
        } else {
            this.checkPriming();
        }
    }

    private checkPriming() {
        const want = Math.max(PRIME_FRAMES, this.target / 2);
        if (this.queuedFrames() >= want || !this.enginePlaying || performance.now() - this.primingSince > 1000) {
            this.priming = false;
            this.schedulePending();
        }
    }

    // Frames waiting or scheduled and not yet played
    private queuedFrames(): number {
        const ahead = this.endFrame ? Math.max(0, this.endFrame - this.now) : 0;
        return ahead + this.pendingFrames;
    }

    private schedulePending() {
        if (!this.pending.length) {
            return;
        }
        const sr = this.ctx.sampleRate;
        const now = this.now;
        if (!this.endFrame || this.endFrame < now + Math.floor(START_LEAD * sr * 0.5)) {
            // nothing queued (the first chunk, after a flush, or after running dry): start a little ahead
            const first = now + Math.ceil(START_LEAD * sr);
            this.endFrame = first;
            this.lastAccounted = first;
        }
        for (const c of this.pending) {
            const n = c.data.length / 2;
            const buf = this.ctx.createBuffer(2, n, sr);
            const l = buf.getChannelData(0);
            const r = buf.getChannelData(1);
            const d = c.data;
            for (let i = 0; i < n; i++) {
                l[i] = d[i * 2];
                r[i] = d[i * 2 + 1];
            }
            const src = this.ctx.createBufferSource();
            src.buffer = buf;
            src.connect(this.dest);
            // start time from an integer frame: back to back chunks meet exactly
            src.start(this.endFrame / sr);
            const s: Scheduled = { src, start: this.endFrame, end: this.endFrame + n, peak: c.peak };
            this.scheduled.push(s);
            src.onended = () => {
                src.disconnect();
            };
            this.endFrame += n;
        }
        this.pending = [];
        this.pendingFrames = 0;
    }

    private tick() {
        if (this.closed) {
            return;
        }
        if (this.priming) {
            this.checkPriming();
        }
        const now = this.now;
        // forget what has finished
        while (this.scheduled.length && this.scheduled[0].end <= now) {
            const s = this.scheduled.shift()!;
            this.heard = s.peak > 1e-4;
        }
        // report what was played since the last tick
        if (this.endFrame && !this.priming) {
            const upTo = Math.min(now, this.endFrame);
            const played = upTo - this.lastAccounted;
            if (played >= 1024) {
                this.lastAccounted = upTo;
                this.port.postMessage({ type: "consumed", frames: played });
            }
            // everything scheduled has played while the engine is running: the device fell behind
            const empty = now >= this.endFrame && this.pending.length === 0;
            if (empty && !this.starved && this.lastAccounted > 0) {
                this.starved = true;
                this.port.postMessage({ type: "underrun", heard: this.heard });
            }
        }
        const t = performance.now();
        if (t - this.lastReport >= 100) {
            this.lastReport = t;
            let peak = 0;
            for (const s of this.scheduled) {
                if (s.start <= now && s.end > now - this.ctx.sampleRate / 10 && s.peak > peak) {
                    peak = s.peak;
                }
            }
            this.hooks.queued(this.queuedFrames(), peak);
        }
    }

    /** Drop everything queued (a seek, pause or stop), and tell the worker to drop what it rendered before it hears of this. */
    flush() {
        for (const s of this.scheduled) {
            try {
                s.src.stop();
            } catch {
                // not started yet: stop() with no time is fine after start(); nothing to do
            }
            s.src.disconnect();
        }
        this.scheduled = [];
        this.pending = [];
        this.pendingFrames = 0;
        this.endFrame = 0;
        this.lastAccounted = 0;
        this.starved = false;
        this.gen++;
        this.priming = true;
        this.primingSince = performance.now();
        this.port.postMessage({ type: "flush", gen: this.gen });
    }

    close() {
        this.closed = true;
        window.clearInterval(this.timer);
        this.flush();
    }
}
