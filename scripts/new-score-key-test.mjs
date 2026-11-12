// A score made with New score keeps what was saved on it each time it is continued (bug hunt, finding
// 17), by touch on a phone-sized page. Its notes and mixer settings are kept under the score's key; the
// key used to be worked out from the score's contents, which change with every edit, so after closing
// the app and tapping Continue the saved mixer settings (and notes) stayed behind under the old key.
// Makes a new score, adds a note to the music, turns the first line down in the Mixer and saves; closes
// the page; Continue: the same key, the volume as saved, Save not lit; edits again, closes, Continue
// again: still the same. A second new score with the same title gets a key of its own.
// Needs the dev server (it shows the Composer): (cd app && npx vite --port 5180 --host 127.0.0.1)
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createRequire } from "node:module";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const require = createRequire(path.join(root, "app/package.json"));
const { chromium } = require("playwright");
const url = process.env.APP_URL || "http://127.0.0.1:5180/";

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
    await page.waitForFunction(() => !app.state.score); // the start screen, not the page before the reload
    await page.waitForTimeout(300); // showResume reads IndexedDB
};
const key = () => page.evaluate(() => app.state.scoreKey);
// asked of the engine itself: what it plays, not what the page last listed
const firstLine = () => page.evaluate(async () => {
    const t = (await app.engine.tracks()).find((x) => !x.metronome && !x.chords);
    return { key: t.key, volume: t.volume };
});
// the music changed again: the first note (where Edit opens on a continued score) a step higher
const moveNote = async () => {
    const before = await page.evaluate(() => app.edit.undo);
    await page.tap("#edit-up");
    await page.waitForFunction((n) => app.edit.undo > n, before);
    await page.waitForTimeout(1300);
};
const addNote = async () => {
    const before = await page.evaluate(() => app.edit.undo);
    await page.tap("#edit-letters button >> nth=0");
    await page.waitForFunction((n) => app.edit.undo > n, before);
    await page.waitForTimeout(1300); // the draft is written 800 ms after a change
};
const newScore = async (title) => {
    await page.tap("#new-score");
    await page.fill("#ns-title", title);
    await page.tap("#ns-create");
    await page.waitForFunction(() => app.state.score && app.edit.on && app.edit.sel, null, { timeout: 30000 });
    await page.waitForFunction(() => app.state.playbackReady, null, { timeout: 180000 });
};
const continueIt = async () => {
    await page.tap("#resume-score");
    await page.waitForFunction(() => app.state.score && app.edit.on && app.edit.sel, null, { timeout: 30000 });
    await page.waitForFunction(() => app.state.playbackReady, null, { timeout: 180000 });
};

await boot();
await newScore("Keeps");
const key1 = await key();
check(!!key1, `a new score has a key: ${key1}`);
await addNote();

// the first line turned down in the Mixer, and saved
const was = await firstLine();
await page.evaluate(() => document.getElementById("mixer-toggle").click());
await page.waitForSelector("#mixer .vol");
await page.evaluate(() => {
    const vol = document.querySelector("#mixer .strip:not(.master):not(.metronome) .vol");
    vol.value = "50";
    vol.dispatchEvent(new Event("input", { bubbles: true }));
    vol.dispatchEvent(new Event("change", { bubbles: true }));
});
await page.waitForTimeout(300);
const turnedDown = await firstLine();
check(turnedDown.volume < was.volume, `the first line is turned down: ${was.volume.toFixed(1)} dB to ${turnedDown.volume.toFixed(1)} dB`);
await page.waitForFunction(() => !document.getElementById("save").disabled).catch(() => {});
check(await page.isEnabled("#save"), "Save lights up");
await page.evaluate(() => document.getElementById("save").click());
await page.waitForFunction(() => document.getElementById("save").disabled).catch(() => {});
check(!(await page.isEnabled("#save")), "saved");
await page.evaluate(() => document.getElementById("mixer-close").click());
await addNote(); // the music changes after the save, as it does while composing

for (const round of ["first", "second"]) {
    await boot(); // the app closed and opened again
    check(await page.isVisible("#resume-score"), `${round} time: the start screen offers the score`);
    await continueIt();
    check(await key() === key1, `${round} Continue: the same key (${await key()})`);
    const now = await firstLine();
    check(Math.abs(now.volume - turnedDown.volume) < 0.05, `${round} Continue: the saved volume is back (${now.volume.toFixed(1)} dB, saved ${turnedDown.volume.toFixed(1)} dB)`);
    check(!(await page.isEnabled("#save")), `${round} Continue: nothing to save`);
    check(await page.evaluate(() => app.edit.fresh && app.edit.dirty), `${round} Continue: still an unsaved new score`);
    check(await page.evaluate(() => !document.querySelector("dialog[open]")), `${round} Continue: no question asked`);
    await moveNote();
}

// restarting into an update with the new score open: it comes back from its draft, still the same
// score and still a new one (so the start screen goes on offering it), with no question
await boot();
await continueIt();
await moveNote();
await Promise.all([page.waitForEvent("load", { timeout: 60000 }), page.evaluate(() => app.restartForUpdate())]);
const back = await page.waitForFunction(() => app.state.score && app.state.playbackReady, null, { timeout: 180000 }).then(() => true, () => false);
check(back, "after restarting into an update the new score is open again");
check(await page.evaluate(() => !document.querySelector("dialog[open]")), "with no question asked");
check(await key() === key1, `under the same key (${await key()})`);
const after = await firstLine();
check(Math.abs(after.volume - turnedDown.volume) < 0.05, `with its saved volume (${after.volume.toFixed(1)} dB)`);
check(await page.evaluate(() => app.edit.fresh && app.edit.dirty), "and still an unsaved new score");
await page.waitForTimeout(1300);
await boot();
check(await page.isVisible("#resume-score"), "which the start screen still offers afterwards");

// another new score of the same name is another score
await boot();
await newScore("Keeps");
const key2 = await key();
check(key2 && key2 !== key1, `a second new score with the same title has its own key: ${key2}`);
const other = await firstLine();
check(Math.abs(other.volume - was.volume) < 0.05, `and its own mixer: the first line at ${other.volume.toFixed(1)} dB`);

await browser.close();
console.log(failures ? `${failures} failed` : "all passed");
process.exit(failures ? 1 : 0);
