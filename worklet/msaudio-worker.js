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
// On outPort (from/to the worklet):
//   -> {type:"audio", data: Float32Array (interleaved stereo)}
//   <- {type:"consumed", frames} | {type:"underrun"} | {type:"flush"}

import createMsAudio from "../engine/msaudio.mjs";

const BLOCK = 1024;
const MIN_TARGET = 4 * BLOCK; // ~85 ms at 48 kHz
const MAX_TARGET = 24 * BLOCK; // ~0.5 s

let mod = null;
let out = null;
let bufPtr = 0;
let inFlight = 0; // frames sent to the worklet and not yet played
let target = 8 * BLOCK; // ~170 ms
let pumping = false;

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
    mod._msaudio_process(bufPtr, BLOCK);
    // copy out of wasm memory; the copy is transferred to the worklet
    const data = new Float32Array(mod.HEAPF32.buffer, bufPtr, BLOCK * 2).slice();
    out.postMessage({ type: "audio", data }, [data.buffer]);
    inFlight += BLOCK;
}

// Keep `target` frames queued ahead of the speaker.
function pump() {
    if (!mod || pumping) {
        return;
    }
    pumping = true;
    try {
        while (inFlight < target) {
            renderBlock();
        }
    } finally {
        pumping = false;
    }
}

self.onmessage = async (e) => {
    const msg = e.data;
    if (msg.type !== "init") {
        return;
    }
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
                target = Math.min(MAX_TARGET, target + 2 * BLOCK);
                self.postMessage({ type: "log", text: `audio underrun; queue now ${target} frames` });
            } else if (m.type === "flush") {
                inFlight = 0; // the worklet dropped its queue
            }
            pump();
        };

        bufPtr = mod._malloc(BLOCK * 2 * 4);
        mod._msaudio_init(); // announces EngineRunning to the score engine
        target = Math.max(MIN_TARGET, target);
        pump();
        self.postMessage({ type: "ready", block: BLOCK });
    } catch (err) {
        self.postMessage({ type: "error", text: String(err && err.stack || err) });
    }
};
