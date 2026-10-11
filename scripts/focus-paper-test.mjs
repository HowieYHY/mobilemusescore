// Focus mode, far zoomed out: a tap on blank paper or on the screen around the paper leaves focus;
// a tap on the music (printed ink inside a line of music) stays in focus and plays from there. Page view and
// both continuous views; blank or printed is judged from a screenshot, as the reader sees it.
//
// Needs the dev server: (cd app && npx vite --host 127.0.0.1 --port 5180)
// Usage: node scripts/focus-paper-test.mjs [score.mscz]

import path from "node:path";
import fs from "node:fs";
import { fileURLToPath } from "node:url";
import { createRequire } from "node:module";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const { chromium } = createRequire(path.join(root, "app/package.json"))("playwright");
const scorePath = path.resolve(process.argv[2] || path.join(root, "real test musescores/I am move it edited.mscz"));
const url = process.env.APP_URL || "http://127.0.0.1:5180/";
let failures = 0;
const check = (ok, msg) => {
    console.log((ok ? "ok   " : "FAIL ") + msg);
    failures += ok ? 0 : 1;
};

const b = await chromium.launch();
const ctx = await b.newContext({ viewport: { width: 412, height: 915 }, deviceScaleFactor: 1, isMobile: true, hasTouch: true });
const pg = await ctx.newPage(); const cdp = await ctx.newCDPSession(pg);
await pg.goto(url);
await pg.waitForFunction(() => document.getElementById("status").textContent.startsWith("Ready"), null, { timeout: 120000 });
const b64 = fs.readFileSync(scorePath).toString("base64");
await pg.evaluate(async (b64) => { const s = atob(b64); const u = new Uint8Array(s.length); for (let i = 0; i < s.length; i++) u[i] = s.charCodeAt(i); await app.openScore("x.mscz", u.buffer); }, b64);
await pg.waitForSelector(".page canvas"); await pg.waitForFunction(() => app.state.playbackReady, null, { timeout: 120000 }); await pg.waitForTimeout(1500);
const tap = async (x, y) => { await cdp.send("Input.dispatchTouchEvent", { type: "touchStart", touchPoints: [{ x, y, id: 1 }] }); await pg.waitForTimeout(30); await cdp.send("Input.dispatchTouchEvent", { type: "touchEnd", touchPoints: [] }); await pg.waitForTimeout(250); };
for (const mode of ["page", "continuous_h", "continuous_v"]) {
  if (mode !== "page") { await pg.selectOption("#view-mode", mode); await pg.waitForTimeout(2000); }
  for (let i = 0; i < 12; i++) { await pg.click("#zoom-out"); await pg.waitForTimeout(100); }
  await pg.waitForTimeout(800);
  await pg.click("#focus-toggle"); await pg.waitForTimeout(2500);
  // what is drawn: blank paper or grey around each grid point (without focus mode's hint, which
  // floats over the paper and takes no taps)
  await pg.evaluate(() => (document.getElementById("focus-hint").style.visibility = "hidden"));
  const png = await pg.screenshot();
  await pg.evaluate(() => (document.getElementById("focus-hint").style.visibility = ""));
  const shot = await pg.evaluate(async (data) => {
    const img = new Image(); img.src = "data:image/png;base64," + data; await img.decode();
    const c = document.createElement("canvas"); c.width = img.width; c.height = img.height; const x = c.getContext("2d"); x.drawImage(img, 0, 0);
    const d = x.getImageData(0, 0, c.width, c.height).data; const W = c.width;
    const pageR = [...document.querySelectorAll(".page")].map((p) => p.getBoundingClientRect());
    // the lines of music (systems) from the timeline: printed ink inside one is the music (the title isn't)
    const tl = await app.engine.timeline();
    const inSystem = (x, y) => pageR.some((r, i) => {
        const k = r.width / app.state.score.pages[i].w;
        const ux = (x - r.left) / k, uy = (y - r.top) / k;
        return x >= r.left && x <= r.right && tl.some((p) => p[1] === i && uy >= p[3] && uy <= p[3] + p[4] && Math.abs(ux - p[2]) < 600);
    });
    const v = document.getElementById("viewer").getBoundingClientRect();
    const out = [];
    for (let y = v.top + 20; y < v.bottom - 110; y += 23) for (let x = 20; x < v.right - 20; x += 23) {
      const onPaper = pageR.some((r) => x > r.left + 2 && x < r.right - 2 && y > r.top + 2 && y < r.bottom - 2);
      let ink = false;
      for (let dy = -10; dy <= 10 && !ink; dy++) for (let dx = -10; dx <= 10; dx++) { const i = ((Math.round(y) + dy) * W + Math.round(x) + dx) * 4; if (d[i] < 200) { ink = true; break; } }
      // ink right under the tap: on the music
      let under = false;
      for (let dy = -2; dy <= 2 && !under; dy++) for (let dx = -2; dx <= 2; dx++) { const i = ((Math.round(y) + dy) * W + Math.round(x) + dx) * 4; if (d[i] < 120) { under = true; break; } }
      if (!onPaper || !ink) out.push({ x, y, kind: onPaper ? "blank paper" : "around the paper" });
      else if (under && inSystem(x, y)) out.push({ x, y, kind: "music" });
    }
    return out;
  }, png.toString("base64"));
  const blank = shot.filter((p) => p.kind !== "music").slice(0, 40);
  const music = shot.filter((p) => p.kind === "music").slice(0, 12);
  let stuck = 0, left = 0;
  const examples = [];
  for (const p of blank) {
    if (!(await pg.evaluate(() => app.state.focus))) { await pg.click("#focus-toggle").catch(() => {}); await pg.waitForTimeout(600); }
    await tap(p.x, p.y);
    if (await pg.evaluate(() => app.state.focus)) { stuck++; if (examples.length < 4) examples.push(`${p.kind} ${Math.round(p.x)},${Math.round(p.y)}`); }
  }
  for (const p of music) {
    if (!(await pg.evaluate(() => app.state.focus))) { await pg.click("#focus-toggle").catch(() => {}); await pg.waitForTimeout(600); }
    await tap(p.x, p.y);
    if (!(await pg.evaluate(() => app.state.focus))) { left++; if (examples.length < 6) examples.push(`music ${Math.round(p.x)},${Math.round(p.y)}`); }
  }
  check(blank.length > 0 && stuck === 0, `${mode}: ${blank.length} taps on blank paper or around it all leave focus (${stuck} didn't) ${examples.join(" | ")}`);
  check(music.length > 0 && left === 0, `${mode}: ${music.length} taps on the music stay in focus (${left} left it)`);
  if (await pg.evaluate(() => app.state.focus)) { await pg.keyboard.press("Escape"); await pg.waitForTimeout(500); }
}
await b.close();
console.log(failures ? `${failures} failure(s)` : "all focus paper checks passed");
process.exit(failures ? 1 : 0);
