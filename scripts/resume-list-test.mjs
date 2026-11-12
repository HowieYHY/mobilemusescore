// Every unsaved new score is offered on the start screen, by touch on a phone-sized page: three new
// scores (A, B, C), each with a note and the page closed after it. The start screen offers C, with
// "2 more" behind it (closed until tapped); the list holds B and A; Continue on A opens A with its note;
// Discard takes one out; and with one left the link goes. Screenshots at 360 and 412 px, no sideways
// scrolling. Needs the dev server: (cd app && npx vite --port 5180 --host 127.0.0.1)
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createRequire } from "node:module";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const require = createRequire(path.join(root, "app/package.json"));
const { chromium } = require("playwright");
const url = process.env.APP_URL || "http://127.0.0.1:5180/";
const shots = process.env.SHOTS || path.join(root, "build/resume-shots");
fs.mkdirSync(shots, { recursive: true });

let failures = 0;
const check = (ok, msg) => { console.log((ok ? "ok   " : "FAIL ") + msg); failures += ok ? 0 : 1; };

const browser = await chromium.launch();
const context = await browser.newContext({
    viewport: { width: 412, height: 915 }, deviceScaleFactor: 2, isMobile: true, hasTouch: true,
    userAgent: "Mozilla/5.0 (Linux; Android 16; Pixel 9a) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140.0.0.0 Mobile Safari/537.36",
});
const page = await context.newPage();
page.on("pageerror", (e) => check(false, "page error: " + e.message));
const boot = async () => {
    await page.goto(url);
    await page.waitForFunction(() => document.getElementById("status").textContent.startsWith("Ready"), null, { timeout: 180000 });
    await page.waitForTimeout(300); // showResume reads IndexedDB
};
const visible = (sel) => page.isVisible(sel);
const text = (sel) => page.textContent(sel).then((t) => t.replace(/\s+/g, " ").trim());
const count = () => page.evaluate(() => new Promise((res) => {
    const r = indexedDB.open("pocketscore.editDrafts", 1);
    r.onsuccess = () => { const q = r.result.transaction("drafts").objectStore("drafts").getAll(); q.onsuccess = () => res(q.result.filter((d) => d.fresh).length); };
}));

await boot();
check(!(await visible("#resume-row")), "no unsaved new scores: nothing offered");
for (const name of ["A", "B", "C"]) {
    await page.tap("#new-score");
    await page.fill("#ns-title", name);
    await page.tap("#ns-create");
    await page.waitForFunction(() => app.edit.on && app.edit.sel);
    await page.tap("#edit-letters button >> nth=0");
    await page.waitForFunction(() => app.edit.undo > 0);
    await page.waitForTimeout(1300); // the draft is written 800 ms after a change
    await boot();
}
check(await count() === 3, "three drafts kept");
check(await text("#resume-score") === "Continue “C”", "the newest is offered first: " + await text("#resume-score"));
check(await visible("#resume-more") && await text("#resume-more") === "2 more", "a small \"2 more\" link");
check(!(await visible("#resume-list")), "the others stay out of the way until asked for");

await page.tap("#resume-more");
const items = await page.$$eval("#resume-list .resume-item .btn:first-child", (bs) => bs.map((b) => b.textContent));
check(items.join("|") === "Continue “B”|Continue “A”", "the list holds B then A: " + items.join(" / "));
check(await page.$eval("#resume-more", (b) => b.getAttribute("aria-expanded")) === "true", "the link says it is open");
for (const w of [360, 412]) {
    await page.setViewportSize({ width: w, height: 800 });
    await page.waitForTimeout(150);
    check(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), `${w} px: no sideways scrolling`);
    await page.screenshot({ path: path.join(shots, `resume-${w}.png`) });
}

await page.tap("#resume-list .resume-item:nth-child(2) .btn:first-child");
await page.waitForFunction(() => app.state.score && app.edit.on && app.edit.sel, null, { timeout: 30000 });
check((await text("#score-title")).includes("A"), "Continue on A opens A");
check(await page.evaluate(() => app.edit.fresh && app.edit.dirty), "as an unsaved new score");
await page.waitForTimeout(1300);
check(await count() === 3, "A is still kept (its draft stays under its own key)");

await boot();
await page.tap("#resume-more");
const before = await count();
check(await text("#resume-score") === "Continue “A”", "the one continued last is offered first now");
await page.tap("#resume-list .resume-item:first-child .btn.plain");
await page.waitForTimeout(400);
check(await count() === before - 1, "Discard in the list takes that one out");
check(await visible("#resume-list") && await text("#resume-more") === "1 more", "the list stays open, now \"1 more\"");
await page.tap("#resume-list .resume-item:first-child .btn.plain");
await page.waitForTimeout(400);
check(!(await visible("#resume-more")), "with one left, the link goes");
check(!(await visible("#resume-list")), "and so does the list");

await browser.close();
console.log(failures ? `${failures} failed` : "all passed");
process.exit(failures ? 1 : 0);
