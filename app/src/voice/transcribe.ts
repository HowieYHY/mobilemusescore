// Voice to notes, one voice: pitch by the McLeod method (plain JavaScript, no model to download), then notes,
// then the notes on a grid of sixteenths. Runs on 16 kHz mono; about 37 times faster than real time on a
// desktop (scripts/pitch-spike.mjs), and the only memory is the audio itself.

export const SAMPLE_RATE = 16000;
const W = 1024;
const HOP = 160; // 10 ms
const MIN_F = 70;
const MAX_F = 1000;
const MIN_LAG = Math.floor(SAMPLE_RATE / MAX_F);
const MAX_LAG = Math.floor(SAMPLE_RATE / MIN_F);
const FRAME_SECS = HOP / SAMPLE_RATE;

/** One 10 ms step: the pitch as a (fractional) MIDI number, or null where nothing is sung, and the loudness. */
export interface PitchFrame { midi: number | null; rms: number }
/** A note as sung: seconds from the start of the recording. */
export interface SungNote { midi: number; start: number; dur: number }
/** A note on the grid: sixteenths from where the tune starts (midi -1 is a rest). */
export interface GridNote { midi: number; units: number }

const nsdf = new Float32Array(MAX_LAG + 1);

function trackFrame(x: Float32Array, s: number): PitchFrame {
    let energy = 0;
    for (let i = 0; i < W; i++) {
        energy += x[s + i] * x[s + i];
    }
    // loudness over the middle 20 ms only: the whole window would blur the dip between two equal notes
    let mid = 0;
    for (let i = W / 2 - 160; i < W / 2 + 160; i++) {
        mid += x[s + i] * x[s + i];
    }
    const rms = Math.sqrt(mid / 320);
    if (energy / W < 1e-5) {
        return { midi: null, rms };
    }
    for (let lag = MIN_LAG; lag <= MAX_LAG; lag++) {
        let acf = 0;
        let m = 0;
        for (let i = 0; i < W - lag; i++) {
            const a = x[s + i];
            const b = x[s + i + lag];
            acf += a * b;
            m += a * a + b * b;
        }
        nsdf[lag] = m ? (2 * acf) / m : 0;
    }
    // the first peak that is nearly as high as the highest, after the first dip below zero
    let pos = MIN_LAG;
    while (pos < MAX_LAG && nsdf[pos] > 0) {
        pos++;
    }
    let best = 0;
    const peaks: number[] = [];
    for (let i = pos; i < MAX_LAG; i++) {
        if (nsdf[i] > 0 && nsdf[i] > nsdf[i - 1] && nsdf[i] >= nsdf[i + 1]) {
            peaks.push(i);
            best = Math.max(best, nsdf[i]);
        }
    }
    const pk = peaks.find((i) => nsdf[i] >= 0.9 * best);
    if (pk === undefined || best < 0.6) {
        return { midi: null, rms };
    }
    const a = nsdf[pk - 1];
    const b = nsdf[pk];
    const c = nsdf[pk + 1];
    const shift = (a - c) / (2 * (a - 2 * b + c));
    const f = SAMPLE_RATE / (pk + (isFinite(shift) ? shift : 0));
    return { midi: 69 + 12 * Math.log2(f / 440), rms };
}

/** Pitch every 10 ms. Gives the page back now and then so a phone stays responsive, and reports progress (0 to 1). */
export async function trackPitch(x: Float32Array, onProgress?: (done: number) => void): Promise<PitchFrame[]> {
    const frames: PitchFrame[] = [];
    let n = 0;
    for (let s = 0; s + W <= x.length; s += HOP) {
        frames.push(trackFrame(x, s));
        if (++n % 60 === 0) {
            onProgress?.(s / x.length);
            await new Promise((r) => setTimeout(r, 0));
        }
    }
    onProgress?.(1);
    return frames;
}

const median = (v: number[]) => {
    const w = v.slice().sort((p, q) => p - q);
    return w[w.length >> 1];
};

/**
 * Notes from the pitch track: short dropouts are bridged, a new note starts where the pitch settles somewhere
 * new (not for a passing glide), and the same pitch sung again starts a new note where the loudness dips and
 * comes back.
 */
export function findNotes(frames: PitchFrame[]): SungNote[] {
    const notes: SungNote[] = [];
    interface Cur { s: number; v: number[]; peak: number; dipMin: number; dipping: boolean }
    let cur: Cur | null = null;
    let gap = 0;
    let cand: number[] = [];
    const close = (endFrame: number) => {
        if (cur && cur.v.length >= 8) {
            notes.push({ midi: Math.round(median(cur.v)), start: cur.s * FRAME_SECS, dur: (endFrame - cur.s) * FRAME_SECS });
        }
        cur = null;
        cand = [];
    };
    const begin = (s: number, v: number[], rms: number) => {
        cur = { s, v, peak: rms, dipMin: rms, dipping: false };
    };
    frames.forEach((f, i) => {
        const p = f.midi;
        if (p === null) {
            if (cur && ++gap > 3) {
                close(i - gap + 1);
            }
            return;
        }
        gap = 0;
        if (!cur) {
            begin(i, [p], f.rms);
            return;
        }
        const c: Cur = cur;
        if (Math.abs(p - median(c.v)) <= 0.65) {
            // the same note: has it been sung again? (loudness fell well below the note's peak and came back)
            c.peak = Math.max(c.peak, f.rms);
            if (c.dipping) {
                c.dipMin = Math.min(c.dipMin, f.rms);
                if (f.rms > c.dipMin * 2 && f.rms > c.peak * 0.6 && i - c.s >= 8) {
                    close(i);
                    begin(i, [p], f.rms);
                    return;
                }
                if (f.rms > c.peak * 0.8) {
                    c.dipping = false;
                }
            } else if (f.rms < c.peak * 0.55) {
                c.dipping = true;
                c.dipMin = f.rms;
            }
            c.v.push(p);
            cand = [];
            return;
        }
        cand.push(p);
        const last = cand.slice(-4);
        if (last.length === 4 && last.every((q) => Math.abs(q - last[0]) < 0.5)) {
            const at = i - 3;
            close(at);
            begin(at, last.slice(), f.rms);
        }
    });
    if (cur) {
        close(frames.length);
    }
    // a short note straight into another one a step or two away is the slide into it, not a note
    for (let i = 0; i < notes.length - 1; i++) {
        const n = notes[i];
        const next = notes[i + 1];
        if (n.dur < 0.12 && next.start - (n.start + n.dur) < 0.05 && Math.abs(next.midi - n.midi) <= 2) {
            next.dur += next.start - n.start;
            next.start = n.start;
            notes.splice(i, 1);
            i--;
        }
    }
    return notes;
}

/**
 * The notes on a grid: `bpm` quarter notes a minute, `smallest` the shortest note kept (16 for sixteenths,
 * 8 for eighths). The first note starts the tune, so silence before it is dropped; gaps become rests.
 * `shift` moves the tune up or down by octaves.
 */
export function toGrid(notes: SungNote[], bpm: number, smallest: 8 | 16, shift = 0): GridNote[] {
    if (!notes.length) {
        return [];
    }
    const unit = 60 / (bpm * 4); // a sixteenth, in seconds
    const step = smallest === 8 ? 2 : 1;
    const snap = (secs: number) => Math.round(secs / unit / step) * step;
    const t0 = notes[0].start;
    const out: GridNote[] = [];
    let at = 0;
    for (const n of notes) {
        let s = snap(n.start - t0);
        const e = Math.max(s + step, snap(n.start + n.dur - t0));
        s = Math.max(s, at);
        if (s > at) {
            out.push({ midi: -1, units: s - at });
            at = s;
        }
        const len = e - at;
        if (len <= 0) {
            continue;
        }
        out.push({ midi: Math.max(0, Math.min(127, n.midi + 12 * shift)), units: len });
        at = e;
    }
    return out;
}

/** Audio in any format the browser can decode (a recording or a file), as 16 kHz mono. */
export async function decodeTo16k(data: ArrayBuffer): Promise<Float32Array> {
    const Ctx = window.AudioContext || (window as any).webkitAudioContext;
    const ctx = new Ctx();
    try {
        const buf: AudioBuffer = await new Promise((resolve, reject) => ctx.decodeAudioData(data, resolve, reject));
        const frames = Math.max(1, Math.ceil(buf.duration * SAMPLE_RATE));
        const off = new OfflineAudioContext(1, frames, SAMPLE_RATE);
        const src = off.createBufferSource();
        src.buffer = buf; // mixed down to one channel by the offline context
        src.connect(off.destination);
        src.start();
        return (await off.startRendering()).getChannelData(0).slice();
    } finally {
        void ctx.close();
    }
}
