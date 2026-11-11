/// <reference lib="webworker" />
// Web Worker hosting MuseScore's score engine (mscore.wasm): reading,
// layout, page drawing and the playback model. Keeps the UI responsive while
// a score loads. Talks to the audio engine in the AudioWorklet over rpcPort.

import { installResources, writeFile } from "./resources.js";
import type { WorkerRequest, WorkerReply } from "./protocol";

declare const self: DedicatedWorkerGlobalScope;

type Core = any;
let core: Core = null;
let processTimer = 0;

function post(msg: WorkerReply, transfer: Transferable[] = []) {
    self.postMessage(msg, transfer);
}

function cstr(s: string): number {
    const n = core.lengthBytesUTF8(s) + 1;
    const p = core._malloc(n);
    core.stringToUTF8(s, p, n);
    return p;
}

function callStr(name: string, ...args: (string | number)[]): string {
    const ptrs: number[] = [];
    const conv = args.map((a) => {
        if (typeof a === "string") {
            const p = cstr(a);
            ptrs.push(p);
            return p;
        }
        return a;
    });
    const r = core["_" + name](...conv);
    ptrs.forEach((p) => core._free(p));
    return typeof r === "number" && name !== "mss_process" ? core.UTF8ToString(r) : "";
}

function callVoid(name: string, ...args: (string | number)[]) {
    const ptrs: number[] = [];
    const conv = args.map((a) => {
        if (typeof a === "string") {
            const p = cstr(a);
            ptrs.push(p);
            return p;
        }
        return a;
    });
    core["_" + name](...conv);
    ptrs.forEach((p) => core._free(p));
    core._mss_process();
}

async function init(base: string, rpcPort: MessagePort) {
    const createMsCore = (await import(/* @vite-ignore */ base + "engine/mscore.mjs")).default;
    core = await createMsCore({
        locateFile: (f: string) => base + "engine/" + f,
        print: (s: string) => post({ type: "log", text: s }),
        printErr: (s: string) => post({ type: "log", text: s }),
        onEvent: (type: string, json: string) => post({ type: "event", event: type, data: JSON.parse(json) }),
    });

    // RPC with the audio engine
    // 5.0 builds: _mss_rpc_receive / rpcSend; 4.7 builds: upstream's embind pair
    // main_worker_rpcListen / main_worker_rpcSend (a view into wasm memory, so copy it)
    if (core._mss_rpc_receive) {
        core.rpcSend = (bytes: Uint8Array) => rpcPort.postMessage(bytes, [bytes.buffer]);
        rpcPort.onmessage = (e: MessageEvent<Uint8Array>) => {
            const bytes = e.data;
            const ptr = core._malloc(bytes.length);
            core.HEAPU8.set(bytes, ptr);
            core._mss_rpc_receive(ptr, bytes.length);
            core._free(ptr);
            core._mss_process();
        };
    } else {
        core.main_worker_rpcSend = (view: Uint8Array) => {
            const bytes = new Uint8Array(view);
            rpcPort.postMessage(bytes, [bytes.buffer]);
        };
        rpcPort.onmessage = (e: MessageEvent<Uint8Array>) => {
            core.main_worker_rpcListen(e.data);
            core._mss_process();
        };
    }

    const manifest = await (await fetch(base + "res/manifest.json")).json();
    await installResources(core.FS, manifest,
        async (p: string) => new Uint8Array(await (await fetch(base + "res/" + encodeURI(p))).arrayBuffer()),
        (done: number, total: number) => post({ type: "event", event: "resources", data: { done, total } }));

    core._mss_init(0);

    // MuseScore's async callbacks (promises, channels) run from here
    processTimer = self.setInterval(() => core._mss_process(), 15) as unknown as number;
}

self.onmessage = async (e: MessageEvent<WorkerRequest>) => {
    const req = e.data;
    try {
        let result: unknown = null;
        switch (req.cmd) {
        case "init":
            await init(req.base, req.rpcPort);
            break;
        case "startAudio":
            callVoid("mss_start_audio", req.sampleRate, req.blockSize, req.soundFontUri);
            break;
        case "load": {
            const path = "/scores/" + req.name.replace(/[\\/]/g, "_");
            writeFile(core.FS, path, new Uint8Array(req.data));
            result = JSON.parse(callStr("mss_load", path));
            try {
                core.FS.unlink(path); // the score is in memory now
            } catch (err) {
                // ignore
            }
            core._mss_process();
            break;
        }
        case "viewMode":
            result = JSON.parse(callStr("mss_set_view_mode", req.mode));
            break;
        case "page":
            result = callStr("mss_render_page", req.index);
            break;
        case "cursor":
            result = JSON.parse(callStr("mss_cursor", req.secs));
            break;
        case "timeline":
            result = JSON.parse(callStr("mss_timeline"));
            break;
        case "staves":
            // older engine builds have no staff list: notes then pin to the system only
            result = core._mss_staves ? JSON.parse(callStr("mss_staves")) : [];
            break;
        case "tracks":
            result = JSON.parse(callStr("mss_tracks"));
            break;
        case "play": callVoid("mss_play"); break;
        case "pause": callVoid("mss_pause"); break;
        case "stop": callVoid("mss_stop"); break;
        case "seek": callVoid("mss_seek", req.secs); break;
        case "seekAt":
            result = JSON.parse(callStr("mss_seek_at", req.page, req.x, req.y, req.radius, req.playNote ? 1 : 0));
            core._mss_process();
            break;
        case "volume": callVoid("mss_set_track_volume", req.key, req.db); break;
        case "balance": callVoid("mss_set_track_balance", req.key, req.value); break;
        case "mute": callVoid("mss_set_track_mute", req.key, req.on ? 1 : 0); break;
        case "solo": callVoid("mss_set_track_solo", req.key, req.on ? 1 : 0); break;
        case "reverb": callVoid("mss_set_track_reverb", req.key, req.amount); break;
        case "sound": callVoid("mss_set_track_sound", req.key, req.soundId); break;
        case "sounds":
            result = JSON.parse(callStr("mss_sounds"));
            break;
        case "getMasterVolume":
            result = core._mss_master_volume();
            break;
        case "masterVolume": callVoid("mss_set_master_volume", req.db); break;
        case "latency": callVoid("mss_set_output_latency", req.secs); break;
        case "metronome": callVoid("mss_set_metronome", req.on ? 1 : 0); break;
        case "speed":
            result = JSON.parse(callStr("mss_set_speed", req.multiplier, req.at));
            core._mss_process();
            break;
        case "loopMarker":
            result = JSON.parse(callStr("mss_set_loop_marker", req.right ? 1 : 0, req.at));
            core._mss_process();
            break;
        case "loop":
            result = JSON.parse(callStr("mss_set_loop", req.on ? 1 : 0));
            core._mss_process();
            break;
        case "clearLoop":
            result = JSON.parse(callStr("mss_clear_loop"));
            core._mss_process();
            break;
        case "locate":
            result = JSON.parse(callStr("mss_locate", req.page, req.x, req.y, req.radius));
            break;
        case "tempos":
            result = JSON.parse(callStr("mss_tempos"));
            break;
        case "bars":
            result = JSON.parse(callStr("mss_bars"));
            break;
        case "practice":
            result = JSON.parse(callStr("mss_practice"));
            break;
        case "editSelect":
            result = JSON.parse(callStr("mss_edit_select", req.page, req.x, req.y, req.radius));
            core._mss_process();
            break;
        case "editExtend":
            result = JSON.parse(callStr("mss_edit_extend", req.page, req.x, req.y, req.radius));
            core._mss_process();
            break;
        case "editCopy": result = JSON.parse(callStr("mss_edit_copy", req.cut ? 1 : 0)); core._mss_process(); break;
        case "editPaste": result = JSON.parse(callStr("mss_edit_paste")); core._mss_process(); break;
        case "editHasClip": result = core._mss_edit_has_clip() === 1; break;
        case "editVoice": result = JSON.parse(callStr("mss_edit_voice", req.voice, req.input ? 1 : 0)); core._mss_process(); break;
        case "editInsertBars": result = JSON.parse(callStr("mss_edit_insert_bars", req.count)); core._mss_process(); break;
        case "editDeleteBars": result = JSON.parse(callStr("mss_edit_delete_bars")); core._mss_process(); break;
        case "editMark": result = JSON.parse(callStr("mss_edit_mark", req.kind)); core._mss_process(); break;
        case "editSlur": result = JSON.parse(callStr("mss_edit_slur")); core._mss_process(); break;
        case "editHairpin": result = JSON.parse(callStr("mss_edit_hairpin", req.kind)); core._mss_process(); break;
        case "editSelectStart": result = JSON.parse(callStr("mss_edit_select_start")); break;
        case "editSelection": result = JSON.parse(callStr("mss_edit_selection")); break;
        case "editClearSelection": result = JSON.parse(callStr("mss_edit_clear_selection")); break;
        case "editMove": result = JSON.parse(callStr("mss_edit_move", req.to)); core._mss_process(); break;
        case "editPitch": result = JSON.parse(callStr("mss_edit_pitch", req.mode)); core._mss_process(); break;
        case "editDuration": result = JSON.parse(callStr("mss_edit_duration", req.den)); core._mss_process(); break;
        case "editEnterNote": result = JSON.parse(callStr("mss_edit_enter_note", req.letter, req.den, req.dots)); core._mss_process(); break;
        case "editEnterRest": result = JSON.parse(callStr("mss_edit_enter_rest", req.den, req.dots)); core._mss_process(); break;
        case "editAddBars": result = JSON.parse(callStr("mss_edit_add_bars", req.n)); core._mss_process(); break;
        case "editSetKey": result = JSON.parse(callStr("mss_edit_set_key", req.key)); core._mss_process(); break;
        case "editSetTime": result = JSON.parse(callStr("mss_edit_set_time", req.num, req.den)); core._mss_process(); break;
        case "editTie": result = JSON.parse(callStr("mss_edit_tie")); core._mss_process(); break;
        case "editTriplet": result = JSON.parse(callStr("mss_edit_triplet")); core._mss_process(); break;
        case "editAccidental": result = JSON.parse(callStr("mss_edit_accidental", req.kind)); core._mss_process(); break;
        case "editAddToChord": result = JSON.parse(callStr("mss_edit_add_to_chord", req.letter)); core._mss_process(); break;
        case "editDynamic": result = JSON.parse(callStr("mss_edit_dynamic", req.which)); core._mss_process(); break;
        case "editStaffText": result = JSON.parse(callStr("mss_edit_staff_text", req.text)); core._mss_process(); break;
        case "editLyric": result = JSON.parse(callStr("mss_edit_lyric", req.text)); core._mss_process(); break;
        case "editRenameLine": result = JSON.parse(callStr("mss_edit_rename_line", req.text)); core._mss_process(); break;
        case "editAddLine": result = JSON.parse(callStr("mss_edit_add_line", req.name, req.clef)); core._mss_process(); break;
        case "editInsertNotes": result = JSON.parse(callStr("mss_edit_insert_notes", req.spec)); core._mss_process(); break;
        case "editDot": result = JSON.parse(callStr("mss_edit_dot")); core._mss_process(); break;
        case "editDelete": result = JSON.parse(callStr("mss_edit_delete")); core._mss_process(); break;
        case "editUndo": result = JSON.parse(callStr("mss_edit_undo")); core._mss_process(); break;
        case "editRedo": result = JSON.parse(callStr("mss_edit_redo")); core._mss_process(); break;
        case "save": {
            // the whole score as a .mscz, in a transferable buffer
            const path = "/scores/_copy.mscz";
            const r = JSON.parse(callStr("mss_save", path));
            if (!r.ok) {
                result = { ok: false, error: r.error };
                break;
            }
            const bytes = core.FS.readFile(path) as Uint8Array;
            core.FS.unlink(path);
            const data = bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength);
            post({ type: "reply", id: req.id, result: { ok: true, data } }, [data]);
            return;
        }
        }
        post({ type: "reply", id: req.id, result });
    } catch (err: any) {
        post({ type: "reply", id: req.id, error: String(err && err.stack || err) });
    }
};

export {};
void processTimer;
