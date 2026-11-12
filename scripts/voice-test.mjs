// The pitch tracker and note finder on a synthetic sung line (vibrato, glides, breath noise, rests, two equal
// notes in a row), checked against the notes it was made from. No browser needed.
// Usage: node scripts/voice-test.mjs   (VOICE_WAV=file.wav writes the tune as a 16 kHz WAV for browser tests)
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { createRequire } from "node:module";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const require = createRequire(path.join(root, "app/package.json"));
const esbuild = require("esbuild");
const out = path.join(root, "build/spike/transcribe.mjs");
await esbuild.build({ entryPoints: [path.join(root, "app/src/voice/transcribe.ts")], bundle: true, format: "esm", outfile: out, logLevel: "silent" });
const { trackPitch, findNotes, toGrid, removeClicks, CLICK_HZ, CLICK_SECS, SAMPLE_RATE: SR } = await import(pathToFileURL(out).href);

let failures = 0;
const check = (ok, msg) => { console.log((ok ? "ok   " : "FAIL ") + msg); failures += ok ? 0 : 1; };

// the tune: [midi, seconds]; null is a rest. 100 bpm: a quarter is 0.6 s, a sixteenth 0.15 s.
const Q = 0.6;
export const melody = [[60, Q], [62, Q], [64, Q / 2], [64, Q / 2], [65, Q], [null, Q / 2], [67, Q * 2], [65, Q], [64, Q], [62, Q], [60, Q * 2]];
let rnd = 12345; const rand = () => ((rnd = (rnd * 1664525 + 1013904223) >>> 0) / 4294967296) - 0.5;
const total = melody.reduce((a, [, d]) => a + d, 0);
const sig = new Float32Array(Math.ceil((total + 0.4) * SR));
let t0 = Math.round(0.3 * SR), phase = 0, prevMidi = 60; // a little silence first
const truth = [];
for (const [m, d] of melody) {
    const n = Math.round(d * SR);
    if (m !== null) truth.push({ midi: m, start: (t0 - Math.round(0.3 * SR)) / SR, dur: d });
    for (let i = 0; i < n; i++) {
        const t = (t0 + i) / SR, local = i / SR;
        if (m === null) { sig[t0 + i] = rand() * 0.01; continue; }
        const glide = Math.min(1, local / 0.06);
        const midi = prevMidi + (m - prevMidi) * glide + 0.25 * Math.sin(2 * Math.PI * 5.5 * t) * Math.min(1, local / 0.2);
        phase += 2 * Math.PI * 440 * 2 ** ((midi - 69) / 12) / SR;
        let v = 0; for (let h = 1; h <= 6; h++) v += Math.sin(h * phase) / h;
        // each note swells in and dips out, as a sung syllable does (the dip is what tells two equal notes apart)
        const env = Math.min(1, local / 0.03) * Math.min(1, (d - local) / 0.06);
        sig[t0 + i] = v * env * 0.3 + rand() * 0.02;
    }
    if (m !== null) prevMidi = m;
    t0 += n;
}
if (process.env.VOICE_WAV) {
    const pcm = Buffer.alloc(44 + sig.length * 2);
    pcm.write("RIFF", 0); pcm.writeUInt32LE(36 + sig.length * 2, 4); pcm.write("WAVEfmt ", 8); pcm.writeUInt32LE(16, 16);
    pcm.writeUInt16LE(1, 20); pcm.writeUInt16LE(1, 22); pcm.writeUInt32LE(SR, 24); pcm.writeUInt32LE(SR * 2, 28); pcm.writeUInt16LE(2, 32); pcm.writeUInt16LE(16, 34);
    pcm.write("data", 36); pcm.writeUInt32LE(sig.length * 2, 40);
    for (let i = 0; i < sig.length; i++) pcm.writeInt16LE(Math.max(-32768, Math.min(32767, Math.round(sig[i] * 32767))), 44 + i * 2);
    fs.mkdirSync(path.dirname(process.env.VOICE_WAV), { recursive: true });
    fs.writeFileSync(process.env.VOICE_WAV, pcm);
}

const t1 = performance.now();
const frames = await trackPitch(sig);
const ms = performance.now() - t1;
const notes = findNotes(frames);
if (process.env.DEBUG) console.log(notes.map((n) => `${n.midi}@${(n.start - 0.3).toFixed(2)}+${n.dur.toFixed(2)}`).join(" "));
check(notes.length === truth.length, `${notes.length} notes found, ${truth.length} sung`);
let right = 0;
for (const t of truth) {
    const n = notes.find((x) => Math.abs(x.start - 0.3 - t.start) < 0.15);
    if (n && n.midi === t.midi) right++;
    else console.log(`     wrong or missed: ${t.midi} at ${t.start.toFixed(2)} s -> ${n ? n.midi + " at " + n.start.toFixed(2) : "nothing"}`);
}
check(right === truth.length, `every pitch and start is right (${right}/${truth.length})`);
console.log(`     ${total.toFixed(1)} s of audio in ${ms.toFixed(0)} ms (${(total * 1000 / ms).toFixed(0)}x real time)`);

// on the grid at 100 bpm: sixteenths of 0.15 s
const grid = toGrid(notes, 100, 16);
const want = [[60, 4], [62, 4], [64, 2], [64, 2], [65, 4], [-1, 2], [67, 8], [65, 4], [64, 4], [62, 4], [60, 8]];
check(JSON.stringify(grid.map((g) => [g.midi, g.units])) === JSON.stringify(want), "on the grid it is the tune that was sung: " + grid.map((g) => `${g.midi}:${g.units}`).join(" "));
check(toGrid(notes, 100, 8).every((g) => g.units % 2 === 0), "an eighth grid has no shorter notes");
check(toGrid(notes, 100, 16, -1)[0].midi === 48, "an octave down moves every note");

// The metronome while recording (issue #35): its beeps reach the microphone from the device's own speaker.
// Two seconds of beeps before the singer starts, then the same tune with a beep on every beat: as loud as the
// voice and three times as loud, on the notes' starts and off them (nobody sings exactly on the beat).
const lead = Math.round(2.4 * SR);
const withBeeps = (level, offset) => {
    const x = new Float32Array(lead + sig.length);
    let r = 777; const noise = () => ((r = (r * 1664525 + 1013904223) >>> 0) / 4294967296 - 0.5) * 0.01;
    for (let i = 0; i < lead; i++) x[i] = noise();
    x.set(sig, lead);
    const n = Math.round(CLICK_SECS * SR);
    for (let t = offset; t * SR + n < x.length; t += Q) {
        const s0 = Math.round(t * SR);
        for (let i = 0; i < n; i++) x[s0 + i] += level * Math.sin(2 * Math.PI * CLICK_HZ * i / SR) * Math.exp(-i * 6.9 / n);
    }
    return x;
};
const gridOf = async (x) => JSON.stringify(toGrid(findNotes(await trackPitch(x)), 100, 16).map((g) => [g.midi, g.units]));
check(await gridOf(withBeeps(0.3, 0)) !== JSON.stringify(want), "left in, the metronome's beeps are taken for notes (so the check below can fail)");
let clean = 0, cases = 0;
for (const level of [0.3, 1]) {
    for (const offset of [0, 0.07, 0.2, 0.33]) {
        cases++;
        clean += (await gridOf(removeClicks(withBeeps(level, offset)))) === JSON.stringify(want) ? 1 : 0;
    }
}
check(clean === cases, `with the beeps filtered out it is the tune that was sung, whatever their loudness and place (${clean}/${cases})`);
check(await gridOf(removeClicks(sig)) === JSON.stringify(want), "the filter leaves a recording without beeps as it was");
console.log(failures ? `${failures} failed` : "voice test passed");
process.exit(failures ? 1 : 0);
