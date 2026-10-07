// Messages between the page and the score engine worker.

type Req<T> = T & { id: number };

export type WorkerRequest =
    | Req<{ cmd: "init"; base: string; rpcPort: MessagePort }>
    | Req<{ cmd: "startAudio"; sampleRate: number; blockSize: number; soundFontUri: string }>
    | Req<{ cmd: "load"; name: string; data: ArrayBuffer }>
    | Req<{ cmd: "viewMode"; mode: ViewMode }>
    | Req<{ cmd: "page"; index: number }>
    | Req<{ cmd: "cursor"; secs: number }>
    | Req<{ cmd: "tracks" }>
    | Req<{ cmd: "timeline" }>
    | Req<{ cmd: "play" | "pause" | "stop" }>
    | Req<{ cmd: "seek"; secs: number }>
    | Req<{ cmd: "seekAt"; page: number; x: number; y: number; radius: number; playNote: boolean }>
    | Req<{ cmd: "volume"; key: number; db: number }>
    | Req<{ cmd: "balance"; key: number; value: number }>
    | Req<{ cmd: "mute" | "solo"; key: number; on: boolean }>
    | Req<{ cmd: "reverb"; key: number; amount: number }>
    | Req<{ cmd: "sound"; key: number; soundId: string }>
    | Req<{ cmd: "sounds" }>
    | Req<{ cmd: "masterVolume"; db: number }>
    | Req<{ cmd: "latency"; secs: number }>
    | Req<{ cmd: "metronome"; on: boolean }>;

export type WorkerReply =
    | { type: "reply"; id: number; result?: unknown; error?: string }
    | { type: "event"; event: string; data: any }
    | { type: "log"; text: string };

export type ViewMode = "page" | "continuous_h" | "continuous_v";

export interface PageInfo { w: number; h: number }

export interface TrackInfo {
    key: number;
    title: string;
    metronome: boolean;
    chords: boolean;
    hidden: boolean;
    ready: boolean;
    volume: number;
    balance: number;
    reverb: number;
    mute: boolean;
    solo: boolean;
    forceMute: boolean;
    sound: string;
    soundId: string;
    scoreSoundId: string; // the sound the score set (to show which one that was)
    note: string;
}

/** MS Basic's sounds, grouped as in desktop MuseScore's mixer menu. */
export type SoundNode = { t: string; c: SoundNode[] } | { id: string; n: string };
export interface SoundList { auto: string; tree: SoundNode[] }

export interface ScoreInfo {
    title: string;
    composer: string;
    mscVersion: number;
    createdWith: string;
    duration: number;
    spatium: number;
    pages: PageInfo[];
    hasAudioSettings: boolean;
    tracks: TrackInfo[];
}

export interface CursorInfo {
    secs: number;
    duration: number;
    tick?: number;
    measure?: number;
    page?: number;
    x?: number;
    y?: number;
    w?: number;
    h?: number;
    note?: boolean; // seekAt: a note was found at the point
}
