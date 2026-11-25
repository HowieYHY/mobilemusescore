// The owner's hidden screen: the numbers from the usage counter (tracker/worker.js). It is opened by
// tapping the version line on the start screen seven times, and asks for the owner's key, which the
// counter checks; the key is not in the app, so anyone else who finds this screen sees only the box.
// The key is kept on this device only (the owner's), and can be forgotten from the screen.

import { USAGE_URL } from "./usage";

const KEY = "pocketscore.owner";

interface Stats {
    now: number; today: string; tzOffsetHours: number;
    total: { installs: number; sessions: number; hours: number; since: number | null };
    active: { today: number; d7: number; d30: number };
    session: { avgSecs: number; medianSecs: number; avgPlaySecs: number; n: number };
    frequency: Record<string, number>;
    versions: Record<string, number>;
    modes: Record<string, number>;
    daily: { day: string; users: number; newUsers: number; sessions: number; secs: number; play: number }[];
    truncated: boolean;
}

function el<K extends keyof HTMLElementTagNameMap>(tag: K, cls?: string, text?: string): HTMLElementTagNameMap[K] {
    const e = document.createElement(tag);
    if (cls) {
        e.className = cls;
    }
    if (text !== undefined) {
        e.textContent = text; // always text, never HTML
    }
    return e;
}

export function fmtDuration(secs: number): string {
    const s = Math.round(secs);
    if (s < 60) {
        return s + " s";
    }
    const m = Math.round(s / 60);
    return m < 60 ? m + " min" : Math.floor(m / 60) + " h " + String(m % 60).padStart(2, "0") + " min";
}

function stat(label: string, value: string, note?: string): HTMLElement {
    const d = el("div", "ou-stat");
    d.append(el("span", "ou-num", value), el("span", "ou-label", label));
    if (note) {
        d.append(el("span", "ou-note", note));
    }
    return d;
}

function table(title: string, data: Record<string, number>, total?: number): HTMLElement {
    const sec = el("div", "ou-block");
    sec.append(el("h3", undefined, title));
    const entries = Object.entries(data);
    if (!entries.length) {
        sec.append(el("p", "ou-note", "Nothing yet."));
    }
    const sum = total ?? entries.reduce((a, [, n]) => a + n, 0);
    for (const [k, n] of entries.sort((a, b) => b[1] - a[1])) {
        const row = el("div", "ou-row");
        row.append(el("span", undefined, k), el("span", "ou-n", n + (sum ? " (" + Math.round(n / sum * 100) + "%)" : "")));
        sec.append(row);
    }
    return sec;
}

function render(into: HTMLElement, s: Stats) {
    into.replaceChildren();
    const grid = el("div", "ou-grid");
    grid.append(
        stat("people so far", String(s.total.installs), s.total.since ? "since " + new Date(s.total.since).toLocaleDateString() : undefined),
        stat("used it today", String(s.active.today)),
        stat("in 7 days", String(s.active.d7)),
        stat("in 30 days", String(s.active.d30)),
        stat("average visit", fmtDuration(s.session.avgSecs), "median " + fmtDuration(s.session.medianSecs)),
        stat("playing per visit", fmtDuration(s.session.avgPlaySecs), "last 30 days"),
        stat("visits so far", String(s.total.sessions)),
        stat("hours so far", s.total.hours.toFixed(1)),
    );
    into.append(grid);

    const days = el("div", "ou-block");
    days.append(el("h3", undefined, "Each day, last 30 days"));
    const max = Math.max(1, ...s.daily.map((d) => d.users));
    for (const d of [...s.daily].reverse()) {
        const row = el("div", "ou-day");
        const bar = el("span", "ou-bar");
        bar.style.width = Math.round(d.users / max * 100) + "%";
        const track = el("span", "ou-track");
        track.append(bar);
        const avg = d.sessions ? fmtDuration(d.secs / d.sessions) : "-";
        row.append(
            el("span", "ou-date", d.day.slice(5)),
            track,
            el("span", "ou-n", `${d.users} people${d.newUsers ? ` (${d.newUsers} new)` : ""}, ${d.sessions} visits, avg ${avg}`),
        );
        days.append(row);
    }
    into.append(days);
    into.append(table("How often people came back (days used in 30 days)", s.frequency));
    into.append(table("Version last used (30 days)", s.versions));
    into.append(table("Installed app or browser tab (30 days)", s.modes));
    into.append(el("p", "ou-note", `Days start at UTC+${s.tzOffsetHours}. A person is one install on one device, so someone with two devices counts twice, and someone who clears their browser data counts again.` + (s.truncated ? " Over 60,000 visits in 90 days: the older ones are left out of the daily figures." : "")));
}

/** Opens the owner's screen in `dlg` (a <dialog>). Does nothing if no counter was built in. */
export function openOwnerScreen(dlg: HTMLDialogElement) {
    if (!USAGE_URL) {
        return;
    }
    const body = dlg.querySelector<HTMLElement>(".ou-body")!;
    const msg = dlg.querySelector<HTMLElement>(".ou-msg")!;
    const keyBox = dlg.querySelector<HTMLInputElement>(".ou-key")!;
    const keyRow = dlg.querySelector<HTMLElement>(".ou-keyrow")!;
    const refresh = dlg.querySelector<HTMLButtonElement>(".ou-refresh")!;
    const forget = dlg.querySelector<HTMLButtonElement>(".ou-forget")!;
    let saved = "";
    try {
        saved = localStorage.getItem(KEY) || "";
    } catch { /* the key then has to be typed each time */ }

    async function load(key: string) {
        msg.textContent = "Loading…";
        body.replaceChildren();
        try {
            const res = await fetch(USAGE_URL + "/stats", { headers: { authorization: "Bearer " + key }, cache: "no-store" });
            if (res.status === 401) {
                msg.textContent = "That key was not accepted.";
                keyRow.hidden = false;
                forget.hidden = true;
                try {
                    localStorage.removeItem(KEY);
                } catch { /* nothing to remove */ }
                return;
            }
            if (!res.ok) {
                throw new Error(String(res.status));
            }
            const stats = (await res.json()) as Stats;
            try {
                localStorage.setItem(KEY, key);
            } catch { /* typed again next time */ }
            msg.textContent = "Updated " + new Date().toLocaleTimeString();
            keyRow.hidden = true;
            forget.hidden = false;
            refresh.hidden = false;
            render(body, stats);
        } catch {
            msg.textContent = "Couldn't reach the counter. Check the connection and try again.";
        }
    }

    keyBox.value = "";
    keyRow.hidden = !!saved;
    forget.hidden = !saved;
    refresh.hidden = !saved;
    msg.textContent = saved ? "" : "Enter your key.";
    body.replaceChildren();
    dlg.querySelector<HTMLButtonElement>(".ou-go")!.onclick = () => {
        if (keyBox.value.trim()) {
            void load(keyBox.value.trim());
        }
    };
    keyBox.onkeydown = (e) => {
        if (e.key === "Enter") {
            dlg.querySelector<HTMLButtonElement>(".ou-go")!.click();
        }
    };
    refresh.onclick = () => {
        const k = saved || keyBox.value.trim();
        try {
            void load(localStorage.getItem(KEY) || k);
        } catch {
            void load(k);
        }
    };
    forget.onclick = () => {
        try {
            localStorage.removeItem(KEY);
        } catch { /* nothing to remove */ }
        saved = "";
        body.replaceChildren();
        keyRow.hidden = false;
        forget.hidden = true;
        refresh.hidden = true;
        msg.textContent = "Key forgotten on this device.";
    };
    dlg.querySelector<HTMLButtonElement>(".ou-close")!.onclick = () => dlg.close();
    dlg.showModal();
    if (saved) {
        void load(saved);
    }
}
