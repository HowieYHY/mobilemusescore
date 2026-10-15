// The reader's settings (the gear in the top bar): one set for the whole app, kept on this device.
// Every default is how PocketScore behaved before there were settings. A preview inside the Reso
// website keeps nothing on the device, so it always uses the defaults.

export type StartView = "page" | "page_turn" | "continuous_h" | "continuous_v";

export interface Settings {
    keepPlaying: boolean;      // music goes on when the app is left
    metronomeOn: boolean;      // metronome unmuted when a score opens
    tapToHear: boolean;        // a tap on a note sounds it while stopped
    autoFocus: boolean;        // focus starts by itself when the screen is left alone
    focusPlayingSecs: number;  // … after this long while playing
    focusStoppedSecs: number;  // … and this long while stopped
    focusFullscreen: boolean;  // the Focus button also goes full screen
    startView: StartView;      // the view a score opens in
    follow: boolean;           // the view follows the music
    earlyTurn: boolean;        // page by page: the next page comes up on a page's last line
    keepAwake: boolean;        // the screen stays on while playing
}

export const DEFAULTS: Readonly<Settings> = {
    keepPlaying: false,
    metronomeOn: false,
    tapToHear: true,
    autoFocus: true,
    focusPlayingSecs: 4,
    focusStoppedSecs: 10,
    focusFullscreen: true,
    startView: "page",
    follow: true,
    earlyTurn: false,
    keepAwake: false,
};

const KEY = "pocketscore.settings";

// Only known keys, each of its default's type; anything else (an older or newer version's) is ignored
function sanitize(raw: unknown): Settings {
    const s: Settings = { ...DEFAULTS };
    if (raw && typeof raw === "object") {
        for (const k of Object.keys(DEFAULTS) as (keyof Settings)[]) {
            const v = (raw as Record<string, unknown>)[k];
            if (typeof v === typeof DEFAULTS[k]) {
                (s as any)[k] = v;
            }
        }
    }
    if (!["page", "page_turn", "continuous_h", "continuous_v"].includes(s.startView)) {
        s.startView = DEFAULTS.startView;
    }
    return s;
}

export function loadSettings(keep: boolean): Settings {
    if (!keep) {
        return { ...DEFAULTS };
    }
    try {
        return sanitize(JSON.parse(localStorage.getItem(KEY) || "null"));
    } catch {
        return { ...DEFAULTS };
    }
}

export function saveSettings(s: Settings, keep: boolean) {
    if (!keep) {
        return;
    }
    try {
        localStorage.setItem(KEY, JSON.stringify(s));
    } catch {
        // storage full or blocked: the settings still apply until the app closes
    }
}
