// Go to a bar or a section (issue #26), at phone and desktop sizes on every score in
// "real test musescores": the bar field shows where the music is; typing a bar and Enter jumps to
// that bar's start and brings it into view (also in Page by page, and at 50% speed); a number past
// the end goes to the last bar; the section menu shows only for scores with rehearsal marks, follows
// the music, and choosing one jumps there. Screenshots of the bottom bar in build/goto.
//
// Needs the dev server: (cd app && npx vite --port 5180)
// Usage: node scripts/goto-test.mjs [folder or score]

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createRequire } from "node:module";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const require = createRequire(path.join(root, "app/package.json"));
const { chromium } = require("playwright");

const arg = path.resolve(process.argv[2] || path.join(root, "real test musescores"));
const scores = fs.statSync(arg).isDirectory()
    ? fs.readdirSync(arg).filter((f) => /\.mscz$/i.test(f)).map((f) => path.join(arg, f))
    : [arg];
const url = process.env.APP_URL || "http://localhost:5180/";
const outDir = path.join(root, "build/goto");
fs.mkdirSync(outDir, { recursive: true });

let failures = 0;
const check = (ok, what) => {
    console.log(`${ok ? "PASS" : "FAIL"}  ${what}`);
    if (!ok) failures++;
};

const browser = await chromium.launch();

async function openScore(page, file) {
    await page.evaluate(() => {
        app.state.pageEls.forEach((el) => (el.dataset.old = "1"));
        app.state.playbackReady = false;
    });
    await page.setInputFiles("#file-input", file);
    await page.waitForFunction(() => app.state.playbackReady && app.state.pageEls.length > 0
        && !app.state.pageEls[0].dataset.old && document.querySelector(".page canvas"), null, { timeout: 180000 });
}
// the cursor on screen, inside the score's view
const cursorInView = (page) => page.evaluate(() => {
    const c = document.querySelector(".cursor");
    if (!c) return false;
    const r = c.getBoundingClientRect();
    const v = document.getElementById("viewer").getBoundingClientRect();
    return r.top >= v.top - 1 && r.bottom <= v.bottom + 1 && r.left >= v.left - 1 && r.right <= v.right + 1;
});
const typeBar = async (page, n) => {
    await page.click("#bar");
    await page.keyboard.type(String(n));
    await page.keyboard.press("Enter");
    await page.waitForTimeout(700);
};
const where = (page) => page.evaluate(async () => {
    const c = await app.engine.cursor(app.state.position);
    return { secs: app.state.position, measure: c.measure, field: document.getElementById("bar").value, section: document.getElementById("section").selectedOptions[0]?.textContent };
});

for (const [name, width, height, touch] of [["phone", 390, 844, true], ["desktop", 1280, 800, false]]) {
    const context = await browser.newContext({ viewport: { width, height }, deviceScaleFactor: 2, isMobile: touch, hasTouch: touch });
    const page = await context.newPage();
    page.on("pageerror", (e) => console.log(`[${name}] page error:`, e.message));
    await page.goto(url);
    await page.waitForFunction(() => document.getElementById("status").textContent.startsWith("Ready"), null, { timeout: 180000 });
    check(await page.evaluate(() => document.getElementById("goto").hidden), `${name}: no bar field on the start screen`);

    for (const file of name === "phone" ? scores : scores.filter((s) => /Paper Hearts|midnight/.test(s))) {
        const short = path.basename(file).slice(0, 22);
        await openScore(page, file);
        await page.waitForFunction(() => !document.getElementById("goto").hidden, null, { timeout: 20000 }).catch(() => {});
        const info = await page.evaluate(async () => ({ ...(await app.engine.bars()), menu: !document.getElementById("section").hidden }));
        const last = info.bars.at(-1)[0];
        check(info.menu === info.sections.length > 0, `${name} ${short}: section menu ${info.menu ? "shown" : "hidden"} (${info.sections.length} sections)`);

        // a bar in the middle, typed
        const target = info.bars[Math.floor(info.bars.length * 0.6)];
        await typeBar(page, target[0]);
        let w = await where(page);
        check(w.measure === target[0] && Math.abs(w.secs - target[1]) < 0.05 && w.field === String(target[0]),
            `${name} ${short}: typing bar ${target[0]} goes there (bar ${w.measure} at ${w.secs.toFixed(2)} s, field ${w.field})`);
        check(await cursorInView(page), `${name} ${short}: and brings it into view`);

        // past the end
        await typeBar(page, last + 50);
        w = await where(page);
        check(w.measure === last && w.field === String(last), `${name} ${short}: bar ${last + 50} goes to the last bar, ${last} (bar ${w.measure})`);

        // a section
        if (info.sections.length) {
            const [secs, title, bar] = info.sections[Math.floor(info.sections.length / 2)];
            await page.selectOption("#section", { label: title });
            await page.waitForTimeout(700);
            w = await where(page);
            check(Math.abs(w.secs - secs) < 0.05 && w.measure === bar && w.section === title && w.field === String(bar),
                `${name} ${short}: choosing "${title}" goes to bar ${bar} (bar ${w.measure}, menu "${w.section}", field ${w.field})`);
            check(await cursorInView(page), `${name} ${short}: and brings it into view`);
        }
    }

    // follows the music while playing
    const start = await page.evaluate(async () => (await app.engine.bars()).bars[1]);
    await page.evaluate((s) => app.engine.seek(s), start[1] - 0.2);
    await page.waitForTimeout(400);
    await page.click("#play");
    await page.waitForFunction(() => app.state.playing, null, { timeout: 30000 });
    await page.waitForTimeout(6000);
    const playing = await where(page);
    await page.click("#play");
    check(Number(playing.field) === playing.measure && playing.measure > start[0], `${name}: the bar field follows the music (bar ${playing.field} after 6 s from bar ${start[0]})`);
    await page.screenshot({ path: path.join(outDir, `${name}-bottom.png`), clip: { x: 0, y: height - 170, width, height: 170 } });

    // Page by page: the jump turns to the bar's page
    await page.evaluate(() => { const v = document.getElementById("view-mode"); v.value = "page_turn"; v.dispatchEvent(new Event("change")); });
    await page.waitForFunction(() => document.body.classList.contains("page-turn"), null, { timeout: 60000 });
    await page.waitForTimeout(800);
    const late = await page.evaluate(async () => (await app.engine.bars()).bars.at(-3));
    await typeBar(page, late[0]);
    await page.waitForTimeout(800);
    const turned = await page.evaluate(() => {
        const v = document.getElementById("viewer");
        return { shown: Math.round(v.scrollLeft / app.state.pageEls[0].parentElement.offsetWidth), cursorPage: app.cursorAt(app.state.position)?.page };
    });
    check(turned.shown === turned.cursorPage, `${name}: in Page by page the jump turns to its page (page ${turned.shown + 1}, music on page ${turned.cursorPage + 1})`);
    await page.evaluate(() => { const v = document.getElementById("view-mode"); v.value = "page"; v.dispatchEvent(new Event("change")); });
    await page.waitForTimeout(1500);

    // at 50% speed the bars' times follow
    await page.evaluate(() => { const s = document.getElementById("speed"); s.value = "50"; s.dispatchEvent(new Event("input")); s.dispatchEvent(new Event("change")); });
    await page.waitForTimeout(1500);
    const slow = await page.evaluate(async () => (await app.engine.bars()).bars.at(-5));
    await typeBar(page, slow[0]);
    const ws = await where(page);
    check(ws.measure === slow[0], `${name}: at 50% speed, typing bar ${slow[0]} still lands on it (bar ${ws.measure})`);
    await context.close();
}
await browser.close();
console.log(failures ? `\n${failures} FAILED` : "\nall passed");
process.exit(failures ? 1 : 0);
