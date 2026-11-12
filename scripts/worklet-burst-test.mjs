// The sound queue on a device that takes its audio in big batches (a friend's playback report, 5 Nov 2026:
// an Android tablet, 440 ms of output delay, a "sound gap" at every Play). Runs the real worklet
// (app/public/worklet/msaudio-worklet.js) against a stand-in for the audio worker, on a clock of its own:
// no browser, no sound, the same result every time.
//   node scripts/worklet-burst-test.mjs            the worklet as it is
//   node scripts/worklet-burst-test.mjs <file>     another copy of it (the old one, to see the checks fail)
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const file = path.resolve(process.argv[2] || path.join(root, "app/public/worklet/msaudio-worklet.js"));
const RATE = 48000;
const BLOCK = 1024;

function makePlayer() {
    let Player = null;
    class AudioWorkletProcessor {
        constructor() {
            this.port = { postMessage() {}, onmessage: null };
        }
    }
    new Function("AudioWorkletProcessor", "registerProcessor", "sampleRate", fs.readFileSync(file, "utf8"))(
        AudioWorkletProcessor, (name, cls) => { Player = cls; }, RATE);
    return new Player();
}

// One run. `burstMs`: the device asks for this much audio at once, then nothing until the next batch.
// `playAt`: Play is tapped. `silentBlocks`: blocks of silence the engine still renders after Play before the
// first note. `stalls`: [fromMs, forMs] the worker does nothing (a busy device, or the engine starting the music).
function run({ burstMs, playAt, silentBlocks = 0, stalls = [], playTarget = 24 * BLOCK, total = 6000, blockMs = 2 }) {
    const player = makePlayer();
    const toWorker = []; // messages from the worklet, read when the worker is free
    const inPort = { postMessage: (m) => toWorker.push(m), onmessage: null };
    player.port.onmessage({ data: { type: "init", inPort } });

    let playing = false;
    let inFlight = 0;
    let idleTarget = 4 * BLOCK;
    let busyUntil = 0;
    let sinceGap = 0;
    let gaps = 0; // counted as stutters
    let silentLeft = 0;
    let cut = 0; // batches in which sound stopped short (what the reader hears)
    let musicStarted = -1;

    for (let t = 0; t < total; t++) {
        if (t === playAt) {
            playing = true;
            silentLeft = silentBlocks;
        }
        for (const [from, len] of stalls) {
            if (t === from) {
                busyUntil = Math.max(busyUntil, t + len);
            }
        }
        if (t >= busyUntil) {
            while (toWorker.length) {
                const m = toWorker.shift();
                if (m.type === "consumed") {
                    inFlight = Math.max(0, inFlight - m.frames);
                } else if (m.type === "underrun") {
                    if (playing && m.heard === false) {
                        // not a stutter
                    } else if (playing) {
                        gaps++;
                        playTarget = Math.min(48 * BLOCK, playTarget + 8 * BLOCK);
                    } else {
                        idleTarget = Math.min(12 * BLOCK, idleTarget + BLOCK);
                    }
                }
            }
            // one block per `blockMs`
            if (inFlight < (playing ? playTarget : idleTarget) && t % blockMs === 0) {
                const music = playing && silentLeft-- <= 0;
                const data = new Float32Array(BLOCK * 2).fill(music ? 0.2 : 0);
                inPort.onmessage({ data: { type: "audio", data, gen: 0, playing, target: playTarget } });
                inFlight += BLOCK;
            }
        }
        if (t % burstMs === 0) {
            let sound = 0;
            let quietAfterSound = false;
            for (let f = 0; f < burstMs * RATE / 1000; f += 128) {
                const out = [new Float32Array(128), new Float32Array(128)];
                player.process([], [out]);
                const loud = out[0].some((v) => v !== 0);
                if (loud) {
                    sound++;
                    if (musicStarted < 0) {
                        musicStarted = t;
                    }
                } else if (sound) {
                    quietAfterSound = true;
                }
            }
            if (quietAfterSound) {
                cut++;
            }
            sinceGap++;
        }
    }
    return { gaps, cut, musicStarted, playTarget: playTarget / BLOCK };
}

let failures = 0;
const check = (ok, msg) => { console.log((ok ? "ok   " : "FAIL ") + msg); failures += ok ? 0 : 1; };
console.log("worklet:", path.relative(root, file));

// 1. Play on a device taking 300 ms at a time still starts cleanly with the wait for half the queue
//    (this one passes on the old worklet too: it guards the wait, it doesn't show the old fault; check 2 does)
let r = run({ burstMs: 300, playAt: 2010, silentBlocks: 4 });
check(r.gaps === 0 && r.cut === 0, `Play with 300 ms batches: no gap counted, the music unbroken (${r.gaps} gaps, ${r.cut} cuts, queue ${r.playTarget} blocks)`);
check(r.musicStarted > 0 && r.musicStarted - 2010 < 1200, `and the music starts (${r.musicStarted - 2010} ms after Play)`);

// 2. the engine is busy for 600 ms just after Play, before the first note: silence runs out, nothing is cut
r = run({ burstMs: 100, playAt: 2010, silentBlocks: 60, stalls: [[2060, 600]] });
check(r.gaps === 0, `silence running out before the first note is no stutter (${r.gaps} gaps, queue ${r.playTarget} blocks)`);

// 3. control: a real stall in the middle of the music is still counted, and the queue grows
r = run({ burstMs: 100, playAt: 2010, stalls: [[4000, 900]] });
check(r.gaps >= 1 && r.playTarget > 24, `a 900 ms stall in the music is counted (${r.gaps} gaps, queue ${r.playTarget} blocks)`);

// 4. the same device once it has learned its queue: a 600 ms stall is ridden out
r = run({ burstMs: 100, playAt: 2010, stalls: [[4000, 600]], playTarget: 40 * BLOCK });
check(r.gaps === 0 && r.cut === 0, `with the remembered queue (40 blocks) a 600 ms stall is not heard (${r.gaps} gaps, ${r.cut} cuts)`);

console.log(failures ? `${failures} failure(s)` : "worklet-burst test passed");
process.exit(failures ? 1 : 0);
