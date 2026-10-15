// Which tests to run, and their record (the user's rule, 16 Oct 2026): a test that has passed
// SETTLED times in a row is settled, and runs again only when a change since its last pass touches
// its area (scripts/tests.json: its files, or a changed line matching one of its words), or the user
// reports a problem there. A test that isn't settled yet runs every round. The record is
// scripts/test-ledger.json (committed, so both PCs share it).
//
//   node scripts/tests.mjs which              the tests to run now, and why (changes since each one's last pass, uncommitted ones too)
//   node scripts/tests.mjs record <test> pass [note]   a pass (with only its known failures, if any)
//   node scripts/tests.mjs record <test> fail [note]   a failure: it is unsettled until it passes SETTLED times again
//   node scripts/tests.mjs list               every test's state
//   node scripts/tests.mjs run [tests...]     runs them (default: what `which` lists, that can run here) one after
//                                             another, logs to build/regress, and records each result (a run whose
//                                             only failures are the test's known ones counts as a pass)

import fs from "node:fs";
import path from "node:path";
import { execFileSync, spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const SETTLED = 3;
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const areas = JSON.parse(fs.readFileSync(path.join(root, "scripts/tests.json"), "utf8"));
delete areas._about;
const ledgerPath = path.join(root, "scripts/test-ledger.json");
const ledger = fs.existsSync(ledgerPath) ? JSON.parse(fs.readFileSync(ledgerPath, "utf8")) : {};
const git = (...a) => execFileSync("git", a, { cwd: root, encoding: "utf8", maxBuffer: 64 << 20, stdio: ["ignore", "pipe", "ignore"] });
const head = () => git("rev-parse", "--short", "HEAD").trim();

// Files changed since `commit` (committed and not), and the changed lines themselves
function changesSince(commit) {
    const range = commit ? [commit] : ["HEAD"];
    const files = new Set(git("diff", "--name-only", "--ignore-submodules=dirty", ...range).split("\n").filter(Boolean));
    git("ls-files", "--others", "--exclude-standard").split("\n").filter(Boolean).forEach((f) => files.add(f));
    // only the app's and the engine's code counts for words (docs mention them all the time)
    const lines = git("diff", "-U0", "--ignore-submodules=dirty", ...range, "--", "app/src", "app/public", "app/index.html", "app/vite.config.ts", "engine", "patches").split("\n")
        .filter((l) => /^[+-]/.test(l) && !/^(\+\+\+|---)/.test(l)).map((l) => l.slice(1))
        .filter((l) => !/^\s*(\/\/|\/\*|\*|<!--|#)/.test(l)); // comments change nothing
    return { files: [...files], lines };
}

// Why a settled test needs running again, or null
function reason(name, a, since) {
    let ch;
    try {
        ch = changesSince(since);
    } catch {
        return `its last pass (${since}) isn't in this clone's history`;
    }
    // its files, and its own script
    const own = [`scripts/${name}.mjs`, ...(a.files || [])];
    const f = ch.files.find((file) => own.some((p) => file === p || file.startsWith(p)));
    if (f) {
        return `${f} changed`;
    }
    for (const w of a.words || []) {
        const re = new RegExp(w, "i");
        const line = ch.lines.find((l) => re.test(l));
        if (line) {
            return `a changed line mentions /${w}/: ${line.trim().slice(0, 70)}`;
        }
    }
    return null;
}

// Whether a test should run now, and why (null: no need)
function toRun(n) {
    const a = areas[n];
    const e = ledger[n];
    if (a.onlyOnChange) {
        return e?.passCommit ? reason(n, a, e.passCommit) : "never recorded";
    }
    if (!e || e.streak < SETTLED) {
        return e ? `not settled yet (${e.streak} pass${e.streak === 1 ? "" : "es"} in a row${e.last === "fail" ? ", last failed" : ""})` : "never recorded";
    }
    return reason(n, a, e.passCommit);
}

const [cmd, name, result, ...note] = process.argv.slice(2);
if (cmd === "record") {
    if (!areas[name] || !["pass", "fail"].includes(result)) {
        console.error("usage: record <test> pass|fail [note]   tests: " + Object.keys(areas).join(", "));
        process.exit(1);
    }
    const dirty = git("status", "--porcelain", "--untracked-files=no").trim() !== "";
    const e = ledger[name] || { streak: 0 };
    e.streak = result === "pass" ? e.streak + 1 : 0;
    e.last = result;
    e.commit = head() + (dirty ? "+changes" : "");
    if (result === "pass") {
        e.passCommit = head(); // changes since then (uncommitted ones included) decide a rerun
    }
    e.date = new Date().toISOString().slice(0, 10);
    if (note.length) {
        e.note = note.join(" ");
    }
    ledger[name] = e;
    fs.writeFileSync(ledgerPath, JSON.stringify(ledger, null, 2) + "\n");
    console.log(`${name}: ${result}, ${e.streak} in a row${e.streak >= SETTLED ? " (settled)" : ""}`);
} else if (cmd === "run") {
    const names = process.argv.slice(3).length ? process.argv.slice(3) : Object.keys(areas).filter((n) => toRun(n));
    let phone = false;
    try {
        phone = /\tdevice\b/.test(execFileSync("adb", ["devices"], { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }));
    } catch {
        // no adb on PATH: the phone tests are skipped
    }
    fs.mkdirSync(path.join(root, "build/regress"), { recursive: true });
    for (const n of names) {
        const a = areas[n];
        if (!a) {
            console.log(`?     ${n}: not in scripts/tests.json`);
            continue;
        }
        if (a.blocked) {
            console.log(`skip  ${n}: ${a.blocked}`);
            continue;
        }
        if (a.needsPreview && !(await fetch("http://localhost:4173/").then((x) => x.ok, () => false))) {
            console.log(`skip  ${n}: needs a built copy served at :4173 (cd app && npm run build && npx vite preview --host 127.0.0.1 --port 4173)`);
            continue;
        }
        if (a.phone && !phone) {
            console.log(`skip  ${n}: needs the Android phone on USB`);
            continue;
        }
        const t0 = Date.now();
        const r = spawnSync(process.execPath, [path.join(root, "scripts", n + ".mjs"), ...(a.args || [])],
            { cwd: root, encoding: "utf8", maxBuffer: 256 << 20, timeout: 40 * 60 * 1000 });
        const out = (r.stdout || "") + (r.stderr || "");
        fs.writeFileSync(path.join(root, "build/regress", n + ".log"), out);
        const fails = out.split("\n").filter((l) => /^\s*FAIL\b/.test(l));
        const unknown = fails.filter((l) => !(a.known || []).some((k) => l.includes(k)));
        const pass = r.status === 0 || (fails.length > 0 && unknown.length === 0);
        const mins = ((Date.now() - t0) / 60000).toFixed(1);
        execFileSync(process.execPath, [fileURLToPath(import.meta.url), "record", n, pass ? "pass" : "fail"], { cwd: root, stdio: "ignore" });
        console.log(`${pass ? "PASS" : "FAIL"}  ${n} (${mins} min)${fails.length && pass ? `, only its ${fails.length} known failure(s)` : ""}`
            + (pass ? "" : `: ${(unknown[0] || out.trim().split("\n").slice(-1)[0] || "exit " + r.status).trim().slice(0, 140)}`));
    }
} else if (cmd === "which" || cmd === "list") {
    for (const [n, a] of Object.entries(areas)) {
        const e = ledger[n];
        const why = toRun(n);
        if (cmd === "list") {
            console.log(`${n.padEnd(24)} ${e ? `${e.streak} in a row, last ${e.last} ${e.date}` : "no record"}${e?.note ? `  [${e.note}]` : ""}`);
        } else if (why) {
            console.log(`RUN   ${n.padEnd(24)} ${why}${a.phone ? "  (phone on USB)" : ""}${a.blocked ? `  (blocked: ${a.blocked})` : ""}`);
        }
    }
    if (cmd === "which") {
        const skip = Object.keys(areas).filter((n) => !toRun(n));
        if (skip.length) {
            console.log(`skip  ${skip.join(", ")} (settled, nothing in their area changed)`);
        }
    }
} else {
    console.error("usage: node scripts/tests.mjs which | list | record <test> pass|fail [note]");
    process.exit(1);
}
