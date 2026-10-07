// Compares this player's playback with audio exported from desktop MuseScore.
//
// For each score with a matching export (same name, .mp3/.wav/.ogg/.flac):
//   1. renders the whole score through the WebAssembly engine with the score's
//      saved mixer settings (as desktop's audio export does) -> build/compare/*.wav
//   2. decodes both files in Chromium, aligns them, and compares
//      - loudness over time (correlation of the level envelopes),
//      - spectrum (per-frame similarity of 32 frequency bands: same instruments?),
//      - overall level, length, timing drift between start and end,
//      - the 10-second stretches that differ most.
//
// Usage: node scripts/compare-audio.mjs [scoresDir] [exportsDir] [otherDir]
//   otherDir: compare exportsDir against these files instead of rendering
//             (e.g. desktop GUI exports vs command-line exports)

import fs from "node:fs";
import path from "node:path";
import { createRequire } from "node:module";

import { createNodeEngine, root, writeWav } from "./lib/node-engine.mjs";

const scoresDir = path.resolve(process.argv[2] || path.join(root, "real test musescores"));
const exportsDir = path.resolve(process.argv[3] || path.join(scoresDir, "audio equivalents"));
const outDir = path.join(root, "build/compare");
fs.mkdirSync(outDir, { recursive: true });

const SR = Number(process.env.RATE || 44100);
const pairs = [];
for (const f of fs.readdirSync(scoresDir).filter((f) => /\.(mscz|mscx)$/i.test(f)).sort()) {
    const base = f.replace(/\.(mscz|mscx)$/i, "");
    const exp = fs.readdirSync(exportsDir).find((e) => e.replace(/\.(mp3|wav|ogg|flac)$/i, "").trim() === base.trim());
    if (exp) {
        pairs.push({ score: path.join(scoresDir, f), exported: path.join(exportsDir, exp), base });
    }
}
console.log(`${pairs.length} score/export pairs`);

// 1. render (or take the files to compare from otherDir)
const otherDir = process.argv[4] && path.resolve(process.argv[4]);
const engine = otherDir ? null : await createNodeEngine({ sampleRate: SR });
for (const p of pairs) {
    if (otherDir) {
        p.rendered = path.join(otherDir, fs.readdirSync(otherDir).find((f) => f.replace(/\.(mp3|wav|ogg|flac)$/i, "").trim() === p.base.trim()));
        p.muted = [];
        continue;
    }
    let info;
    try {
        info = engine.load(p.score);
    } catch (e) {
        console.log(`could not load ${p.base}: ${e.message}`);
        p.skip = true;
        continue;
    }
    // METRONOME=1: metronome on, as on a desktop with the transport's metronome enabled
    if (process.env.METRONOME) {
        engine.call("mss_set_metronome", 1);
    }
    // UNMUTE=1: ignore the mute/solo flags saved in the score
    if (process.env.UNMUTE) {
        for (const t of info.tracks.filter((t) => !t.metronome)) {
            engine.call("mss_set_track_mute", t.key, 0);
            engine.call("mss_set_track_solo", t.key, 0);
        }
    }
    const t0 = Date.now();
    const pcm = engine.render(info.duration);
    p.rendered = path.join(outDir, p.base.replace(/[^\w.-]+/g, "_") + ".wav");
    writeWav(p.rendered, pcm, SR);
    p.title = info.title;
    p.muted = process.env.UNMUTE ? [] : info.tracks.filter((t) => !t.metronome && t.mute).map((t) => t.title);
    console.log(`rendered ${p.base}: ${info.duration.toFixed(1)} s in ${((Date.now() - t0) / 1000).toFixed(1)} s`);
}

// 2. compare in Chromium (it decodes MP3 and the WAV the same way)
const require = createRequire(path.join(root, "app/package.json"));
const { chromium } = require("playwright");
// Serve the audio files over local HTTP (Playwright's request interception
// can't carry files this large)
const http = await import("node:http");
const server = http.createServer((req, res) => {
    const u = new URL(req.url, "http://localhost");
    if (u.pathname === "/") {
        res.writeHead(200, { "content-type": "text/html" });
        return res.end("<!doctype html><title>compare</title>");
    }
    const file = decodeURIComponent(u.pathname.slice(1));
    if (!fs.existsSync(file)) {
        res.writeHead(404);
        return res.end();
    }
    res.writeHead(200, { "content-length": fs.statSync(file).size });
    fs.createReadStream(file).pipe(res);
});
await new Promise((r) => server.listen(0, "127.0.0.1", r));
const base = `http://127.0.0.1:${server.address().port}/`;
const browser = await chromium.launch();
const page = await browser.newPage();
await page.goto(base);

const report = [];
for (const p of pairs.filter((x) => !x.skip)) {
    const r = await page.evaluate(analyse, {
        a: base + encodeURIComponent(p.exported),
        b: base + encodeURIComponent(p.rendered),
        sr: SR,
    });
    report.push({ ...p, ...r });
}
await browser.close();
server.close();

// 3. print
for (const r of report) {
    console.log(`\n=== ${r.base}${r.muted.length ? `   (saved muted: ${r.muted.join(", ")})` : ""}`);
    const B = otherDir ? "other" : "this player";
    console.log(`length (audible)      desktop ${r.lenA.toFixed(1)} s   ${B} ${r.lenB.toFixed(1)} s`);
    console.log(`alignment offset      ${(r.lag * 1000).toFixed(0)} ms   (drift start→end: ${(r.drift * 1000).toFixed(0)} ms)`);
    console.log(`overall level         desktop ${r.levelA.toFixed(1)} dB   ${B} ${r.levelB.toFixed(1)} dB   (diff ${(r.levelB - r.levelA).toFixed(1)} dB)`);
    console.log(`loudness envelope     correlation ${r.envCorr.toFixed(3)}`);
    console.log(`spectrum              similarity ${r.specSim.toFixed(3)}   (1 = identical)`);
    console.log(`band level diff (dB)  ${r.bandDiff.map((v) => (v >= 0 ? "+" : "") + v.toFixed(1)).join(" ")}`);
    console.log(`                      (32 bands, low → high; positive = louder here)`);
    console.log(`least similar 10 s    ${r.worst.map((w) => `${w.t.toFixed(0)}s: env ${w.env.toFixed(2)} spec ${w.spec.toFixed(2)}`).join(" | ")}`);
}
fs.writeFileSync(path.join(outDir, "report.json"), JSON.stringify(report.map(({ rendered, ...r }) => r), null, 1));

// Runs in the browser.
async function analyse({ a, b, sr }) {
    const ctx = new OfflineAudioContext(1, sr, sr);
    const decode = async (url) => {
        const buf = await ctx.decodeAudioData(await (await fetch(url)).arrayBuffer());
        const n = buf.length;
        const out = new Float32Array(n);
        for (let c = 0; c < buf.numberOfChannels; c++) {
            const d = buf.getChannelData(c);
            for (let i = 0; i < n; i++) {
                out[i] += d[i] / buf.numberOfChannels;
            }
        }
        return out;
    };
    const A = await decode(a);
    const B = await decode(b);

    const N = 2048;
    const HOP = 1024;
    const BANDS = 32;
    const hann = new Float32Array(N).map((_, i) => 0.5 - 0.5 * Math.cos(2 * Math.PI * i / N));
    const edges = [];
    for (let k = 0; k <= BANDS; k++) {
        edges.push(Math.round(Math.pow(2, Math.log2(40) + (Math.log2(16000) - Math.log2(40)) * k / BANDS) * N / sr));
    }

    function fft(re, im) {
        const n = re.length;
        for (let i = 1, j = 0; i < n; i++) {
            let bit = n >> 1;
            for (; j & bit; bit >>= 1) {
                j ^= bit;
            }
            j ^= bit;
            if (i < j) {
                [re[i], re[j]] = [re[j], re[i]];
                [im[i], im[j]] = [im[j], im[i]];
            }
        }
        for (let len = 2; len <= n; len <<= 1) {
            const ang = -2 * Math.PI / len;
            const wr = Math.cos(ang);
            const wi = Math.sin(ang);
            for (let i = 0; i < n; i += len) {
                let cr = 1;
                let ci = 0;
                for (let k = 0; k < len / 2; k++) {
                    const ur = re[i + k];
                    const ui = im[i + k];
                    const vr = re[i + k + len / 2] * cr - im[i + k + len / 2] * ci;
                    const vi = re[i + k + len / 2] * ci + im[i + k + len / 2] * cr;
                    re[i + k] = ur + vr;
                    im[i + k] = ui + vi;
                    re[i + k + len / 2] = ur - vr;
                    im[i + k + len / 2] = ui - vi;
                    const t = cr * wr - ci * wi;
                    ci = cr * wi + ci * wr;
                    cr = t;
                }
            }
        }
    }

    function features(x) {
        const frames = Math.max(0, Math.floor((x.length - N) / HOP));
        const rms = new Float32Array(frames);
        const bands = [];
        const re = new Float32Array(N);
        const im = new Float32Array(N);
        for (let f = 0; f < frames; f++) {
            let s = 0;
            for (let i = 0; i < N; i++) {
                const v = x[f * HOP + i];
                s += v * v;
                re[i] = v * hann[i];
                im[i] = 0;
            }
            rms[f] = Math.sqrt(s / N);
            fft(re, im);
            const be = new Float32Array(BANDS);
            for (let k = 0; k < BANDS; k++) {
                let e = 0;
                for (let j = edges[k]; j < Math.max(edges[k] + 1, edges[k + 1]); j++) {
                    e += re[j] * re[j] + im[j] * im[j];
                }
                be[k] = e;
            }
            bands.push(be);
        }
        return { rms, bands };
    }

    const fa = features(A);
    const fb = features(B);
    const db = (v) => 20 * Math.log10(Math.max(v, 1e-6));

    // align by cross-correlating the level envelopes (±3 s)
    function bestLag(ea, eb, from, to, maxLag) {
        let best = 0;
        let bestC = -Infinity;
        for (let lag = -maxLag; lag <= maxLag; lag++) {
            let c = 0;
            for (let i = from; i < to; i++) {
                const j = i + lag;
                if (j >= 0 && j < eb.length && i < ea.length) {
                    c += ea[i] * eb[j];
                }
            }
            if (c > bestC) {
                bestC = c;
                best = lag;
            }
        }
        return best;
    }
    const maxLag = Math.round(3 * sr / HOP);
    const total = Math.min(fa.rms.length, fb.rms.length);
    const lag = bestLag(fa.rms, fb.rms, 0, total, maxLag);
    const w = Math.round(30 * sr / HOP);
    const lagStart = bestLag(fa.rms, fb.rms, 0, Math.min(w, total), maxLag);
    const lagEnd = bestLag(fa.rms, fb.rms, Math.max(0, total - w - maxLag), total - maxLag, maxLag);

    const pairsIdx = [];
    for (let i = 0; i < fa.rms.length; i++) {
        const j = i + lag;
        if (j >= 0 && j < fb.rms.length) {
            pairsIdx.push([i, j]);
        }
    }

    function corr(xs, ys) {
        const n = xs.length;
        const mx = xs.reduce((s, v) => s + v, 0) / n;
        const my = ys.reduce((s, v) => s + v, 0) / n;
        let sxy = 0;
        let sxx = 0;
        let syy = 0;
        for (let i = 0; i < n; i++) {
            sxy += (xs[i] - mx) * (ys[i] - my);
            sxx += (xs[i] - mx) ** 2;
            syy += (ys[i] - my) ** 2;
        }
        return sxy / Math.sqrt(sxx * syy || 1);
    }
    function cos(u, v) {
        let d = 0;
        let nu = 0;
        let nv = 0;
        for (let k = 0; k < u.length; k++) {
            const a1 = Math.sqrt(u[k]);
            const b1 = Math.sqrt(v[k]);
            d += a1 * b1;
            nu += a1 * a1;
            nv += b1 * b1;
        }
        return d / Math.sqrt(nu * nv || 1);
    }

    const audible = pairsIdx.filter(([i, j]) => db(fa.rms[i]) > -50 || db(fb.rms[j]) > -50);
    const envCorr = corr(audible.map(([i]) => db(fa.rms[i])), audible.map(([, j]) => db(fb.rms[j])));
    const loud = pairsIdx.filter(([i, j]) => db(fa.rms[i]) > -40 && db(fb.rms[j]) > -40);
    const specSim = loud.reduce((s, [i, j]) => s + cos(fa.bands[i], fb.bands[j]), 0) / Math.max(1, loud.length);

    const bandDiff = [];
    for (let k = 0; k < BANDS; k++) {
        let sa = 0;
        let sb = 0;
        for (const [i, j] of loud) {
            sa += fa.bands[i][k];
            sb += fb.bands[j][k];
        }
        bandDiff.push(10 * Math.log10((sb + 1e-12) / (sa + 1e-12)));
    }

    const meanSq = (x) => x.reduce((s, v) => s + v * v, 0) / x.length;
    const lastAudible = (rms) => {
        for (let f = rms.length - 1; f >= 0; f--) {
            if (db(rms[f]) > -50) {
                return (f * HOP + N) / sr;
            }
        }
        return 0;
    };

    // 10-second windows
    const win = Math.round(10 * sr / HOP);
    const windows = [];
    for (let s = 0; s + win <= pairsIdx.length; s += win) {
        const seg = pairsIdx.slice(s, s + win);
        const aud = seg.filter(([i, j]) => db(fa.rms[i]) > -50 || db(fb.rms[j]) > -50);
        const ld = seg.filter(([i, j]) => db(fa.rms[i]) > -40 && db(fb.rms[j]) > -40);
        if (aud.length < win / 4) {
            continue;
        }
        windows.push({
            t: seg[0][0] * HOP / sr,
            env: corr(aud.map(([i]) => db(fa.rms[i])), aud.map(([, j]) => db(fb.rms[j]))),
            spec: ld.length ? ld.reduce((s2, [i, j]) => s2 + cos(fa.bands[i], fb.bands[j]), 0) / ld.length : 0,
        });
    }
    windows.sort((x, y) => (x.env + x.spec) - (y.env + y.spec));

    return {
        lenA: lastAudible(fa.rms),
        lenB: lastAudible(fb.rms),
        lag: lag * HOP / sr,
        drift: (lagEnd - lagStart) * HOP / sr,
        levelA: 10 * Math.log10(meanSq(A) + 1e-12),
        levelB: 10 * Math.log10(meanSq(B) + 1e-12),
        envCorr,
        specSim,
        bandDiff,
        worst: windows.slice(0, 3),
    };
}
