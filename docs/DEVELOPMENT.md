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

## Current status (8 Oct 2026, version 0.3.2)

**Working prototype.** It runs in browsers (Chromium and WebKit) and, as the
installable web app, on an iPad (A16, iPadOS 26.6.2) and an Android phone
(Pixel 9a, installed from Chrome). The user confirmed 0.2.1's smooth cursor on
the Pixel 9a; the iPad still showed the same choppiness, which 0.3.2 addresses
(see *Moving the cursor*) and still needs checking there.

### What works

| Feature | Notes |
| --- | --- |
| Open a local `.mscz` / `.mscx` | Through the file picker. MuseScore 2.x to 4.7 files tested. |
| Score display | MuseScore's layout. Page counts of all five test scores match desktop 4.7.5, and page 1 of "I am move it" matches its saved thumbnail. Pictures (PNG, JPEG, GIF, BMP) are drawn. |
| Zoom and scroll | Opens fitted to the screen width. Zoom with − / + or pinch. |
| View modes | Page (default); Continuous vertical and horizontal. |
| Play, pause, back to start | MuseScore's audio engine in a Web Worker, rendering ahead into an AudioWorklet. |
| Seek | Position slider, or **tap a note or rest** to play from there. Repeats are respected. |
| Hear a note | While stopped, a tapped note sounds for 500 ms, as when selecting a note on desktop (`PlaybackModel::triggerEventsForItems`, MuseScore's off-stream). The nearest note within a fingertip's reach is chosen. |
| Notes on the score | Pen, highlighter, text boxes, eraser, undo (`app/src/annotations.ts`). Stored in `localStorage` per score (SHA-256 of the file) and view mode, in page units. Not written to the `.mscz`. Black by default; six toolbar colours, a 25-colour palette and the system colour picker; four sizes for pen, highlighter and eraser (`SIZES`, in screen px); text is sized by dragging its box's corner (the text scales with the box). Text boxes keep their place when finished (the move and delete buttons sit outside the text); the box being edited is outlined, not filled. *Draw with finger* switch (on until a stylus is seen; sets `touch-action: none` so Chrome can't take the stroke over). Text boxes: double-tap adds one, one tap outside finishes it. |
| Playback figures | No longer shown (the on-screen *Playback check* was removed in 0.3.0 once Android was smooth). `app.engine.stats` and `app.engine.underruns` in the console still give the engine load (share of time spent rendering while music plays; an upper bound where the worker timer only counts whole milliseconds, as in iPad Safari), busiest block, queued audio and gaps. |
| Playback cursor | Moves smoothly with the sound you hear (driven by the audio clock, corrected for the audio queued ahead). Follows playback across pages and pauses following while you scroll. |
| Mixer | Master volume, plus per-part volume, mute, solo and reverb send. Same solo/mute rules as desktop. Each part's saved sound, volume and mute/solo are read from the score. Volume is shown as loudness against the score's setting (100% = as saved, twice as loud per +10 dB; the engine still works in dB, -60 to +10). Reverb sliders are behind a *Reverb* switch. |
| Sound per part | Any MS Basic preset, grouped as desktop's mixer menu (`MS_BASIC_PRESET_CATEGORIES`, "Choose automatically" first, "Expr." presets hidden, names as `audioSourceName`). Engine: `mss_sounds`, `mss_set_track_sound` -> `IPlayback::setInputParams`. The choice is kept in `localStorage` per score and reapplied when playback is ready. |
| Back button | Mixer, sound list, colour palette and notes mode each add a history entry, so Android's Back closes them instead of leaving the app. |
| Save | One **Save** in the top bar for everything changed on a score: notes (`annotations.ts`) and mixer (`mixerstore.ts`), in `localStorage` per score (SHA-256 of the file). Nothing is saved until then; a draft is kept on every change, so closing the app loses nothing and the changes come back next time, still unsaved, with a message (iOS home-screen apps get no `beforeunload`). The only question: opening another score with unsaved changes (Save / Don't save / Cancel). Ctrl/Cmd+S. Notes saved by 0.2.x are read as saved; 0.2.1 saved mixers and 0.2.0 sound choices are carried over. A part's sound is stored only when it isn't the score's own. The score's saved master volume is read (`mss_master_volume`). |
| Mixer before Play | The audio engine starts when a score opens (the `AudioContext` starts suspended until a tap; Play or tapping a note resumes it), so the sounds load straight away. The mixer works from the moment the score is open: the engine sets each part's volume, reverb and mute/solo from the score at load (no longer when the sounds are added), so changes made before the sounds arrive are kept. Sound choices made or restored before then are applied once the sounds are loaded. |
| Metronome | Its mixer strip starts muted (desktop's metronome is off by default); unmuting it turns the clicks on in the playback model (`setMetronome`), muting turns them off. |
| Interruptions | When the device stops the sound (a call, Siri, a system dialog; the `AudioContext` leaves "running"), playback pauses so the cursor stops too. The app never uses `confirm()`/`alert()` (on iPad they stop the sound); questions use its own dialog. Opening a score stops playback first. |
| Fonts | Chrome rejects MuseScore's `BravuraText.otf` (its format 4 `cmap` lacks the 0xFFFF terminator), and a page using it (Paper Hearts' page 1) was not drawn. `scripts/fix-fonts.py` (fontTools, run by `build-resources.mjs`) rewrites just that table; the mapping and every other table are unchanged, and page counts are the same. A font that still fails no longer stops a page from being drawn. |
| Offline | After the first visit, the web app opens and plays scores with no network. |
| Install | Chrome/Edge's `beforeinstallprompt` shows an *Install PocketScore* button on the start screen; Safari uses Share -> Add to Home Screen. |

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

- **The same notes, sounds, dynamics and tempo.** The level stays within ±1 dB in every half second. The remaining differences are millisecond-scale note timing: desktop's export processes audio in blocks of about 21 ms; these figures were measured with the player using blocks of under 3 ms (the app now renders in 1024-frame blocks, the same size as desktop).
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
| Slow-phone simulation: play 20 s with the CPU slowed 1×, 4×, 6× (`stress-test.mjs`) | Chromium | 0 audio gaps at every rate; cursor 60 fps at 4x and 6x (0.2.0). DevTools throttling may not slow the audio worker, and this test did not catch the Pixel 9a problem |
| Android (APK 0.1.x, retired): open, play, audio clock vs position (7.99 s vs 7.91 s), audio gaps (0), mute, seek | Android 16 emulator (software graphics) | pass |
| Phone (412x915, touch, Chromium): mixer before Play, sounds loading on open, finger drawing on/off, double-tap text, palette, Back closes panels, mixer % volume (50% = -10.0 dB), Muted label, Reverb switch, sound picker, install button; Save: lights up, unsaved changes back after reopening with a message, kept after Save, question when opening another score (Cancel keeps, Don't save drops) (`mobile-test.mjs`) | Chromium | pass |
| Sounds loaded at open with the audio suspended (as iOS before a tap): tapping a note sounds it, Play plays | Chromium | pass |
| Cursor smoothness over 12 s: steady clock; Android-like clock (output timestamps in ~100 ms steps, up to 15 ms late, position reports +-60 ms); no output timestamps with `currentTime` in 100 ms steps; position reports held up to 400 ms and delivered in bursts (iPad-like) (`cursor-test.mjs`) | Chromium | 0.2.0: 0 / 57 / 119 / -; 0.2.1: 0 / 0 / 0 / 3 jumps and 7 steps back; 0.3.2: 0 / 0 / 0 / 0; score position +8.02 s per +8.00 s of audio clock (browser test), +20.02 s per +20.01 s with the CPU slowed 6x |
| Toolbars and mixer at phone, iPad mini, Air (both ways) and Pro 13 sizes (`layout-shots.mjs`, screenshots checked by eye) | Chromium | notes bar on full rows at every size; score name on its own row on phones |
| Sound change on all 4 test scores: another preset changes the sound (similarity 0.00-0.19 to the original); switching back matches the original as closely as a second take does (`headless-test.mjs`) | Node.js | pass |
| Engine rebuilt with Emscripten 6.0.11, vs desktop MP3 exports in `real test musescores/audio equivalents` | Node.js + Chromium decoder | level within 0.4-1.1 dB, loudness 0.95-0.99, spectrum 0.97-0.99, no drift |
| Your tests: open, draw, play, mixer, seek | iPad (A16, iPadOS 26.6.2), web app | pass |
| Note preview: tapped note sounds (−47 dB vs silence), stops, empty space is silent (`note-preview-test.mjs`) | Node.js | pass |
| Notes: black default, draw, highlight, double-tap text, tap outside finishes it without the text moving (under 1 px), see-through while editing, palette colour, thickest pen, erase, undo, zoom; Save lights up, unsaved notes back after reopening, kept after Save, Clear, question when opening another score (`notes-test.mjs`) | Chromium | pass |
| Web app update: live 0.1.3 -> 0.2.0 downloads 11.3 MB (the rebuilt engine; unchanged files kept by content hash), shows the new version on reopening; the open app reloads itself when an update is ready; works offline after (`update-test.mjs`) | Chromium | pass |
| Android phone (Pixel 9a, APK 0.1.1) | user | **still choppy**; the web app 0.2.0 (render ahead, smooth clock, deeper queue, playback check) is not yet checked on the phone |

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

**Android** (Chrome)
1. Open the link above in Chrome and tap **Install PocketScore** (or the menu, *Add to Home screen*, *Install*).
2. Run the same checks, plus: drawing with a finger with *Draw with finger* on and off, double-tap
   for a text box, the phone's Back button closing the mixer and notes, changing a part's sound,
   Save, and the question when opening another score with unsaved changes.
3. With the phone on USB debugging, `node scripts/android-test.mjs <score>` drives Chrome on it.

**What to report:** the device and OS version, the score, what you did, and what happened, with a screenshot or screen recording if possible. Mention especially:
- crackles, stutters, or sound that runs slow;
- anything that looks different from desktop MuseScore.

## How it works

```
 page / app WebView                                    audio Worker
┌───────────────────────┐ Worker ┌────────────────┐ MessagePort ┌─────────────────────────────┐
│ UI: pages on canvas,  │◄──────►│ mscore.wasm    │◄───────────►│ msaudio.wasm                │
│ transport, mixer      │        │ MuseScore      │  MuseScore's │ MuseScore 4.7.5 audio:      │
│ (app/src/main.ts)     │        │ engraving +    │  audio RPC   │ FluidSynth + MS Basic.sf3,  │
│                       │        │ playback model │              │ mixer, reverb               │
└───────────────────────┘        └────────────────┘              └──────────────┬──────────────┘
                                                              1024-frame blocks │ MessagePort
                                                                 ┌──────────────▼──────────────┐
                                                                 │ AudioWorklet (audio thread) │
                                                                 │ plays from its queue        │
                                                                 └─────────────────────────────┘
```

**Why the audio engine is not in the AudioWorklet.** At first, `msaudio` ran
inside the worklet and was called for every 128-frame slice. A slow phone could
not always finish that within the slice's ~2.7 ms deadline, so the sound
stuttered. Now `msaudio-worker.js` renders 1024-frame blocks about 170 ms ahead.
While playing it keeps about 340 ms queued (16 blocks), growing by four blocks
on each underrun up to about 1 s. While stopped it keeps only ~85 ms queued, so
a tapped note sounds quickly. Blocks carry a flush generation, so audio rendered
before a seek is never played after it. The worklet
(`msaudio-worklet.js`) only copies from its queue.
- **Keeping the cursor in time.** The worklet reports how much audio is
  queued, and the page passes that latency to the score engine
  (`mss_set_output_latency`), which reports the position you *hear*.
- **Seek, pause and stop** flush the queue, and pause rewinds to the heard
  position.
- **Moving the cursor.** It is animated each frame from the audio clock and a
  timeline of note positions (`mss_timeline`), not from position messages. The
  clock comes from `getOutputTimestamp()`: on Android `currentTime` only moves
  when the device takes a batch of audio (about 10 times a second), and some
  devices give no output timestamp at all. So the cursor's clock runs on the
  system clock and is pulled 10% of the way toward each new audio-clock
  reading (snapping only for differences over 0.25 s). Music and clock move at
  the same rate, so position messages only set the offset between them: it
  follows the upper edge (90th percentile) of the last 0.6 s of messages,
  because late messages always look behind; it changes by at most 30% faster
  or slower per unit of time, so the cursor never goes back; seeks
  resynchronise it at once, and only an unexplained jump over 1 s snaps.
  On Play the cursor waits at the start for the audio queued ahead to reach
  the speaker (`engine.playLatency`), and the first 0.5 s of messages (made
  with the stopped queue's latency) are ignored. A stopped audio clock is
  never extrapolated.
- **Speed.** `muse_audio_engine` and FluidSynth are built with WebAssembly SIMD.
  This takes rendering of 1024-frame blocks from about 16× to about 20× real time
  on a desktop CPU.

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
- `app/`: web app (Vite + TypeScript) and service worker. (Up to 0.1.3 there was also a Capacitor Android project; Android now installs the web app from Chrome.)
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

Requirements: Git, Python 3 with fontTools (`python -m pip install --user fonttools`), Node.js 20+, and Git Bash on Windows.

```bash
git clone --recurse-submodules <this repo> && cd <repo>
bash scripts/apply-patches.sh

# toolchain (once): CMake + Ninja from PyPI, Emscripten from github.com/emscripten-core/emsdk
# (the submodules can be fetched shallow: git submodule update --init --depth 1)
python -m pip install --user cmake ninja
git clone https://github.com/emscripten-core/emsdk.git ~/tools/emsdk
~/tools/emsdk/emsdk install latest && ~/tools/emsdk/emsdk activate latest   # Windows: emsdk.bat

# 1. MuseScore 4.7.5 engine -> WebAssembly (first build 8-20 min)
#    env.sh points emsdk at the real Python (on Windows `python3` is often the Store stub)
source scripts/env.sh
emcmake cmake -S engine -B build/wasm47 -G Ninja -DCMAKE_BUILD_TYPE=Release -DCMAKE_POLICY_VERSION_MINIMUM=3.5
cmake --build build/wasm47

# 2. web app
cd app && npm install
npm run prepare-assets      # fonts/styles from MuseScore's .qrc lists, engine, MS Basic
npm run dev                 # http://localhost:5173
npm run build               # production build + offline file list in app/dist
```

**Tests:**

```bash
node scripts/headless-test.mjs "real test musescores/I am move it(howie version).mscz"
METRONOME=1 RATE=48000 node scripts/compare-audio.mjs "real test musescores" build/reference
(cd app && npx vite --port 5180) & node scripts/browser-test.mjs <score> chromium|webkit
(cd app && npm run build && npx vite preview --port 5181) & node scripts/offline-test.mjs <score>
node scripts/android-test.mjs <score>    # Chrome on a USB-debugging phone, adb on PATH (APP_URL picks the site)
node scripts/mobile-test.mjs [score]     # dev server; phone-sized touch screen in Chromium
node scripts/cursor-test.mjs [score]     # dev server; cursor smoothness with Android-like audio clocks
node scripts/layout-shots.mjs [score]    # dev server; screenshots at phone and iPad sizes in build/layout
node scripts/stress-test.mjs <score> 4   # dev server; CPU slowed 4x, reports audio gaps and fps
node scripts/note-preview-test.mjs <score>
node scripts/update-test.mjs build/ghpages   # installed web app updates to app/dist
node scripts/notes-test.mjs <score> chromium   # dev server
```

To make the desktop references, run your desktop MuseScore 4.7.5 with
`MuseScore4.exe -o build/reference/<name>.wav <score>.mscz`.

Browser tests store the whole app (80 MB) in a fresh browser profile. If the
system drive is nearly full, Chromium silently fails to cache the 49 MB sound
font and the update test reports a large download; set `TMP`/`TEMP` to a folder
on a drive with space.

## Getting it onto devices

- **iPad / iPhone: installable web app.** Safari → Share → *Add to Home Screen*.
  - It works offline after the first visit.
  - Safari only allows the audio engine on HTTPS pages. The app is published with GitHub Pages from the `gh-pages` branch; `bash scripts/deploy-pages.sh` (after `npm run build` in `app/`) publishes a new build.
  - This route also avoids the App Store's conflict with the GPL, and needs no Mac.
- **Android:** the same web app, installed from Chrome (*Install PocketScore*). It updates like the iPad version.
- **First download:** about 80 MB, of which MS Basic is 49 MB. Updates replace the cached copy.

## Licences

This project is **GPL-3.0-only**, because it is built from MuseScore Studio. See
[THIRD_PARTY_NOTICES.md](../THIRD_PARTY_NOTICES.md).
