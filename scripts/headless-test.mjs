// Headless end-to-end check of the two WebAssembly modules in Node.js:
// loads a score, renders page 1, plays it through MuseScore's audio engine
// with MS Basic into WAV files, and checks mute/solo/master volume.
//
// Usage: node scripts/headless-test.mjs <score.mscz> [seconds] [outDir]
//        MSS_BUILD=build/wasm (5.0) or build/wasm47 (4.7, default)

import fs from "node:fs";
import path from "node:path";

import { createNodeEngine, root, writeWav as writeWavFile } from "./lib/node-engine.mjs";

const scorePath = process.argv[2] || path.join(root, "real test musescores/I am move it(howie version).mscz");
const seconds = Number(process.argv[3] || 12);
const outDir = process.argv[4] || path.join(root, "build/headless");
fs.mkdirSync(outDir, { recursive: true });

const SAMPLE_RATE = 44100;
const BLOCK = 1024;

let t0 = Date.now();
const engine = await createNodeEngine({ sampleRate: SAMPLE_RATE, block: BLOCK, verbose: !!process.env.VERBOSE });
const { events, call, callStr, renderBlock } = engine;
console.log(`engine up (${process.env.MSS_BUILD || "build/wasm47"}): ${Date.now() - t0} ms`);

t0 = Date.now();
let info;
try {
    info = engine.load(scorePath);
} catch (e) {
    console.error("FAIL: load:", e.stack || e.message);
    process.exit(1);
}
console.log(`load: ${Date.now() - t0} ms`);
console.log(`title: ${info.title} | pages: ${info.pages.length} | duration: ${info.duration.toFixed(1)} s | mscVersion ${info.mscVersion} (${info.createdWith}) | audiosettings: ${info.hasAudioSettings}`);

// Render page 1
t0 = Date.now();
const page = callStr("mss_render_page", 0);
const ops = JSON.parse(page);
console.log(`page 1: ${ops.length} draw ops, ${(page.length / 1024).toFixed(0)} KB JSON, ${Date.now() - t0} ms`);
fs.writeFileSync(path.join(outDir, "page1.json"), page);
const fontsUsed = new Set(ops.filter((o) => o[0] === "F").map((o) => o[1]));
console.log("fonts used:", [...fontsUsed].join(", "));
const counts = {};
ops.forEach((o) => counts[o[0]] = (counts[o[0]] || 0) + 1);
console.log("op counts:", JSON.stringify(counts));

const tracks = JSON.parse(callStr("mss_tracks"));
console.log("tracks:");
for (const t of tracks) {
    console.log(`  #${t.key} ${t.title} | sound: ${t.sound} | vol ${t.volume} dB | reverb ${t.reverb} | ready ${t.ready}${t.note ? " | NOTE: " + t.note : ""}`);
}

// Play and capture
function capture(secs, label) {
    const blocks = Math.ceil(secs * SAMPLE_RATE / BLOCK);
    const pcm = new Float32Array(blocks * BLOCK * 2);
    for (let b = 0; b < blocks; b++) {
        pcm.set(renderBlock(), b * BLOCK * 2);
    }
    let peak = 0;
    let sumSq = 0;
    for (const v of pcm) {
        peak = Math.max(peak, Math.abs(v));
        sumSq += v * v;
    }
    const rms = Math.sqrt(sumSq / pcm.length);
    // loudness per half second, to tell a decaying tail from steady sound
    const win = SAMPLE_RATE; // 0.5 s of stereo frames
    const profile = [];
    for (let o = 0; o < pcm.length; o += win) {
        let p = 0;
        for (let i = o; i < Math.min(o + win, pcm.length); i++) {
            p = Math.max(p, Math.abs(pcm[i]));
        }
        profile.push(p);
    }
    const tailPeak = Math.max(...profile.slice(Math.floor(profile.length / 2)));
    console.log(`${label}: peak ${peak.toFixed(3)}, rms ${rms.toFixed(4)}, second-half peak ${tailPeak.toFixed(4)}`
        + `
    per 0.5 s: ${profile.map((v) => v.toFixed(3)).join(" ")}`);
    return { pcm, peak, rms, tailPeak };
}

function writeWav(file, pcm) {
    writeWavFile(file, pcm, SAMPLE_RATE);
}

// A score can be saved with parts muted (desktop then plays them muted too).
// Report that, and unmute everything so the sound checks hear every part.
const savedMuted = tracks.filter((t) => !t.metronome && (t.mute || t.solo));
if (savedMuted.length) {
    console.log("saved mixer state:", savedMuted.map((t) => `${t.title}${t.mute ? " muted" : ""}${t.solo ? " solo" : ""}`).join(", "));
    for (const t of savedMuted) {
        call("mss_set_track_mute", t.key, 0);
        call("mss_set_track_solo", t.key, 0);
    }
}

call("mss_play");
const full = capture(seconds, "play (all)");
writeWav(path.join(outDir, "play-all.wav"), full.pcm);
const positions = events.filter((e) => e.type === "position");
const last = positions[positions.length - 1];
console.log(`position events: ${positions.length}, last: ${last && JSON.stringify(last.data)}`);

let failures = 0;
if (full.peak < 0.01) {
    console.error("FAIL: playback is silent");
    failures++;
}

// Mixer checks: mute every instrument but the first, compare
const instruments = tracks.filter((t) => !t.metronome && !t.chords && t.ready);
if (instruments.length >= 2) {
    call("mss_seek", 0.0);
    for (const t of instruments.slice(1)) {
        call("mss_set_track_mute", t.key, 1);
    }
    const onlyFirst = capture(seconds, `only "${instruments[0].title}"`);
    writeWav(path.join(outDir, "only-first.wav"), onlyFirst.pcm);

    call("mss_seek", 0.0);
    // every strip in the mixer, including chord-symbol playback tracks
    const allStrips = tracks.filter((t) => !t.metronome && t.ready);
    for (const t of allStrips) {
        call("mss_set_track_mute", t.key, 1);
    }
    const allMuted = capture(6, "all muted");
    if (allMuted.tailPeak > 0.001) {
        console.error("FAIL: muting every instrument still produces sound");
        failures++;
    }

    for (const t of allStrips) {
        call("mss_set_track_mute", t.key, 0);
    }
    call("mss_set_track_solo", instruments[1].key, 1);
    call("mss_seek", 0.0);
    const solo = capture(seconds, `solo "${instruments[1].title}"`);
    writeWav(path.join(outDir, "solo-second.wav"), solo.pcm);
    call("mss_set_track_solo", instruments[1].key, 0);

    call("mss_set_master_volume", -60);
    call("mss_seek", 0.0);
    const quiet = capture(6, "master -60 dB");
    if (quiet.tailPeak > full.peak * 0.01) {
        console.error("FAIL: master volume had no effect");
        failures++;
    }
    call("mss_set_master_volume", 0);
} else {
    console.log("(fewer than two instruments; mixer comparison skipped)");
}

// Changing a part's sound (desktop mixer's sound menu): another MS Basic
// preset must sound different, and going back to the score's sound must sound
// as before.
{
    const sounds = JSON.parse(callStr("mss_sounds"));
    const leaves = [];
    const walk = (n, cat) => ("id" in n ? leaves.push({ ...n, cat }) : n.c.forEach((c) => walk(c, cat || n.t)));
    sounds.tree.forEach((n) => walk(n));
    console.log(`sounds: ${sounds.tree.length} categories, ${leaves.length} sounds; automatic = "${sounds.auto}"`);
    if (sounds.tree.length < 5 || leaves.length < 100 || !sounds.auto) {
        console.error("FAIL: the MS Basic sound list is incomplete");
        failures++;
    }
    // the part that sounds most in the test window
    let t = null;
    let loudest = 0;
    for (const x of instruments.filter((i) => !i.chords)) {
        call("mss_set_track_solo", x.key, 1);
        call("mss_seek", 0.0);
        call("mss_play");
        const r = capture(seconds, `level of "${x.title}"`).rms;
        call("mss_set_track_solo", x.key, 0);
        if (r > loudest) {
            loudest = r;
            t = x;
        }
    }
    if (t) {
        const before = JSON.parse(callStr("mss_tracks")).find((x) => x.key === t.key);
        // something unlike a voice or piano: a drum kit if this part isn't one, else a pipe organ
        const isDrums = /drum|kit|percussion/i.test(before.sound);
        const other = leaves.find((l) => (isDrums ? /organ/i.test(l.n) : /drum|kit/i.test(l.cat + " " + l.n)) && l.id !== before.soundId);
        call("mss_set_track_solo", t.key, 1);
        const take = (label) => {
            call("mss_seek", 0.0);
            call("mss_play");
            return capture(seconds, label);
        };
        const corr = (a, b) => {
            let ab = 0, aa = 0, bb = 0;
            for (let i = 0; i < Math.min(a.length, b.length); i++) {
                ab += a[i] * b[i];
                aa += a[i] * a[i];
                bb += b[i] * b[i];
            }
            return ab / Math.sqrt(aa * bb || 1);
        };
        const orig = take(`"${t.title}" as in the score (${before.sound})`);
        // two takes of the same sound are not sample-identical (FluidSynth's
        // chorus and the reverb tail of the take before), so compare with that
        const again = take(`"${t.title}" as in the score, again`);
        call("mss_set_track_sound", t.key, other.id);
        const changedInfo = JSON.parse(callStr("mss_tracks")).find((x) => x.key === t.key);
        const changed = take(`"${t.title}" as ${other.n}`);
        writeWav(path.join(outDir, "sound-changed.wav"), changed.pcm);
        call("mss_set_track_sound", t.key, before.scoreSoundId);
        const back = take(`"${t.title}" back to ${before.sound}`);
        const cChanged = corr(orig.pcm, changed.pcm);
        const cBack = corr(orig.pcm, back.pcm);
        const cSame = corr(orig.pcm, again.pcm);
        console.log(`sound change: reported "${changedInfo.sound}"; similarity to the original: same sound again ${cSame.toFixed(3)}, other sound ${cChanged.toFixed(3)}, back again ${cBack.toFixed(3)}`);
        if (changedInfo.soundId !== other.id || changedInfo.sound !== other.n) {
            console.error("FAIL: the track does not report its new sound");
            failures++;
        }
        if (changed.peak < 0.01 || cChanged > 0.5) {
            console.error("FAIL: changing the sound did not change what is heard");
            failures++;
        }
        if (cBack < cSame - 0.05) {
            console.error("FAIL: going back to the score's sound does not sound as before");
            failures++;
        }
        call("mss_set_track_solo", t.key, 0);
    }
}

call("mss_seek", 30);
const seekPos = events.filter((e) => e.type === "position").pop();
console.log("after seek to 30 s:", JSON.stringify(seekPos && seekPos.data));

console.log(failures ? `${failures} check(s) FAILED` : "all checks passed");
process.exit(failures ? 1 : 0);
