// Runs both WebAssembly modules in Node.js, connected the way the browser
// connects them, and renders audio offline. Shared by the test and
// comparison scripts.

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

import { installResources, writeFile } from "../../app/src/engine/resources.js";

// MuseScore's audio RPC between the two modules. 5.0 builds export
// _mss_rpc_receive and call Module.rpcSend; 4.7 builds use upstream's embind
// pair main_worker_rpcListen / Module.main_worker_rpcSend (a view into wasm
// memory, so it is copied). Returns the function that delivers to `mod`.
export function connectRpc(mod, send) {
    if (mod._mss_rpc_receive) {
        mod.rpcSend = (bytes) => send(bytes);
        return (bytes) => {
            const ptr = mod._malloc(bytes.length);
            mod.HEAPU8.set(bytes, ptr);
            mod._mss_rpc_receive(ptr, bytes.length);
            mod._free(ptr);
        };
    }
    mod.main_worker_rpcSend = (view) => send(new Uint8Array(view));
    return (bytes) => mod.main_worker_rpcListen(bytes);
}

export const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");

export async function createNodeEngine({ sampleRate = 44100, block = 1024, verbose = false, coreBuild } = {}) {
    const build = coreBuild || process.env.MSS_BUILD || "build/wasm47";
    const createMsCore = (await import(pathToFileURL(path.join(root, build, "core/mscore.mjs")))).default;
    const createMsAudio = (await import(pathToFileURL(path.join(root, build, "audio/msaudio.mjs")))).default;

    const events = [];
    const core = await createMsCore({
        print: (s) => verbose && console.log("[core]", s),
        printErr: (s) => verbose && console.log("[core!]", s),
        onEvent: (type, json) => events.push({ type, data: JSON.parse(json) }),
    });
    const audio = await createMsAudio({
        print: (s) => verbose && console.log("[audio]", s),
        printErr: (s) => verbose && console.log("[audio!]", s),
    });

    const toAudio = [];
    const toCore = [];
    const deliverToAudio = connectRpc(audio, (bytes) => toCore.push(bytes));
    const deliverToCore = connectRpc(core, (bytes) => toAudio.push(bytes));
    const deliver = (mod, bytes) => (mod === audio ? deliverToAudio : deliverToCore)(bytes);
    const pump = () => {
        for (let i = 0; i < 1000 && (toAudio.length || toCore.length); i++) {
            while (toAudio.length) {
                deliver(audio, toAudio.shift());
            }
            while (toCore.length) {
                deliver(core, toCore.shift());
            }
            core._mss_process();
        }
        core._mss_process();
    };

    const call = (name, ...args) => {
        const ptrs = [];
        const conv = args.map((a) => {
            if (typeof a !== "string") {
                return a;
            }
            const n = core.lengthBytesUTF8(a) + 1;
            const p = core._malloc(n);
            core.stringToUTF8(a, p, n);
            ptrs.push(p);
            return p;
        });
        const r = core["_" + name](...conv);
        ptrs.forEach((p) => core._free(p));
        pump();
        return r;
    };
    const callStr = (name, ...args) => core.UTF8ToString(call(name, ...args));

    const manifest = JSON.parse(fs.readFileSync(path.join(root, "app/public/res/manifest.json"), "utf8"));
    await installResources(core.FS, manifest, async (p) => fs.readFileSync(path.join(root, "app/public/res", p)));
    writeFile(audio.FS, "/sound/MS Basic.sf3", fs.readFileSync(path.join(root, "third_party/musescore/share/sound/MS Basic.sf3")));

    call("mss_init", verbose ? 1 : 0);
    call("mss_start_audio", sampleRate, block, "file:///sound/MS Basic.sf3");
    audio._msaudio_init();
    pump();

    const outPtr = audio._malloc(block * 2 * 4);
    const renderBlock = () => {
        audio._msaudio_process(outPtr, block);
        pump();
        return audio.HEAPF32.subarray(outPtr >> 2, (outPtr >> 2) + block * 2);
    };
    const waitFor = (type, maxBlocks = 400) => {
        for (let i = 0; i < maxBlocks && !events.some((e) => e.type === type); i++) {
            renderBlock();
        }
        return events.some((e) => e.type === type);
    };
    if (!waitFor("audioReady")) {
        throw new Error("audio engine did not become ready");
    }

    return {
        core, audio, events, call, callStr, renderBlock, waitFor, sampleRate, block,

        // Loads a score; resolves once every track is set up.
        load(scorePath) {
            events.length = 0;
            const name = "/scores/" + path.basename(scorePath);
            writeFile(core.FS, name, fs.readFileSync(scorePath));
            const res = JSON.parse(callStr("mss_load", name));
            if (!res.ok) {
                throw new Error(res.error);
            }
            if (!waitFor("playbackReady")) {
                throw new Error("tracks were not set up");
            }
            return res.score;
        },

        // Plays from `from` for `secs` seconds and returns interleaved stereo PCM.
        render(secs, from = 0) {
            call("mss_seek", from);
            call("mss_play");
            const blocks = Math.ceil(secs * sampleRate / block);
            const pcm = new Float32Array(blocks * block * 2);
            for (let b = 0; b < blocks; b++) {
                pcm.set(renderBlock(), b * block * 2);
            }
            call("mss_pause");
            return pcm;
        },
    };
}

// 32-bit float WAV: keeps peaks above full scale, like desktop's WAV export
export function writeWav(file, pcm, sampleRate) {
    const data = Buffer.from(pcm.buffer, pcm.byteOffset, pcm.byteLength);
    const h = Buffer.alloc(44);
    h.write("RIFF", 0); h.writeUInt32LE(36 + data.length, 4); h.write("WAVE", 8);
    h.write("fmt ", 12); h.writeUInt32LE(16, 16); h.writeUInt16LE(3, 20); h.writeUInt16LE(2, 22);
    h.writeUInt32LE(sampleRate, 24); h.writeUInt32LE(sampleRate * 8, 28); h.writeUInt16LE(8, 32); h.writeUInt16LE(32, 34);
    h.write("data", 36); h.writeUInt32LE(data.length, 40);
    fs.writeFileSync(file, Buffer.concat([h, data]));
}
