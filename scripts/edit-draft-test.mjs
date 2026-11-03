// The silent draft of edits: changes survive closing the page, come back when the same score is opened
// (after a question), "Start again" drops them, and a saved copy leaves no draft behind.
// Needs the dev server: (cd app && npx vite --port 5180 --host 127.0.0.1)
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createRequire } from "node:module";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const require = createRequire(path.join(root, "app/package.json"));
const { chromium } = require("playwright");
const scorePath = path.resolve(process.argv[2] || path.join(root, "real test musescores/Paper Hearts.mscz"));
const url = process.env.APP_URL || "http://127.0.0.1:5180/";

let failures = 0;
const check = (ok, msg) => { console.log((ok ? "ok   " : "FAIL ") + msg); failures += ok ? 0 : 1; };

const browser = await chromium.launch({ args: ["--autoplay-policy=no-user-gesture-required"] });
const context = await browser.newContext({ viewport: { width: 1100, height: 900 }, acceptDownloads: true });
const pages = [];
const fresh = async () => {
    const page = await context.newPage();
    page.on("pageerror", (e) => { console.log("[pageerror]", e.message); failures++; });
    pages.push(page);
    await page.goto(url);
    await page.waitForFunction(() => document.getElementById("status").textContent.startsWith("Ready"), null, { timeout: 180000 });
    return page;
};
const draftCount = (page) => page.evaluate(() => new Promise((resolve) => {
    const req = indexedDB.open("pocketscore.editDrafts", 1);
    req.onupgradeneeded = () => req.result.createObjectStore("drafts");
    req.onsuccess = () => {
        const c = req.result.transaction("drafts").objectStore("drafts").count();
        c.onsuccess = () => { req.result.close(); resolve(c.result); };
    };
}));
const openAndWait = async (page, { answer } = {}) => {
    await page.setInputFiles("#file-input", scorePath);
    if (answer) {
        await page.waitForSelector("#ask[open]", { timeout: 60000 });
        await page.click(`#ask .ask-buttons button:has-text("${answer}")`);
    }
    await page.waitForFunction(() => app.state.playbackReady, null, { timeout: 180000 });
    await page.waitForFunction(() => document.querySelectorAll("#pages canvas").length > 0, null, { timeout: 60000 });
};
// the first note found on page 1, selected, then moved up a step: returns its new pitch
const editSomething = async (page) => {
    await page.click("#edit-toggle");
    const sel = await page.evaluate(async () => {
        const sp = app.state.score.spatium, p0 = app.state.score.pages[0];
        for (let y = p0.h * 0.1; y < p0.h * 0.6; y += sp / 2) {
            for (let x = p0.w * 0.25; x < p0.w * 0.8; x += sp) {
                const s = await app.engine.editSelect(0, x, y, sp * 0.4);
                if (s && s.kind === "note") { app.edit.sel = s; app.showEditSel(false); app.updateEditBar(); return s; }
            }
        }
    });
    await page.click("#edit-up");
    await page.waitForFunction(() => !app.edit.busy && app.edit.sel && app.edit.dirty);
    return { before: sel.pitch, after: await page.evaluate(() => app.edit.sel.pitch), x: sel.x, y: sel.y };
};

// 1. an edit leaves a draft
let page = await fresh();
await openAndWait(page);
check(await draftCount(page) === 0, "no draft before any edit");
const e = await editSomething(page);
check(e.after === e.before + 1, `edited a note: ${e.before} -> ${e.after}`);
await page.waitForFunction(async () => true);
await page.waitForTimeout(2500);
check(await draftCount(page) === 1, "the edit is kept as a draft");
await page.close();

// 2. open the same score again: asked, Continue brings the edit back
page = await fresh();
await openAndWait(page, { answer: "Continue my edits" });
check(await page.evaluate(() => app.edit.dirty), "after Continue, the edits count as unsaved");
const again = await page.evaluate(async ({ x, y }) => {
    const s = await app.engine.editSelect(0, x, y, app.state.score.spatium * 0.4);
    return s && s.pitch;
}, e);
check(again === e.after, `the edited note is back (pitch ${again})`);
check(await draftCount(page) === 1, "the draft stays until a copy is saved");

// 3. a saved copy removes the draft
await page.click("#edit-toggle");
await page.evaluate(() => app.updateEditBar());
const [download] = await Promise.all([page.waitForEvent("download", { timeout: 20000 }), page.evaluate(() => document.getElementById("edit-copy").click())]);
check(/\(edited\)\.mscz$/.test(download.suggestedFilename()), "a copy is saved");
await page.waitForTimeout(500);
check(await draftCount(page) === 0, "saving a copy removes the draft");
await page.click("#edit-done");
await page.waitForFunction(() => document.getElementById("editbar").hidden);

// 4. Start again: edit, reload, answer Start again, the original is back and the draft gone
await editSomething(page);
await page.waitForTimeout(2500);
check(await draftCount(page) === 1, "a new edit makes a new draft");
await page.close();
page = await fresh();
await openAndWait(page, { answer: "Start again" });
check(await page.evaluate(() => !app.edit.dirty), "Start again opens the file as it is");
const orig = await page.evaluate(async ({ x, y }) => {
    const s = await app.engine.editSelect(0, x, y, app.state.score.spatium * 0.4);
    return s && s.pitch;
}, e);
check(orig === e.before, `the original note (pitch ${orig})`);
check(await draftCount(page) === 0, "and the draft is gone");

await browser.close();
console.log(failures ? `${failures} failed` : "edit drafts passed");
process.exit(failures ? 1 : 0);
