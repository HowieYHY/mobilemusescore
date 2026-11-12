// Opening a file that can't be read while a score is open (bug hunt, findings 9, 10 and 19): the engine lets go
// of the open score before it tries the new file, so the app must go back to its start screen, not keep the old
// pages on screen with Play, the mixer and editing dead. A file that is no score at all must change nothing.
// Needs the dev server: (cd app && npx vite --port 5180 --host 127.0.0.1)
import fs from "node:fs";
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

const browser = await chromium.launch();
const page = await (await browser.newContext({ viewport: { width: 412, height: 915 }, isMobile: true, hasTouch: true })).newPage();
page.on("pageerror", (e) => { console.log("[pageerror]", e.message); failures++; });
await page.goto(url);
await page.waitForFunction(() => document.getElementById("status").textContent.startsWith("Ready"), null, { timeout: 180000 });
const b64 = fs.readFileSync(scorePath).toString("base64");
const open = (name, data) => page.evaluate(async ({ name, data }) => {
    const bin = atob(data);
    const u = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) u[i] = bin.charCodeAt(i);
    return app.openScore(name, u.buffer);
}, { name, data });
const look = () => page.evaluate(() => ({
    score: !!app.state.score, key: app.state.scoreKey, pages: document.querySelectorAll("#pages .page").length,
    start: !document.getElementById("empty").hidden, play: !document.getElementById("play").disabled,
    mixer: !document.getElementById("mixer-toggle").disabled, title: document.getElementById("score-title").textContent,
    status: document.getElementById("status").textContent, layers: app.layers.length,
}));

check(await open("Paper Hearts.mscz", b64) === true, "a score opens");
await page.waitForSelector("#pages .page canvas");
const first = await look();
check(first.score && first.pages > 0 && first.play && first.mixer, `it shows, with Play and the Mixer on (${first.pages} pages)`);

// not a score at all: nothing changes
check(await open("holiday.pdf", b64) === false, "a file that is no score is refused");
const same = await look();
check(same.score && same.key === first.key && same.pages === first.pages && same.play && same.mixer, "and the open score is untouched: " + same.status);
// the sounds may still be loading (a first visit): their progress must not write over the message
await page.waitForTimeout(1500);
const told = (await look()).status;
check(/not a MuseScore file/.test(told), "and the message saying so stays up: " + told);

// Play tapped while the sounds load must not start the next score (finding 19): open the mixer too, a panel
await page.evaluate(() => document.getElementById("mixer-toggle").click());
// a .mscz that can't be read
const junk = Buffer.from(Array.from({ length: 4000 }, (_, i) => (i * 37 + 11) % 251)).toString("base64");
check(await open("broken.mscz", junk) === false, "a damaged .mscz is refused");
const after = await look();
check(!after.score && after.pages === 0 && after.start, "the start screen is back, the old pages gone");
check(!after.play && !after.mixer && after.title === "PocketScore" && after.layers === 0, `Play and the Mixer are off, no panel is left open (title "${after.title}", ${after.layers} panels)`);
check(/open|read|MuseScore/i.test(after.status), "and it says why: " + after.status);
await page.waitForTimeout(1500);
const why = (await look()).status;
check(/open|read|MuseScore/i.test(why) && !/Loading/.test(why), "and goes on saying so while the sounds load: " + why);

check(await open("Paper Hearts.mscz", b64) === true, "the score opens again afterwards");
await page.waitForSelector("#pages .page canvas");
const again = await look();
check(again.score && again.pages === first.pages && again.play && again.mixer && !again.start, "and shows as before");

await browser.close();
console.log(failures ? `${failures} failed` : "open-fail test passed");
process.exit(failures ? 1 : 0);
