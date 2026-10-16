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

// Chrome opens its DevTools socket only once it is in front: with Chrome in the background the tab
// list failed with "other side closed" (17 Oct 2026). Brings it forward (its last tab, no new one)
// and forwards the socket to localPort.
export async function chromeDevtools(localPort) {
    adb("shell", "am", "start", "-n", "com.android.chrome/com.google.android.apps.chrome.Main");
    for (let i = 0; i < 30 && !adb("shell", "cat", "/proc/net/unix").toString().includes("@chrome_devtools_remote"); i++) {
        await new Promise((r) => setTimeout(r, 500));
    }
    adb("forward", `tcp:${localPort}`, "localabstract:chrome_devtools_remote");
}
