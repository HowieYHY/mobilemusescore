// AudioWorklet that plays the audio MuseScore's engine renders ahead in a
// Web Worker (msaudio-worker.js). It only copies from its queue, so it never
// misses its deadline because of the engine.
//
// Messages on this.port (from the page):
//   {type:"init", inPort}    inPort carries audio from the engine worker
//   {type:"flush"}           drop queued audio (seek, pause, stop); audio the
//                            worker rendered before it hears of the flush
//                            carries the old generation and is dropped too
// To the page: {type:"queued", frames, underruns} about every 100 ms.

// Audio wanted before the music resumes after a flush (a jump while playing):
// six of the worker's blocks (~128 ms). The first blocks after a jump take
// longest to render (every note at the new place starts); two still ran dry on
// a Pixel 9a. Only while playing (the playing queue is 16-48 blocks): stopped,
// a tapped note sounds at once and a gap there is not heard as a stutter.
const PRIME_FRAMES = 6 * 1024;

class MsAudioPlayer extends AudioWorkletProcessor {
    constructor() {
        super();
        this.queue = []; // Float32Array chunks, interleaved stereo
        this.readPos = 0; // frames read from queue[0]
        this.queuedFrames = 0;
        this.consumed = 0; // frames played since the last report to the worker
        this.underruns = 0;
        this.starved = false;
        this.priming = false;
        this.enginePlaying = false;
        this.sinceReport = 0;
        this.gen = 0;
        this.in = null;
        this.port.onmessage = (e) => this.onMessage(e.data);
    }

    onMessage(msg) {
        if (msg.type === "init") {
            this.in = msg.inPort;
            this.in.onmessage = (e) => {
                if (e.data.type === "audio" && e.data.gen === this.gen) {
                    this.enginePlaying = e.data.playing;
                    this.queue.push(e.data.data);
                    this.queuedFrames += e.data.data.length / 2;
                }
            };
        } else if (msg.type === "flush") {
            this.queue = [];
            this.readPos = 0;
            this.queuedFrames = 0;
            this.consumed = 0;
            this.gen++;
            this.priming = true;
            if (this.in) {
                this.in.postMessage({ type: "flush", gen: this.gen });
            }
        }
    }

    process(inputs, outputs) {
        const out = outputs[0];
        const left = out[0];
        const right = out[1] || out[0];
        const frames = left.length;

        // After a flush (a jump while playing), wait for a little audio before
        // playing again: playing the first fresh chunk at once ran dry a moment
        // later (heard as a hiccup, and counted as the device falling behind)
        if (this.priming && (this.queuedFrames >= PRIME_FRAMES || !this.enginePlaying)) {
            this.priming = false;
        }

        let i = 0;
        while (i < frames && this.queue.length && !this.priming) {
            const chunk = this.queue[0];
            const chunkFrames = chunk.length / 2;
            const n = Math.min(frames - i, chunkFrames - this.readPos);
            for (let k = 0; k < n; k++) {
                left[i + k] = chunk[(this.readPos + k) * 2];
                right[i + k] = chunk[(this.readPos + k) * 2 + 1];
            }
            i += n;
            this.readPos += n;
            if (this.readPos >= chunkFrames) {
                this.queue.shift();
                this.readPos = 0;
            }
        }
        for (; i < frames; i++) {
            left[i] = 0;
            right[i] = 0;
        }

        const played = this.priming ? 0 : Math.min(frames, this.queuedFrames);
        this.queuedFrames -= played;
        this.consumed += played;

        if (this.in) {
            // an empty queue while the engine is running means the device fell behind
            const empty = this.queuedFrames === 0 && !this.priming;
            if (empty && !this.starved && this.consumed > 0) {
                this.underruns++;
                this.in.postMessage({ type: "underrun" });
            }
            this.starved = empty;

            if (this.consumed >= 1024) {
                this.in.postMessage({ type: "consumed", frames: this.consumed });
                this.consumed = 0;
            }
        }

        this.sinceReport += frames;
        if (this.sinceReport >= sampleRate / 10) {
            this.sinceReport = 0;
            this.port.postMessage({ type: "queued", frames: this.queuedFrames, underruns: this.underruns });
        }
        return true;
    }
}

registerProcessor("msaudio", MsAudioPlayer);
