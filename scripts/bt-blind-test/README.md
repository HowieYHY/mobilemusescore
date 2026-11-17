# Bluetooth blind tests (tone pages)

Two pages for listening over a real Bluetooth device, no PocketScore involved. Each plays a steady tone
(440 Hz with a slow pulse) in 30 s segments, in random order, hides which variant is playing, and asks the
listener to rate each as clean / slight / bad. The ratings stay in `window.__results` (read them over
DevTools afterwards). Serve the folder and open the page on the phone:

    cd scripts/bt-blind-test && python -m http.server 4174 --bind 127.0.0.1
    adb reverse tcp:4174 tcp:4174
    adb shell am start -a android.intent.action.VIEW -d http://localhost:4174/tones-2.html com.android.chrome

- `tones-1.html`: Web Audio buffer loop (playback / interactive / 44.1 kHz), AudioWorklet (playback /
  interactive), Web Audio into an `<audio>` element, a plain `<audio>` WAV. 2 rounds of 7.
- `tones-2.html`: the buffer loop (control), a worklet that computes the tone, a worklet that only copies from
  memory (playback / interactive), and chunked buffers scheduled ahead. 3 rounds of 5.

Results of 17-18 Nov 2026 (Pixel 9a, AirPods, AAC): see docs/DEVELOPMENT.md, *Bluetooth crackle*.
