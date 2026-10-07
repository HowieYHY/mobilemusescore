// Web Worker hosting MuseScore's audio engine (msaudio.wasm).
//
// It renders ahead in blocks of BLOCK frames (as desktop MuseScore does) and
// sends them to the AudioWorklet, which only plays from its queue. Rendering
// off the audio thread with a little headroom keeps playback smooth on devices
// where the engine cannot always finish a 128-frame slice in time.
// Follows the "audio worker" mode of upstream MuseScore's web build
// (src/web/appjs/distr/audioworker.js, GPL-3.0-only).
//
// Messages from the page:
//   {type:"init", soundFont, soundFontPath, rpcPort, outPort, sampleRate}
//   {type:"playing", on}     while stopped only a little audio is queued, so
//                            a tapped note sounds at once
// To the page: {type:"underrun", count} for each gap while playing, and
// {type:"stats", load, loadUnder, slowestMs, target} every few seconds while
// music plays: load = share of the time spent rendering (0.05 = 5%), or null
// with loadUnder set when this device's timer is too coarse to measure it.
// On outPort (from/to the worklet):
//   -> {type:"audio", data: Float32Array (interleaved stereo), gen}
//   <- {type:"consumed", frames} | {type:"underrun"} | {type:"flush", gen}

import createMsAudio from "../engine/msaudio.mjs";

const BLOCK = 1024;
const MAX_TARGET = 48 * BLOCK; // ~1 s

let mod = null;
let out = null;
let bufPtr = 0;
let inFlight = 0; // frames sent to the worklet and not yet played
// Audio queued ahead while playing. Deep enough to ride out a busy moment on
// a phone (~340 ms); seek, pause and stop flush it, so it adds no delay there.
let playTarget = 16 * BLOCK;
// While stopped (~85 ms); grows if the device takes audio in bigger bursts
let idleTarget = 4 * BLOCK;
const MAX_IDLE_TARGET = 12 * BLOCK;
let underruns = 0;
let playing = false;
let gen = 0; // flush generation: audio rendered before a flush is dropped
let pumping = false;

// render speed, reported to the page for the playback check
// Measured only while music plays (rendering silence while stopped is nearly
// free and would read as thousands of times faster), over a few seconds.
let renderMs = 0;
let renderedFrames = 0;
let slowestMs = 0;
let lastStats = 0;
const STATS_MS = 3000;
// Browsers coarsen performance.now() (Safari in workers: whole milliseconds),
// so a block that renders in well under 1 ms can read as 0 ms
const timerStep = (() => {
    let step = Infinity;
    for (let i = 0; i < 5; i++) {
        const a = performance.now();
        let b = a;
        while (b === a) {
            b = performance.now();
        }
        step = Math.min(step, b - a);
    }
    return step;
})();

function connectRpc(rpc) {
    // 5.0 builds: _mss_rpc_receive / rpcSend; 4.7 builds: upstream's embind pair
    // main_worker_rpcListen / main_worker_rpcSend (a view into wasm memory, so copy it)
    if (mod._mss_rpc_receive) {
        mod.rpcSend = (bytes) => rpc.postMessage(bytes, [bytes.buffer]);
        rpc.onmessage = (e) => {
            const bytes = e.data;
            const ptr = mod._malloc(bytes.length);
            mod.HEAPU8.set(bytes, ptr);
            mod._mss_rpc_receive(ptr, bytes.length);
            mod._free(ptr);
            pump();
        };
    } else {
        mod.main_worker_rpcSend = (view) => {
            const bytes = new Uint8Array(view);
            rpc.postMessage(bytes, [bytes.buffer]);
        };
        rpc.onmessage = (e) => {
            mod.main_worker_rpcListen(e.data);
            pump();
        };
    }
}

function renderBlock() {
    const t0 = performance.now();
    mod._msaudio_process(bufPtr, BLOCK);
    const ms = performance.now() - t0;
    if (playing) {
        renderMs += ms;
        renderedFrames += BLOCK;
        slowestMs = Math.max(slowestMs, ms);
    }
    // copy out of wasm memory; the copy is transferred to the worklet
    const data = new Float32Array(mod.HEAPF32.buffer, bufPtr, BLOCK * 2).slice();
    out.postMessage({ type: "audio", data, gen }, [data.buffer]);
    inFlight += BLOCK;
}

function reportStats() {
    const now = performance.now();
    if (now - lastStats < STATS_MS || !renderedFrames) {
        return;
    }
    lastStats = now;
    const audioMs = renderedFrames / sampleRate * 1000;
    // Too few timer steps to trust: give an upper bound instead (each block's
    // reading can be short by up to one timer step)
    const measurable = renderMs >= 20 * timerStep;
    const blocks = renderedFrames / BLOCK;
    self.postMessage({
        type: "stats",
        load: measurable ? renderMs / audioMs : null,
        loadUnder: measurable ? null : (renderMs + blocks * timerStep) / audioMs,
        slowestMs,
        timerStep,
        target: playTarget,
    });
    renderMs = 0;
    renderedFrames = 0;
    slowestMs = 0;
}

// Keep the target amount of audio queued ahead of the speaker.
function pump() {
    if (!mod || pumping) {
        return;
    }
    pumping = true;
    try {
        const target = playing ? playTarget : idleTarget;
        while (inFlight < target) {
            renderBlock();
        }
    } finally {
        pumping = false;
    }
    reportStats();
}

let sampleRate = 48000;

self.onmessage = async (e) => {
    const msg = e.data;
    if (msg.type === "playing") {
        playing = msg.on;
        pump();
        return;
    }
    if (msg.type !== "init") {
        return;
    }
    sampleRate = msg.sampleRate || sampleRate;
    try {
        mod = await createMsAudio({
            print: (s) => self.postMessage({ type: "log", text: s }),
            printErr: (s) => self.postMessage({ type: "log", text: s }),
        });

        const dir = msg.soundFontPath.slice(0, msg.soundFontPath.lastIndexOf("/"));
        try {
            mod.FS.mkdir(dir);
        } catch (err) {
            // exists
        }
        mod.FS.writeFile(msg.soundFontPath, new Uint8Array(msg.soundFont));

        connectRpc(msg.rpcPort);

        out = msg.outPort;
        out.onmessage = (ev) => {
            const m = ev.data;
            if (m.type === "consumed") {
                inFlight = Math.max(0, inFlight - m.frames);
            } else if (m.type === "underrun") {
                // the device fell behind: keep more audio queued from now on
                if (playing) {
                    underruns++;
                    playTarget = Math.min(MAX_TARGET, playTarget + 4 * BLOCK);
                    self.postMessage({ type: "underrun", count: underruns });
                    self.postMessage({ type: "log", text: `audio underrun; queue now ${playTarget} frames` });
                } else {
                    idleTarget = Math.min(MAX_IDLE_TARGET, idleTarget + BLOCK);
                }
            } else if (m.type === "flush") {
                inFlight = 0; // the worklet dropped its queue
                gen = m.gen;
            }
            pump();
        };

        bufPtr = mod._malloc(BLOCK * 2 * 4);
        mod._msaudio_init(); // announces EngineRunning to the score engine
        pump();
        self.postMessage({ type: "ready", block: BLOCK });
    } catch (err) {
        self.postMessage({ type: "error", text: String(err && err.stack || err) });
    }
};
