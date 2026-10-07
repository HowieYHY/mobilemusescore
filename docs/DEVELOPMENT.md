# PocketScore: developer notes

Internal documentation: architecture, MuseScore code used, build, tests and
fidelity results. The user guide is the [README](../README.md).

A score **viewer and player** for `.mscz` files on Android phones, iPhones and
iPads. It is not a notation editor.

It plays scores **the way desktop MuseScore Studio 4.7.5 does**, because it
runs MuseScore 4.7.5's own C++ code compiled to WebAssembly:
- its file reader
- its layout engine
- its playback model (repeats, tempo, dynamics, articulations)
- its audio engine (FluidSynth with the **MS Basic** sound font, its mixer and reverb)

**Try it: https://howieyhy.github.io/mobilemusescore/** (on iPad: Safari →
Share → *Add to Home Screen*, then open it once online so it can work offline).

> PocketScore plays files made with MuseScore. "MuseScore" is a trademark of
> MuseScore Ltd; PocketScore is not affiliated with or endorsed by MuseScore Ltd.
> Android app ID: `io.github.howieyhy.pocketscore`.

## Current status (7 Oct 2026)

**Working prototype.** It runs in browsers (Chromium and WebKit) and in an
Android emulator. It has **not yet run on a physical phone or tablet**.

### What works

| Feature | Notes |
| --- | --- |
| Open a local `.mscz` / `.mscx` | Through the file picker. MuseScore 2.x to 4.7 files tested. |
| Score display | MuseScore's layout. Page counts of all five test scores match desktop 4.7.5, and page 1 of "I am move it" matches its saved thumbnail. Pictures (PNG, JPEG, GIF, BMP) are drawn. |
| Zoom and scroll | Opens fitted to the screen width. Zoom with − / + or pinch. |
| View modes | Page (default); Continuous vertical and horizontal. |
| Play, pause, back to start | MuseScore's audio engine in an AudioWorklet. |
| Seek | Position slider, or **tap a note or rest** to play from there. Repeats are respected. |
| Playback cursor | Follows playback across pages and pauses following while you scroll. |
| Mixer | Master volume, plus per-part volume, mute, solo and reverb send. Same solo/mute rules as desktop. Each part's saved sound, volume and mute/solo are read from the score. |
| Metronome | Engine switch, matching desktop's transport metronome (no button in the app yet). |
| Offline | After the first visit, the web app opens and plays scores with no network. The Android app is offline by design. |
| Android app | Capacitor wrapper. The debug APK builds and runs on an Android 16 emulator. |

### Sound compared with desktop

Each of your five scores was rendered by **your installed MuseScore 4.7.5**
(command line, lossless WAV) and by this player. The two were then aligned and
compared, at 48 kHz with the metronome on, as on your desktop:

| Score | Level difference | Loudness over time (1 = same) | Spectrum (1 = same) | Timing |
| --- | --- | --- | --- | --- |
| Cheap Thrills | −0.1 dB | 0.998 | 0.986 | same length, no drift |
| I am move it | +0.3 dB | 0.993 | 0.993 | same length, no drift |
| Let It Snow | 0.0 dB | 0.921 | 0.970 | same length, no drift |
| Make me wanna smoke | 0.0 dB | 0.998 | 0.999 | same length, no drift |
| Valerie | −0.1 dB | 0.950 | 0.981 | same length, no drift |

- **The same notes, sounds, dynamics and tempo.** The level stays within ±1 dB in every half second. The remaining differences are millisecond-scale note timing: desktop's export processes audio in blocks of about 21 ms, this player in blocks of under 3 ms.
- **Your command-line references match your GUI MP3 exports** (0.4 dB difference, spectrum 0.99), so they are a sound yardstick.
- **The engine version matters.** MuseScore 5.0's development engine played everything 2.1 dB louder and shaped dynamics differently, which is why the app now builds from 4.7.5.

Your desktop has the **metronome switched on**, so all your exports include the
click. "Make me wanna smoke" is saved with every part muted, so it plays only
the click, here as on desktop.

`scripts/compare-audio.mjs` repeats this comparison for any score with an
exported audio file.

### Tests

| Check | Where | Result |
| --- | --- | --- |
| Engine test on your 5 scores (load, draw, play, mute all = silence, solo, master volume, seek) | Node.js | 5/5 pass |
| Sound vs desktop 4.7.5 (table above) | Node.js + Chromium decoder | matches |
| Page counts vs desktop 4.7.5 | desktop `--score-meta` | 5/5 identical |
| Browser test on "I am move it": open, all 22 pages drawn, play, audio clock vs position (8.00 s vs 8.01 s), solo, seek, tap-to-seek | Chromium | pass |
| Same test | WebKit (Safari engine) on Windows | display passes; **audio not testable** in this build |
| Offline: cache, cut network, reload, open, play | Chromium, local build **and the live GitHub Pages site** | pass |
| Android: open, play, audio clock vs position (8.05 s vs 8.12 s), mute, seek | Android 16 emulator | pass (on a cold-booted emulator playback lagged until the emulator settled; worth watching on slower phones) |
| iPad (A16, iPadOS 26.6.2), Android phone | — | **not yet** |

### Not supported or not yet checked

- **Muse Sounds and VST instruments can't play on mobile.** MuseSampler is closed-source desktop software. Such parts play with MS Basic instead, and the mixer says so for each part. None of your scores use them.
- **Text measurement isn't identical to desktop.**
  - Desktop 4.7.5 measures text with Qt (DirectWrite on Windows), which a browser doesn't have. This player uses MuseScore 5.0's FreeType font engine, written to reproduce those numbers.
  - Page counts match, but fine spacing may differ by fractions of a millimetre.
  - MuseScore 4.7's own FreeType engine (which desktop never uses) produced broken layouts, so it isn't used.
- **Not applied:** automation lanes (none of your scores have any), and the "migrate MuseScore 3 score" step desktop offers.
- **SVG pictures** in scores are not drawn.
- **No loop, count-in, metronome button, speed control or parts view** yet. **The score library isn't remembered** between visits.
- **The iPhone/iPad native app** needs a Mac to build. iOS is covered by the installable web app.

## How to test

**iPad / iPhone** (Safari)
1. Open **https://howieyhy.github.io/mobilemusescore/** and tap Share → **Add to Home Screen**.
2. Open PocketScore from the home screen. Wait for "Ready", then tap **Open score** and pick an `.mscz` from Files. AirDrop or save your scores to Files first.
3. Tap **Play**. The first time, it downloads the MS Basic sound font (49 MB), so use Wi-Fi.
4. Check:
   - the sound plays even with the ring/silent switch on silent;
   - the blue cursor follows the music;
   - tapping a note jumps playback there;
   - the slider seeks;
   - pinch and − / + zoom;
   - the view menu switches views;
   - in the **Mixer**: volume, M, S and reverb for each part, plus master volume.
5. Offline check: after one successful play, switch on Airplane mode, close the app fully, reopen it, open a score and play.

**Android**
- Install the APK from the [releases page](https://github.com/HowieYHY/mobilemusescore/releases/tag/v0.1.0-test), allowing "Install unknown apps" when asked.
- Or use the website above in Chrome (menu → *Add to Home screen*).
- Then run the same checks.

**What to report:** the device and OS version, the score, what you did, and what happened, with a screenshot or screen recording if possible. Mention especially:
- crackles, stutters, or sound that runs slow;
- anything that looks different from desktop MuseScore.

## How it works

```
 page / app WebView                                    AudioWorklet (audio thread)
┌───────────────────────┐ Worker ┌────────────────┐ MessagePort ┌─────────────────────────────┐
│ UI: pages on canvas,  │◄──────►│ mscore.wasm    │◄───────────►│ msaudio.wasm                │
│ transport, mixer      │        │ MuseScore      │  MuseScore's │ MuseScore 4.7.5 audio:      │
│ (app/src/main.ts)     │        │ engraving +    │  audio RPC   │ FluidSynth + MS Basic.sf3,  │
│                       │        │ playback model │              │ mixer, reverb               │
└───────────────────────┘        └────────────────┘              └─────────────────────────────┘
```

This is the same split as upstream MuseScore's experimental web build
(`src/web`), with a light HTML UI instead of Qt.

- `engine/`: CMake build of both modules. `MSS_MUSESCORE=4.7` is the default; `5.0` is also supported.
- `engine/core/`: the `mscore` module.
  - `session.cpp` opens a score and sets up playback as MuseScore's PlaybackController does.
  - `painter.cpp` records drawing for the canvas.
  - `audiobackend47/50.cpp` hold the per-version audio API.
  - `fonts50.cpp` holds the font engine.
  - The remaining files are small Qt-free stand-ins for desktop services.
- `engine/audio/`: the `msaudio` module (upstream's `src/web/audioengine`).
- `app/`: web app (Vite + TypeScript), service worker, Capacitor Android project (`app/android`).
- `scripts/`: build helpers, resource bundler, and the test drivers (`headless-test`, `browser-test`, `offline-test`, `android-test`, `compare-audio`).

### MuseScore code used

| Submodule | Source | Pinned at |
| --- | --- | --- |
| `third_party/musescore-4.7` | github.com/musescore/MuseScore, tag **v4.7.5** (your desktop's version) | `3654226` |
| `third_party/musescore` | your fork github.com/HowieYHY/MuseScore-Plus (5.0 dev) | `1bc6458` |
| `third_party/muse` | github.com/musescore/muse_framework (5.0 framework; its font engine is used) | `a908ba7` |
| `third_party/muse_deps` | github.com/musescore/muse_deps (5.0 build only) | `31ad619` |

Your own `../MuseScore-Plus` folder is not modified. **Changes to MuseScore's
code** are in `patches/` and are applied with `scripts/apply-patches.sh`:

- `musescore-4.7.patch`: the same Qt-leftover fixes as the 5.0 patches, plus one start-up fix.
  - The Qt leftovers are `QString` in two headers, settings storage on the web, a web-only compile error, and a stray `toQString()`.
  - The start-up fix: `audioengineconfiguration.cpp` builds its default sound-font description on first use, because initialising it at start-up depends on file order and crashed.
- `muse_framework.patch` / `musescore.patch`: the same Qt-leftover fixes for the 5.0 sources.

## Building

Requirements: Git, Python 3, Node.js 20+, and Git Bash on Windows.

```bash
git clone --recurse-submodules <this repo> && cd <repo>
bash scripts/apply-patches.sh

# toolchain (once): CMake + Ninja from PyPI, Emscripten from github.com/emscripten-core/emsdk
python -m pip install --user cmake ninja
git clone https://github.com/emscripten-core/emsdk.git ~/tools/emsdk
~/tools/emsdk/emsdk install latest && ~/tools/emsdk/emsdk activate latest

# 1. MuseScore 4.7.5 engine -> WebAssembly (first build ~ 20 min)
source scripts/env.sh
emcmake cmake -S engine -B build/wasm47 -G Ninja -DCMAKE_BUILD_TYPE=Release -DCMAKE_POLICY_VERSION_MINIMUM=3.5
cmake --build build/wasm47

# 2. web app
cd app && npm install
npm run prepare-assets      # fonts/styles from MuseScore's .qrc lists, engine, MS Basic
npm run dev                 # http://localhost:5173
npm run build               # production build + offline file list in app/dist
```

**Android** (JDK 21 and the Android SDK):

```bash
cd app && npm run build && npx cap sync android
cd android && JAVA_HOME=... ANDROID_HOME=... ./gradlew assembleDebug
adb install -r app/build/outputs/apk/debug/app-debug.apk
```

**Tests:**

```bash
node scripts/headless-test.mjs "real test musescore files/I am move it edited.mscz"
METRONOME=1 RATE=48000 node scripts/compare-audio.mjs "real test musescore files" build/reference
(cd app && npx vite --port 5180) & node scripts/browser-test.mjs <score> chromium|webkit
(cd app && npm run build && npx vite preview --port 5181) & node scripts/offline-test.mjs <score>
node scripts/android-test.mjs <score>    # emulator or USB device, adb on PATH
```

To make the desktop references, run your desktop MuseScore 4.7.5 with
`MuseScore4.exe -o build/reference/<name>.wav <score>.mscz`.

## Getting it onto devices

- **iPad / iPhone: installable web app.** Safari → Share → *Add to Home Screen*.
  - It works offline after the first visit.
  - Safari only allows the audio engine on HTTPS pages. The app is published with GitHub Pages from the `gh-pages` branch; `bash scripts/deploy-pages.sh` (after `npm run build` in `app/`) publishes a new build.
  - This route also avoids the App Store's conflict with the GPL, and needs no Mac.
- **Android:** install the APK, or open the same web app in Chrome.
- **First download:** about 80 MB, of which MS Basic is 49 MB. Updates replace the cached copy.

## Licences

This project is **GPL-3.0-only**, because it is built from MuseScore Studio. See
[THIRD_PARTY_NOTICES.md](../THIRD_PARTY_NOTICES.md).
