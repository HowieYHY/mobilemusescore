// New score from inside an open score (Edit > More > New score), by touch on a phone-sized page:
// a first score with an edit, then New score. Cancel at "Save a copy of … before closing it?" must leave the first score
// as it was (still open, still edited, not turned into a new one); Don't keep opens the new score in
// Edit on its first rest, with one Back entry for Edit (Back closes it, and once more leaves nothing).
// Needs the dev server: (cd app && npx vite --port 5180 --host 127.0.0.1)
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createRequire } from "node:module";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const require = createRequire(path.join(root, "app/package.json"));
const { chromium } = require("playwright");
const url = process.env.APP_URL || "http://127.0.0.1:5180/";

let failures = 0;
const check = (ok, msg) => { console.log((ok ? "ok   " : "FAIL ") + msg); failures += ok ? 0 : 1; };

const browser = await chromium.launch({ args: ["--autoplay-policy=no-user-gesture-required"] });
const context = await browser.newContext({
    viewport: { width: 412, height: 915 }, deviceScaleFactor: 2, isMobile: true, hasTouch: true,
    userAgent: "Mozilla/5.0 (Linux; Android 16; Pixel 9a) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140.0.0.0 Mobile Safari/537.36",
});
const page = await context.newPage();
page.on("pageerror", (e) => check(false, "page error: " + e.message));
await page.goto(url);
await page.waitForFunction(() => window.app?.engine);

const title = () => page.textContent("#score-title");
const state = () => page.evaluate(() => ({
    on: app.edit.on, fresh: app.edit.fresh, dirty: app.edit.dirty, sel: !!app.edit.sel,
    more: !document.getElementById("edit-more").hidden, hist: history.length, selAt: JSON.stringify(app.edit.sel),
}));
async function create(name) {
    await page.fill("#ns-title", name);
    await page.tap("#ns-create");
}

// the first score, from the start screen, with one note put in
await page.tap("#new-score");
await create("First");
await page.waitForFunction(() => app.edit.on && app.edit.sel);
await page.tap('.piano-key[data-midi="60"]');
await page.waitForFunction(() => app.edit.undo > 0);
check((await title()).includes("First"), "first score open in Edit, one note in");

// More > New score, then Cancel at the question
await page.tap("#edit-morebtn");
check(await page.isVisible("#edit-newscore"), "New score is in More");
await page.tap("#edit-newscore");
check(await page.isVisible("#newscore"), "the New score dialog opens over the score");
await create("Second");
await page.waitForSelector("#ask[open]");
check((await page.textContent("#ask")).includes("Save a copy of “First” before closing it?"), "asks, in desktop's words, about the first score");
const before = await state();
await page.tap("#ask button:has-text('Cancel')");
await page.waitForTimeout(400);
const afterCancel = await state();
check((await title()).includes("First"), "Cancel: the first score stays open");
check(afterCancel.on && afterCancel.dirty && afterCancel.fresh === before.fresh, "Cancel: still in Edit, its edits kept, not made a new score again");
check(afterCancel.hist === before.hist, "Cancel: no Back entry added");
check(afterCancel.selAt === before.selAt, "Cancel: the picked note stays where it was (not back to the first rest)");

// again, and Don't keep
await page.tap("#edit-newscore");
await create("Second");
await page.waitForSelector("#ask[open]");
await page.tap("#ask button:has-text(\"Don't keep\")");
await page.waitForFunction(() => document.getElementById("score-title").textContent.includes("Second") && app.edit.sel, null, { timeout: 20000 });
const fresh = await state();
check(fresh.on && fresh.fresh && fresh.sel, "Don't keep: the new score opens in Edit with its first rest picked");
check(!fresh.more, "the More panel is closed, so the new score shows");
check(fresh.hist === afterCancel.hist, "Edit's Back entry is reused, not doubled");

// Back closes Edit; nothing else waits behind it
await page.goBack();
await page.waitForTimeout(300);
check(!(await state()).on, "Back closes Edit");
check((await title()).includes("Second"), "and the new score stays open");

await browser.close();
console.log(failures ? `${failures} failed` : "all passed");
process.exit(failures ? 1 : 0);
