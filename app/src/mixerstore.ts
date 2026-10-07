// Mixer settings kept on this device, per score: the ones the reader saved,
// and a draft of changes not saved yet (so they can be offered back after the
// app was closed without saving). The .mscz itself is never changed.

import type { TrackInfo } from "./engine/protocol";

export interface PartMix { volume: number; mute: boolean; solo: boolean; reverb: number; soundId: string }
export interface Mix { master: number; parts: Record<string, PartMix> }

const SAVED = "pocketscore.mixer.";
const DRAFT = "pocketscore.mixerDraft.";
const OLD_SOUNDS = "pocketscore.sounds."; // 0.2.0 kept only sound choices

/** A part is known by its place and name, which stay the same for a file. */
export const slot = (t: TrackInfo) => `${t.key}:${t.title}`;

export function mixOf(tracks: TrackInfo[], masterDb: number): Mix {
    const parts: Record<string, PartMix> = {};
    for (const t of tracks) {
        parts[slot(t)] = { volume: t.volume, mute: t.mute, solo: t.solo, reverb: t.reverb, soundId: t.soundId };
    }
    return { master: masterDb, parts };
}

export function sameMix(a: Mix, b: Mix): boolean {
    if (Math.abs(a.master - b.master) > 0.05) {
        return false;
    }
    const keys = new Set([...Object.keys(a.parts), ...Object.keys(b.parts)]);
    for (const k of keys) {
        const p = a.parts[k];
        const q = b.parts[k];
        if (!p || !q) {
            return false;
        }
        if (Math.abs(p.volume - q.volume) > 0.05 || Math.abs(p.reverb - q.reverb) > 0.005
            || p.mute !== q.mute || p.solo !== q.solo || p.soundId !== q.soundId) {
            return false;
        }
    }
    return true;
}

function read(key: string): Mix | null {
    try {
        const m = JSON.parse(localStorage.getItem(key) || "null");
        return m && typeof m.master === "number" && m.parts && typeof m.parts === "object" ? m : null;
    } catch (err) {
        return null;
    }
}

/** Returns false when storage is full or blocked. */
function write(key: string, m: Mix | null): boolean {
    try {
        if (m) {
            localStorage.setItem(key, JSON.stringify(m));
        } else {
            localStorage.removeItem(key);
        }
        return true;
    } catch (err) {
        return false;
    }
}

export class MixStore {
    constructor(private scoreKey: string) {}

    /** The reader's saved settings; `score` is the score's own, to upgrade 0.2.0's sound choices. */
    saved(score: Mix): Mix | null {
        const m = read(SAVED + this.scoreKey);
        if (m) {
            return m;
        }
        try {
            const old = JSON.parse(localStorage.getItem(OLD_SOUNDS + this.scoreKey) || "null");
            if (old && typeof old === "object") {
                const up: Mix = JSON.parse(JSON.stringify(score));
                for (const [k, id] of Object.entries(old)) {
                    if (up.parts[k] && typeof id === "string") {
                        up.parts[k].soundId = id;
                    }
                }
                write(SAVED + this.scoreKey, up);
                localStorage.removeItem(OLD_SOUNDS + this.scoreKey);
                return up;
            }
        } catch (err) {
            // nothing to upgrade
        }
        return null;
    }

    save(m: Mix | null): boolean {
        return write(SAVED + this.scoreKey, m) && write(DRAFT + this.scoreKey, null);
    }

    draft(): Mix | null {
        return read(DRAFT + this.scoreKey);
    }

    setDraft(m: Mix | null) {
        write(DRAFT + this.scoreKey, m);
    }
}
