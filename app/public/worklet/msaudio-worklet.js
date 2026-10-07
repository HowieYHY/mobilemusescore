// AudioWorklet hosting MuseScore's audio engine (msaudio.wasm).
// Follows upstream MuseScore's src/web/appjs/distr/audio_worklet_processor.js
// (GPL-3.0-only), "direct wasm" path.
//
// Messages on this.port (from the page):
//   {type:"init", rpcPort, soundFont: ArrayBuffer, soundFontPath}
// rpcPort carries MuseScore's audio RPC to/from the score engine worker.

import createMsAudio from "../engine/msaudio.mjs";

class MsAudioProcessor extends AudioWorkletProcessor {
    constructor() {
        super();
        this.mod = null;
        this.buf = 0;
        this.bufFrames = 0;
        this.port.onmessage = (e) => this.onMessage(e.data);
    }

    async onMessage(msg) {
        if (msg.type !== "init") {
            return;
        }
        try {
            const mod = await createMsAudio({
                print: (s) => this.port.postMessage({ type: "log", text: s }),
                printErr: (s) => this.port.postMessage({ type: "log", text: s }),
            });

            // the sound font goes into the engine's in-memory file system
            const dir = msg.soundFontPath.slice(0, msg.soundFontPath.lastIndexOf("/"));
            try {
                mod.FS.mkdir(dir);
            } catch (err) {
                // exists
            }
            mod.FS.writeFile(msg.soundFontPath, new Uint8Array(msg.soundFont));

            // MuseScore's audio RPC: 5.0 builds export _mss_rpc_receive and call
            // rpcSend; 4.7 builds use upstream's embind pair main_worker_rpcListen /
            // main_worker_rpcSend (a view into wasm memory, so copy it)
            const rpc = msg.rpcPort;
            if (mod._mss_rpc_receive) {
                mod.rpcSend = (bytes) => rpc.postMessage(bytes, [bytes.buffer]);
                rpc.onmessage = (e) => {
                    const bytes = e.data;
                    const ptr = mod._malloc(bytes.length);
                    mod.HEAPU8.set(bytes, ptr);
                    mod._mss_rpc_receive(ptr, bytes.length);
                    mod._free(ptr);
                };
            } else {
                mod.main_worker_rpcSend = (view) => {
                    const bytes = new Uint8Array(view);
                    rpc.postMessage(bytes, [bytes.buffer]);
                };
                rpc.onmessage = (e) => mod.main_worker_rpcListen(e.data);
            }

            mod._msaudio_init(); // announces EngineRunning to the score engine
            this.mod = mod;
            this.port.postMessage({ type: "ready" });
        } catch (err) {
            this.port.postMessage({ type: "error", text: String(err && err.stack || err) });
        }
    }

    process(inputs, outputs) {
        const mod = this.mod;
        if (!mod) {
            return true;
        }
        const out = outputs[0];
        const frames = out[0].length;
        if (this.bufFrames < frames) {
            if (this.buf) {
                mod._free(this.buf);
            }
            this.buf = mod._malloc(frames * 2 * 4);
            this.bufFrames = frames;
        }
        mod._msaudio_process(this.buf, frames);
        const view = new Float32Array(mod.HEAPF32.buffer, this.buf, frames * 2);
        const left = out[0];
        const right = out[1] || out[0];
        for (let i = 0; i < frames; i++) {
            left[i] = view[i * 2];
            right[i] = view[i * 2 + 1];
        }
        return true;
    }
}

registerProcessor("msaudio", MsAudioProcessor);
