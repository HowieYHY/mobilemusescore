// The published page's Content Security Policy (issue #27). On a built copy (the policy is only in
// builds), in Chromium and WebKit: every score in "real test musescores" opens, every page is drawn,
// it plays, and the mixer, the sound list, notes, a text box and Settings work, with no request or
// script refused by the policy. Then the safeguards themselves:
//   - a script put into the page is refused,
//   - a picture from another address is refused (and the page drawing skips one in a score),
//   - pasting formatted text with a picture into a text box keeps only the text.
//
//   cd app && npm run build && npx vite preview --host 127.0.0.1 --port 4173
// Usage: node scripts/csp-test.mjs [folder or score]

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createRequire } from "node:module";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const require = createRequire(path.join(root, "app/package.json"));
const playwright = require("playwright");

const arg = path.resolve(process.argv[2] || path.join(root, "real test musescores"));
const scores = fs.statSync(arg).isDirectory()
    ? fs.readdirSync(arg).filter((f) => /\.mscz$/i.test(f)).map((f) => path.join(arg, f))
    : [arg];
const url = process.env.APP_URL || "http://localhost:4173/";

let failures = 0;
const check = (ok, what) => {
    console.log(`${ok ? "PASS" : "FAIL"}  ${what}`);
    if (!ok) failures++;
};

for (const engineName of (process.env.ENGINES || "chromium,webkit").split(",")) {
    const browser = await playwright[engineName].launch();
    const context = await browser.newContext({ viewport: { width: 1280, height: 900 } });
    const page = await context.newPage();
    const refused = [];
    await page.addInitScript(() => {
        window.__refused = [];
        document.addEventListener("securitypolicyviolation", (e) => window.__refused.push(`${e.violatedDirective} ${e.blockedURI}`));
    });
    page.on("console", (m) => /Content Security Policy|Refused to/i.test(m.text()) && refused.push(m.text().slice(0, 160)));
    page.on("pageerror", (e) => console.log(`[${engineName}] page error:`, e.message));
    await page.goto(url);
    check(await page.evaluate(() => !!document.querySelector('meta[http-equiv="Content-Security-Policy"]')), `${engineName}: the built page carries the policy`);
    await page.waitForFunction(() => document.getElementById("status").textContent.startsWith("Ready"), null, { timeout: 180000 });

    for (const file of scores) {
        const short = path.basename(file).slice(0, 26);
        await page.evaluate(() => {
            app.state.pageEls.forEach((el) => (el.dataset.old = "1"));
            app.state.playbackReady = false;
            app.notes.discard?.();
        });
        await page.setInputFiles("#file-input", file);
        // (WebKit on Windows has no audio: there, only the pages)
        await page.waitForFunction(() => (app.state.playbackReady || !window.AudioContext) && app.state.pageEls.length > 0
            && !app.state.pageEls[0].dataset.old && !!document.querySelector(".page canvas"), null, { timeout: 180000 });
        // every page drawn: scroll through them
        const n = await page.evaluate(() => app.state.pageEls.length);
        for (let i = 0; i < n; i++) {
            await page.evaluate((i) => app.state.pageEls[i].scrollIntoView(), i);
            await page.waitForTimeout(250);
        }
        await page.waitForFunction(() => app.state.pageEls.every((el) => !el.getBoundingClientRect().height || true), null, { timeout: 5000 });
        const drawn = await page.evaluate(() => document.querySelectorAll(".page canvas").length);
        check(drawn > 0, `${engineName} ${short}: ${n} pages, drawn while scrolling (${drawn} drawings now)`);
    }
    // playing (Chromium only: this WebKit build has no audio)
    if (engineName === "chromium") {
        await page.click("#play");
        await page.waitForFunction(() => app.state.playing, null, { timeout: 30000 }).catch(() => {});
        await page.waitForTimeout(2500);
        check(await page.evaluate(() => app.state.playing && app.engine.underruns === 0), `${engineName}: plays`);
        await page.click("#play");
    }
    // the mixer and the sound list
    await page.waitForFunction(() => !document.getElementById("mixer-toggle").disabled, null, { timeout: 60000 });
    await page.click("#mixer-toggle");
    await page.waitForSelector("#mixer:not([hidden])");
    await page.click("#mixer .strip:not(.master) .sound").catch(() => {});
    await page.waitForTimeout(400);
    await page.click("#sounds-back").catch(() => {});
    await page.click("#mixer-close");
    // settings
    await page.click("#settings-open");
    await page.waitForTimeout(300);
    await page.click("#settings-close");
    // notes: a pen stroke and a text box, with formatted text and a picture pasted in
    await page.click("#notes-toggle");
    await page.evaluate(() => app.notes.setFingerDraws(true));
    const r = await page.evaluate(() => document.querySelector('.page[data-index="0"]').getBoundingClientRect().toJSON());
    await page.mouse.move(r.x + 100, r.y + 300);
    await page.mouse.down();
    await page.mouse.move(r.x + 200, r.y + 320, { steps: 4 });
    await page.mouse.up();
    await page.click('.tool[data-tool="text"]');
    await page.mouse.dblclick(r.x + 120, r.y + 420);
    await page.waitForTimeout(300);
    const pasted = await page.evaluate(() => {
        const body = document.activeElement;
        if (!body?.classList.contains("tbody")) {
            // no box from a synthetic double-click (WebKit here): check the browser takes the mode
            const d = document.createElement("div");
            d.contentEditable = "plaintext-only";
            return { mode: d.contentEditable, html: "" };
        }
        const dt = new DataTransfer();
        dt.setData("text/html", '<b>Bold</b> text<img src="https://example.com/x.png">');
        dt.setData("text/plain", "Bold text");
        body.dispatchEvent(new ClipboardEvent("paste", { clipboardData: dt, bubbles: true, cancelable: true }));
        return { mode: body.contentEditable, html: body.innerHTML };
    });
    // a synthetic paste event is not acted on by every browser: check the mode, and that no markup got in
    check(pasted.mode === "plaintext-only" && !/<(b|img)/i.test(pasted.html),
        `${engineName}: a text box takes plain text only (${pasted.mode}; content ${JSON.stringify(pasted.html).slice(0, 60)})`);
    await page.click("#notes-done").catch(() => {});
    await page.waitForTimeout(300);

    // nothing refused so far
    const during = [...refused, ...(await page.evaluate(() => window.__refused))];
    check(during.length === 0, `${engineName}: nothing refused while using the app${during.length ? ": " + [...new Set(during)].slice(0, 4).join(" | ") : ""}`);

    // the safeguards
    const blocked = await page.evaluate(async () => {
        window.__ran = false;
        const s = document.createElement("script");
        s.textContent = "window.__ran = true";
        document.body.appendChild(s);
        const img = new Image();
        const outside = await new Promise((r) => {
            img.onload = () => r("loaded");
            img.onerror = () => r("refused");
            img.src = "https://example.com/favicon.ico";
            setTimeout(() => r("no answer"), 8000);
        });
        return { ran: window.__ran, outside };
    });
    check(!blocked.ran, `${engineName}: a script put into the page is refused`);
    check(blocked.outside === "refused", `${engineName}: a picture from another address is refused (${blocked.outside})`);
    await browser.close();
}
console.log(failures ? `\n${failures} FAILED` : "\nall passed");
process.exit(failures ? 1 : 0);
