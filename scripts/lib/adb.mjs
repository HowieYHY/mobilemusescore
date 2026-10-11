// adb for the Android test scripts: ADB if set, else where each of the user's
// PCs keeps it, else whatever is on PATH.

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";

export const adbPath = process.env.ADB || [
    "D:/tools/platform-tools/adb.exe", // the first PC
    path.join(os.homedir(), "tools/android-sdk/platform-tools/adb.exe"), // the second PC
].find((p) => fs.existsSync(p)) || "adb";

export const adb = (...args) => execFileSync(adbPath, args, { maxBuffer: 64 << 20 });
