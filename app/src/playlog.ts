// The playback log (issue #31): what happened while music played, kept on this device so a stutter
// seen away from a computer can still be looked into later. The reader sends it from Settings
// (Send playback report); nothing leaves the device otherwise. It holds no notes or score files,
// only scores' names, timings and the device's own figures. A preview inside the Reso website
// keeps nothing.

export interface LogEntry {
    t: number; // Date.now()
    kind: string;
    detail: string;
}

const KEY = "pocketscore.playlog";
const MAX_ENTRIES = 600;
// a GitHub comment holds up to 65536 characters; the report stays under it
const MAX_REPORT_CHARS = 60000;

function pad(n: number, w = 2) {
    return String(n).padStart(w, "0");
}

/** Local date and time to the millisecond (the reader remembers when it happened in local time). */
export function stamp(t: number) {
    const d = new Date(t);
    return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}.${pad(d.getMilliseconds(), 3)}`;
}

export class PlayLog {
    entries: LogEntry[] = [];
    private saveTimer = 0;

    constructor(private keep: boolean) {
        if (keep) {
            try {
                const raw = JSON.parse(localStorage.getItem(KEY) || "[]");
                if (Array.isArray(raw)) {
                    this.entries = raw.filter((e) => e && typeof e.t === "number" && typeof e.kind === "string" && typeof e.detail === "string");
                }
            } catch {
                // unreadable: start a new log
            }
        }
    }

    add(kind: string, detail: string) {
        this.entries.push({ t: Date.now(), kind, detail });
        if (this.entries.length > MAX_ENTRIES) {
            this.entries.splice(0, this.entries.length - MAX_ENTRIES);
        }
        // written soon, not at every entry; at once when the app is left (it may be closed there)
        if (this.keep && !this.saveTimer) {
            this.saveTimer = window.setTimeout(() => this.save(), 2000);
        }
    }

    save() {
        clearTimeout(this.saveTimer);
        this.saveTimer = 0;
        if (!this.keep) {
            return;
        }
        try {
            localStorage.setItem(KEY, JSON.stringify(this.entries));
        } catch {
            // storage full or blocked: the log still holds this session
        }
    }

    /** The report as plain text: the header, a count per kind, then the entries, newest last. */
    report(header: string[]): string {
        const counts = new Map<string, number>();
        for (const e of this.entries) {
            counts.set(e.kind, (counts.get(e.kind) || 0) + 1);
        }
        const head = [
            ...header,
            `Log: ${this.entries.length} entries` + (this.entries.length ? ` from ${stamp(this.entries[0].t)} to ${stamp(this.entries[this.entries.length - 1].t)}` : ""),
            "Counts: " + ([...counts].map(([k, n]) => `${k} ${n}`).join(", ") || "none"),
            "",
        ].join("\n");
        const lines = this.entries.map((e) => `${stamp(e.t)}  ${e.kind}: ${e.detail}`);
        // too long for one comment: the oldest entries go
        let size = head.length;
        let first = lines.length;
        while (first > 0 && size + lines[first - 1].length + 1 < MAX_REPORT_CHARS) {
            first--;
            size += lines[first].length + 1;
        }
        return head + (first ? `(${first} older entries left out)\n` : "") + lines.slice(first).join("\n") + "\n";
    }

    clear() {
        this.entries = [];
        this.save();
    }
}
