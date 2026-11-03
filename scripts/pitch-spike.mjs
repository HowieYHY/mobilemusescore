// Spike: can a plain-JS monophonic pitch tracker turn a sung line into notes, and what does it cost?
// Synthetic "voice": harmonics, vibrato, glide into each note, breath noise, a rest. Ground truth known.
const SR = 16000;
const melody = [ // [midi, seconds]  (rest = null)
    [60, 0.5], [62, 0.5], [64, 0.25], [64, 0.25], [65, 0.5], [null, 0.25], [67, 1.0], [65, 0.5], [64, 0.5], [62, 0.5], [60, 1.0],
];
let rnd = 12345; const rand = () => ((rnd = (rnd * 1664525 + 1013904223) >>> 0) / 4294967296) - 0.5;
const total = melody.reduce((a, [, d]) => a + d, 0);
const sig = new Float32Array(Math.ceil((total + 0.2) * SR));
let t0 = 0, phase = 0, prevMidi = 60;
const truth = [];
for (const [m, d] of melody) {
    const n = Math.round(d * SR);
    if (m !== null) truth.push({ midi: m, start: t0 / SR, dur: d });
    for (let i = 0; i < n; i++) {
        const t = (t0 + i) / SR, local = i / SR;
        if (m === null) { sig[t0 + i] = rand() * 0.01; continue; }
        const glide = Math.min(1, local / 0.06);                       // 60 ms slide in from the last note
        const midi = prevMidi + (m - prevMidi) * glide + 0.25 * Math.sin(2 * Math.PI * 5.5 * t) * Math.min(1, local / 0.2); // vibrato +-25 cents
        const f = 440 * 2 ** ((midi - 69) / 12);
        phase += 2 * Math.PI * f / SR;
        let v = 0; for (let h = 1; h <= 6; h++) v += Math.sin(h * phase) / h;
        const env = Math.min(1, local / 0.03) * Math.min(1, (d - local) / 0.05);
        sig[t0 + i] = (v * env * 0.3) + rand() * 0.02;
    }
    if (m !== null) prevMidi = m;
    t0 += n;
}

// ---- tracker: McLeod pitch method on 1024-sample frames every 10 ms
const W = 1024, HOP = 160, MIN_F = 70, MAX_F = 1000;
const minLag = Math.floor(SR / MAX_F), maxLag = Math.floor(SR / MIN_F);
function frame(x, s) {
    let m0 = 0; for (let i = 0; i < W - maxLag; i++) m0 += x[s + i] * x[s + i];
    const nsdf = new Float32Array(maxLag + 1);
    let energy = 0; for (let i = 0; i < W; i++) energy += x[s + i] * x[s + i];
    if (energy / W < 1e-5) return null;
    for (let lag = minLag; lag <= maxLag; lag++) {
        let acf = 0, m = 0;
        for (let i = 0; i < W - lag; i++) { acf += x[s + i] * x[s + i + lag]; m += x[s + i] ** 2 + x[s + i + lag] ** 2; }
        nsdf[lag] = m ? 2 * acf / m : 0;
    }
    // first peak above 0.9 * highest peak (after the first zero crossing)
    let best = 0, peaks = [], pos = minLag;
    while (pos < maxLag && nsdf[pos] > 0) pos++;
    for (let i = pos; i < maxLag; i++) if (nsdf[i] > 0 && nsdf[i] > nsdf[i - 1] && nsdf[i] >= nsdf[i + 1]) { peaks.push(i); best = Math.max(best, nsdf[i]); }
    const pk = peaks.find((i) => nsdf[i] >= 0.9 * best);
    if (pk === undefined || best < 0.6) return null;
    const a = nsdf[pk - 1], b = nsdf[pk], c = nsdf[pk + 1], sh = (a - c) / (2 * (a - 2 * b + c));
    return { f: SR / (pk + (isFinite(sh) ? sh : 0)), clarity: best };
}
const cpu0 = process.cpuUsage(), t1 = performance.now();
const track = [];
for (let s = 0; s + W <= sig.length; s += HOP) { const r = frame(sig, s); track.push(r ? 69 + 12 * Math.log2(r.f / 440) : null); }
const ms = performance.now() - t1;

// ---- notes: bridge short dropouts, split where the pitch settles somewhere new, drop blips
const FR = HOP / SR, med = (v) => { const w = v.slice().sort((x, y) => x - y); return w[w.length >> 1]; };
const notes = [];
{
    let cur = null, gap = 0, cand = [];
    const close = (endFrame) => { if (cur && cur.n >= 6) notes.push({ midi: Math.round(med(cur.v)), start: cur.s * FR, dur: (endFrame - cur.s) * FR }); cur = null; cand = []; };
    track.forEach((p, i) => {
        if (p === null) { if (cur && ++gap > 3) close(i - gap + 1); return; }
        gap = 0;
        if (!cur) { cur = { s: i, n: 1, v: [p] }; return; }
        if (Math.abs(p - med(cur.v)) <= 0.65) { cur.v.push(p); cur.n++; cand = []; return; }
        cand.push(p);                                                  // far from this note: a new note, or a blip?
        const last = cand.slice(-4);
        if (last.length === 4 && last.every((q) => Math.abs(q - last[0]) < 0.5)) { const at = i - 3, keep = last; close(at); cur = { s: at, n: keep.length, v: keep.slice() }; cand = []; }
    });
    if (cur) close(track.length);
}

// ---- compare
let hit = 0; const lines = [];
for (const t of truth) {
    const n = notes.find((x) => Math.abs(x.start - t.start) < 0.12);
    const ok = n && n.midi === t.midi; hit += ok ? 1 : 0;
    lines.push(`${t.midi} @${t.start.toFixed(2)}s -> ${n ? n.midi + " @" + n.start.toFixed(2) + "s " + n.dur.toFixed(2) + "s" : "missed"} ${ok ? "ok" : "WRONG"}`);
}
console.log(lines.join("\n"));
console.log(`notes right: ${hit}/${truth.length}; extra notes: ${Math.max(0, notes.length - truth.length)}`);
console.log(`${(total).toFixed(1)} s of audio tracked in ${ms.toFixed(0)} ms (${(total * 1000 / ms).toFixed(0)}x real time, desktop CPU, one thread)`);
