// AudioWorklet that plays the audio MuseScore's engine renders ahead in a
// Web Worker (msaudio-worker.js). It only copies from its queue, so it never
// misses its deadline because of the engine.
//
// Messages on this.port (from the page):
//   {type:"init", inPort}    inPort carries audio from the engine worker
//   {type:"flush"}           drop queued audio (seek, pause, stop)
// To the page: {type:"queued", frames, underruns} about every 100 ms.

class MsAudioPlayer extends AudioWorkletProcessor {
    constructor() {
        super();
        this.queue = []; // Float32Array chunks, interleaved stereo
        this.readPos = 0; // frames read from queue[0]
        this.queuedFrames = 0;
        this.consumed = 0; // frames played since the last report to the worker
        this.underruns = 0;
        this.starved = false;
        this.sinceReport = 0;
        this.in = null;
        this.port.onmessage = (e) => this.onMessage(e.data);
    }

    onMessage(msg) {
        if (msg.type === "init") {
            this.in = msg.inPort;
            this.in.onmessage = (e) => {
                if (e.data.type === "audio") {
                    this.queue.push(e.data.data);
                    this.queuedFrames += e.data.data.length / 2;
                }
            };
        } else if (msg.type === "flush") {
            this.queue = [];
            this.readPos = 0;
            this.queuedFrames = 0;
            this.consumed = 0;
            if (this.in) {
                this.in.postMessage({ type: "flush" });
            }
        }
    }

    process(inputs, outputs) {
        const out = outputs[0];
        const left = out[0];
        const right = out[1] || out[0];
        const frames = left.length;

        let i = 0;
        while (i < frames && this.queue.length) {
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

        const played = Math.min(frames, this.queuedFrames);
        this.queuedFrames -= played;
        this.consumed += played;

        if (this.in) {
            // an empty queue while the engine is running means the device fell behind
            const empty = this.queuedFrames === 0;
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
