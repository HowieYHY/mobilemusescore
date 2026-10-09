// Who counts as new (issue #16): a fresh browser is a newcomer, and stays one across reloads until
// the first-time help has been seen; someone with notes, mixer settings or preferences saved before
// this check existed is returning; blocked storage counts as returning (nobody asked every visit).
//
// Needs the dev server: (cd app && npx vite --port 5180)
// Usage: node scripts/firsttime-test.mjs

import path from "node:path";
import { fileURLToPath } from "node:url";
import { createRequire } from "node:module";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const require = createRequire(path.join(root, "app/package.json"));
const { chromium } = require("playwright");
const url = process.env.APP_URL || "http://localhost:5180/";

let failures = 0;
const check = (ok, what) => {
    console.log(`${ok ? "ok  " : "FAIL"} ${what}`);
    if (!ok) failures++;
};

const browser = await chromium.launch();
async function visit(setup) {
    const context = await browser.newContext();
    if (setup) {
        await context.addInitScript(setup);
    }
    const page = await context.newPage();
    await page.goto(url);
    await page.waitForFunction(() => window.app?.firstTime, null, { timeout: 120000 });
    return { context, page, newcomer: () => page.evaluate(() => window.app.firstTime.isNewcomer()) };
}

{
    const { context, page, newcomer } = await visit();
    check(await newcomer(), "a fresh browser is a newcomer");
    await page.reload();
    await page.waitForFunction(() => window.app?.firstTime);
    check(await newcomer(), "still a newcomer after a reload");
    check(!(await page.evaluate(() => window.app.firstTime.hasSeen("tour"))), "the tour hasn't been seen yet");
    await page.evaluate(() => window.app.firstTime.markSeen("tour"));
    await page.reload();
    await page.waitForFunction(() => window.app?.firstTime);
    check(await page.evaluate(() => window.app.firstTime.hasSeen("tour")), "seeing the tour is remembered");
    await context.close();
}
for (const key of ["pocketscore.notesPrefs", "pocketscore.mixer.abc", "pocketscore.notes.abc"]) {
    const { context, newcomer } = await visit(`localStorage.setItem(${JSON.stringify(key)}, "{}")`);
    check(!(await newcomer()), `someone with ${key} saved counts as returning`);
    await context.close();
}
{
    const { context, newcomer } = await visit(() => {
        Object.defineProperty(window, "localStorage", { get() { throw new Error("blocked"); } });
    });
    check(!(await newcomer()), "blocked storage counts as returning");
    await context.close();
}
await browser.close();
console.log(failures ? `${failures} FAILED` : "first-time checks passed");
process.exit(failures ? 1 : 0);
