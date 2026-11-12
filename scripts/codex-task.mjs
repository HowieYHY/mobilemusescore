// Hands one well-scoped task to the Codex CLI (`codex exec`) and prints its final answer. Claude stays the
// lead: it writes the task, reviews what comes back and integrates it (CLAUDE.md, "Delegating to Codex").
//
//   node scripts/codex-task.mjs <task.md>                    read-only: Codex may read and run, not change files
//   node scripts/codex-task.mjs <task.md> --write            may change files in this folder (never commits)
//   node scripts/codex-task.mjs <task.md> --write --dir <worktree>   in another Git worktree, for work in parallel
//   node scripts/codex-task.mjs <task.md> --out <file>       where the final answer is written (default: build/codex/<task>.out.md)
//
// The task file says: the objective, the files that matter, what must not change, and how to tell it is done.
// Codex's own running log goes to build/codex/<task>.log; only its final message is printed here.
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const args = process.argv.slice(2);
const valueOf = (flag) => (args.includes(flag) ? args[args.indexOf(flag) + 1] : undefined);
const task = args.find((a, i) => !a.startsWith("--") && !["--dir", "--out"].includes(args[i - 1]));
if (!task || !fs.existsSync(task)) {
    console.error("usage: node scripts/codex-task.mjs <task.md> [--write] [--dir <worktree>] [--out <file>]");
    process.exit(2);
}
const write = args.includes("--write");
const dir = path.resolve(valueOf("--dir") ?? root);
const logs = path.join(root, "build/codex");
fs.mkdirSync(logs, { recursive: true });
const name = path.basename(task).replace(/\.[^.]+$/, "");
const out = path.resolve(valueOf("--out") ?? path.join(logs, name + ".out.md"));
fs.rmSync(out, { force: true });

const rules = [
    "You are working for another agent that will review your work. Rules for this task:",
    write
        ? "- You may change files inside the working folder only. Do not commit, push, publish, install global packages or touch third_party/."
        : "- Read-only: do not change, create or delete any file.",
    "- Do not use a phone or any device over adb, and do not open network services other than what the task names.",
    "- Read AGENTS.md first.",
    "- End with a short summary: what you changed (files), what you checked and its result, and anything that blocked you.",
    "",
    "The task:",
    "",
].join("\n");

// one command line (codex is a .cmd on Windows, which needs the shell); the task itself goes in on stdin
const res = spawnSync(`codex exec --sandbox ${write ? "workspace-write" : "read-only"} --cd "${dir}" --color never --output-last-message "${out}" -`, {
    input: rules + fs.readFileSync(task, "utf8"),
    encoding: "utf8",
    shell: true,
    maxBuffer: 1 << 28,
    timeout: Number(process.env.CODEX_TIMEOUT_MS || 30 * 60 * 1000),
});
fs.writeFileSync(path.join(logs, name + ".log"), (res.stdout || "") + "\n--- stderr ---\n" + (res.stderr || ""));
if (res.error || res.status !== 0 || !fs.existsSync(out)) {
    console.error(`codex did not finish (exit ${res.status}${res.error ? ", " + res.error.message : ""}). Log: ${path.join(logs, name + ".log")}`);
    console.error((res.stderr || "").split("\n").slice(-12).join("\n"));
    process.exit(1);
}
console.log(fs.readFileSync(out, "utf8").trim());
console.log(`\n(sandbox: ${write ? "workspace-write" : "read-only"}, folder: ${dir}, answer kept in ${path.relative(root, out)})`);
