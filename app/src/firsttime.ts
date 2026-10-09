// Who is new to PocketScore on this device, so help meant for first-timers shows only to them and
// never bothers regular users (issue #16). Decided once, on the first visit: someone who used
// PocketScore before this check existed already has notes, mixer settings or preferences saved, and
// counts as returning. Each piece of first-time help is remembered once it has been seen.
// Per device and per browser: a cleared browser counts as new again, which is harmless because all
// of it can be reached from the ? button too.

const KEY = "pocketscore.seen";

type Seen = { newcomer?: boolean } & Record<string, boolean | undefined>;

function load(): Seen | null {
    try {
        const v = JSON.parse(localStorage.getItem(KEY) || "{}");
        return v && typeof v === "object" ? v : {};
    } catch (err) {
        return null; // storage blocked: treat everyone as returning, so nobody is asked every visit
    }
}

function save() {
    try {
        localStorage.setItem(KEY, JSON.stringify(seen));
    } catch (err) {
        // not kept; asked again next time at worst
    }
}

const stored = load();
const seen: Seen = stored || { newcomer: false };
if (stored && seen.newcomer === undefined) {
    let earlier = false;
    try {
        earlier = Object.keys(localStorage).some((k) => k.startsWith("pocketscore.") && k !== KEY);
    } catch (err) {
        earlier = true;
    }
    seen.newcomer = !earlier;
    save();
}

/** True for someone using PocketScore for the first time on this device (until they've seen the help). */
export function isNewcomer(): boolean {
    return seen.newcomer === true;
}

/** Whether a piece of first-time help (e.g. "tour") has been shown or dismissed. */
export function hasSeen(feature: string): boolean {
    return seen[feature] === true;
}

export function markSeen(feature: string) {
    if (!hasSeen(feature)) {
        seen[feature] = true;
        save();
    }
}
