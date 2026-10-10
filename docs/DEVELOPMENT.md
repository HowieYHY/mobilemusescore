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

## Current status (10 Oct 2026, version 1.0.8)

**Version 1.0: the first release for everyone.** It runs in browsers (Chromium
and WebKit) and, as the installable web app, on an iPad (A16, iPadOS 26.6.2)
and an Android phone (Pixel 9a, Android 17, installed from Chrome); the Pixel
was measured over USB (see *Tests*). Open issues: #3 (design, open to contributors) and #18
(possibly shipping to the App Store and Google Play). The RESO website's preview (#2, #14) is live on
nusresonance.com since 10 Oct 2026; focus mode (#17) is live since 1.0.5, passes on the Pixel 9a
(`android-focus-test.mjs`) and was closed by the user on 10 Oct 2026, with the iPad and iPhone checks
below still to do.

### Still to check by hand on an iPad and an iPhone

These can't be automated from Windows (see CLAUDE.md, *iPhone*). The user will do them in a later
session. First make sure the start screen shows 1.0.8 or later.

| What | How | Expected |
| --- | --- | --- |
| Focus, by the button (iPad) | Open a score, tap ⛶ beside ? | iPad Safari's own bars go too (it allows full screen); only the music and Play remain |
| Focus, by the button (iPhone) | Same, in Safari and in the home-screen app | Only PocketScore's bars go (an iPhone's Safari has no full screen); nothing else changes |
| Focus, taps | In focus: tap a note, then a margin or the title | The note plays and focus stays; off the music, the bars slide back |
| Focus, by itself | Play and don't touch for 4 s; stop and don't touch for 10 s | Focus starts both times, without full screen; never with the mixer open |
| Leaving focus | Swipe back / the iPad's Esc key | Bars come back, still in PocketScore |
| Motion | Open and close the mixer, speed, loop, the sound list, notes, the colour palette | Each slides and fades (Safari 17.5+; older ones show and hide at once) |
| Update with a score open | Needs a newer version published: open a score, then switch to another app and back (or leave it 20 s, stopped) | It restarts into the new version (maybe a second or two of loading when you return: iOS pauses apps in the background) and the score is back at the same place, view, zoom, speed and loop |

### What works

| Feature | Notes |
| --- | --- |
| Open a local `.mscz` / `.mscx` | Through the file picker. MuseScore 2.x to 4.7 files tested. |
| Score display | MuseScore's layout. Page counts of all five test scores match desktop 4.7.5, and page 1 of "I am move it" matches its saved thumbnail. Pictures (PNG, JPEG, GIF, BMP) are drawn. |
| Zoom and scroll | Opens fitted to the screen width. Zoom with − / + (around the middle of the view) or pinch (around the point between the fingers, which stays under them while pinching and after the redraw: `zoomAround`, anchored to a page and the fraction across it). Two fingers are handled in one place, in and out of notes mode: a plain scroll that follows the fingers until their distance changes by 8% (`PINCH_START`), then a pinch scaled with CSS and redrawn at the new size when the **last** finger lifts (finishing at the first rebuilt the pages under the other finger, whose lifting never reached the app: page drawing then waited for it for good and the pages stayed blank, issue #9). Page drawing waits while fingers are down, but a finger count with no touch activity for 3 s is not trusted; page canvases have `pointer-events: none`, so touches land on the page element. The viewer has `overflow-anchor: none` (the app keeps the reader's place). |
| View modes | Page (default); Continuous vertical and horizontal. |
| Play, pause, back to start | MuseScore's audio engine in a Web Worker, rendering ahead into an AudioWorklet. |
| Seek | Position slider, or **tap a note or rest** to play from there. Repeats are respected. |
| Hear a note | While stopped, a tapped note sounds for 500 ms, as when selecting a note on desktop (`PlaybackModel::triggerEventsForItems`, MuseScore's off-stream). The nearest note within a fingertip's reach is chosen. |
| Notes on the score | Pen, highlighter, text boxes, eraser, undo (`app/src/annotations.ts`). Stored in `localStorage` per score (SHA-256 of the file) and view mode, in page units. Not written to the `.mscz`. Black by default; six toolbar colours, a 25-colour palette and the system colour picker; four sizes for pen, highlighter and eraser (`SIZES`, in screen px); text is sized by dragging its box's corner (the text scales with the box). Text boxes keep their place when finished (the move and delete buttons sit outside the text); the box being edited is outlined, not filled. *Draw with finger* switch (on until a stylus is seen; sets `touch-action: none` so Chrome can't take the stroke over). Text boxes: double-tap adds one, one tap outside finishes it. |
| Playback self-check | Gaps in the sound (the worklet's queue ran dry while playing) and frames over 120 ms are logged in `app.engine.health` (last 100, for diagnosing a device over USB debugging); `app.engine.stats` and `app.engine.underruns` give the engine load, busiest block, queued audio and gaps. After a gap the audio worker keeps ~170 ms more sound ready (up to ~1 s) and the reader is told once per score. After a jump while playing (slider, tapping a note), the worklet waits for ~128 ms of fresh audio before playing on (`PRIME_FRAMES`): playing the first fresh block at once ran dry a moment later, a hiccup the self-check took for a slow device (3 gaps in 8 jumps on the Pixel 9a, 0 in 24 after). Android starts with ~510 ms ready (others ~340 ms). No permanent on-screen figures. |
| Page drawing | In pieces (`pageDrawer`, `drawJobs`): about 6 ms per frame while playing, 12 ms when stopped, the page nearest the view first, starting 1500 px ahead of it; one page failing does not stop the others. On zoom the old drawings stay, stretched, until each page is redrawn (`standIns`), so no page goes blank. Pages further than 1500 px from the view give their canvas back (iPad Safari refuses new canvases past a memory limit); a refused canvas first frees stand-ins, then is tried at half and a quarter of the resolution. `zoom-test.mjs` (CPU 4x, also `CANVAS_MB` to imitate Safari's limit, and `PHONE=` on a USB phone): 0.3.4 left the pages blank for good after a pinch on the Pixel; now never blank while zooming, sharp within 0.06 s on the Pixel and 0.7 s at CPU 4x. Drawing a whole page at once took 35-108 ms with the CPU slowed 4x and froze the playback line at every page turn; the worst frame went from 183 to 67 ms. |
| Playback cursor | Moves smoothly with the sound you hear (driven by the audio clock, corrected for the audio queued ahead). Follows playback across pages and pauses following while you scroll. After a jump while playing it waits on the target until the reports show the new sound has reached it (`holdAt`), instead of re-syncing to the first report, which still described the old place. Timeline lookups count times within 0.5 ms as reached (times arrive rounded differently; a line's first note used to fall back to the previous line's closing barline). |
| Mixer | Master volume, plus per-part volume, mute, solo and reverb send. Same solo/mute rules as desktop. Each part's saved sound, volume and mute/solo are read from the score. Volume is shown as loudness against the score's own setting (100% = as saved, twice as loud per +10 dB, 0-200%; the engine works in dB, -60 to +12, desktop's range). A slider still at its starting mark keeps the exact setting, so touching one changes nothing (it used to round, and cut parts saved at +12 dB to +10, lighting Save). Reverb sliders are behind a *Reverb* switch. |
| Swing | The score's *Swing* texts are read into each staff at load (`Score::updateSwing`, as `MasterNotation::setMasterScore`); without it only the style's swing played (issue #10). "Dream a little dream" against the desktop export: loudness over time 0.951 -> 0.990, the 10 s where swing starts 0.81 -> 0.98. |
| Speed and loop | As desktop's playback toolbar: *Speed* 10-300% in 5% steps (`mss_set_speed`: `TempoMap::setTempoMultiplier`, `updateRepeatListTempo`, playback model reload, back to the same place in the music, as `PlaybackController::setTempoMultiplier`), *Loop playback* and *Set loop marker left / right* at the play position the reader sees (the start or the end of the note or rest there, in played ticks so repeats and speed changes keep the bars; `IPlayer::setLoop`). With no markers the whole score loops; Play outside the loop starts at its beginning. Per score, for the session (a new score: 100%, no loop). Two round buttons by Mixer, Speed and Loop, each open their own panel (opening one takes over the other's Back entry; closing through history first closed the new panel). Speed shows its value when not 100%, Loop is filled while looping. The markers are drawn on the score as desktop's `LoopMarker` (a line through the system with a flag, #2456AA, placed from the playback line's timeline), and a band under the position slider marks the loop; *Clear loop markers* (`mss_clear_loop`) removes both. The Speed panel shows the tempo as desktop's toolbar does (quarter-note BPM at the play position with the speed applied, `PlaybackToolBarModel::tempo`), from `mss_tempos` (every tempo change, repeats unrolled); typing one sets the speed to match (exact, while − / + / the slider snap to 5%). A marker button waits for a tap on the score and places its marker on the tapped note (`mss_locate`: `seekAt`'s search without seeking or sounding); tapping it again or closing the panel cancels. On phones (up to 520 px) the position slider has its own row above the buttons; panels and the zoom buttons follow the bar's measured height (`--transport-h`). On the Pixel: loop wraps with no sound gaps, also at 80%. |
| Tips | A *Tip PocketScore* link on the start screen, a small heart in the top bar (phones: at the end of the score-name row; wider screens: before Save) and the README opens a Stripe Payment Link (`buy.stripe.com/3cI00jg1L7X3f1c8Zgd7q00`) in the browser. No payment code, keys or server in the app. Stripe: individual account, category software, public name and statement descriptor PocketScore / POCKETSCORE, product *Tip for PocketScore* with a customer-chosen amount (no minimum, by the owner's choice). Payment methods: PayNow (1.3%) and cards (3.4% + S$0.50; Apple/Google Pay ride on cards); Link and the rest are off. A S$0.50 card test netted -S$0.02, so the README steers people to PayNow. Worded as a tip for the app, not a donation (Stripe only allows donations for a charitable purpose). |
| Updates | The service worker installs a new build by itself (only changed files) and takes over (`skipWaiting`, `clients.claim`); the page looks for one on opening, on coming back (`visibilitychange`) and every 30 minutes (`reg.update()`). On `controllerchange` with no score open it reloads at once. With a score open it waits for a quiet moment (`maybeRestartForUpdate`, every 2 s): not playing, no layer but focus, no notes, tour or question; then at once if the page is hidden, else after 20 s without input. `restartForUpdate` keeps the score (a copy made in `openScore`, since the engine takes the data), view, zoom, scroll, position, speed, loop and focus in IndexedDB (`pocketscore-restart`), writes the mixer draft at once, and reloads; `reopenAfterUpdate` reopens it (seeking only once the sounds are ready: an earlier seek is lost) and deletes the copy. The yellow bar stays as a fallback. A page drawing queued for a layout with more pages is skipped (`renderPage`), which the restore's quick view change exposed. `update-restart-test.mjs` (the timing rules, and every test score back as it was) and `update-test.mjs` step 4 (a real update with a score open, from the published build). |
| Motion | Panels (mixer, speed, loop, the sound list, the notes bar, the colour palette, the question box) slide and fade in and out over 0.22 s, transforms and opacity only, in CSS: `@starting-style` animates the showing, and `transition: display … allow-discrete` keeps a panel on screen while it fades out after `hidden` is set. Browsers without these show and hide at once, as before; nothing with `prefers-reduced-motion`. |
| Focus mode | Issue #17. The ⛶ button in the top bar's icon group (hidden on the start screen) adds the `focus` class to `<html>`: the bars, zoom and panels are hidden (not closed, so they come back as they were) and the bottom bar's own Play floats bottom right. It requests full screen (`requestFullscreen`, or `webkitRequestFullscreen` on iPad Safari) except inside the Reso website; an iPhone's Safari has neither, so there only PocketScore's bars go. Focus is a layer (`openLayer`), so the phone's Back leaves it, and leaving full screen the browser's way leaves it too. A tap is on a stave when it falls in a system's band (from the timeline: page, top, height, first and last note), widened by 3 spatia up and down, 10 left (clef, key) and 6 right (barline); off the staves it leaves focus, on them it plays as before. Notes mode is finished first, waiting for its layer's `popstate` (otherwise that late `popstate` closed focus instead). It also starts by itself after 4 s without input (`pointerdown`, `pointermove`, `keydown`, `wheel`; not scrolling, which the page does itself) while playing, 10 s while stopped, never over a layer (panel, notes, tour) or the ask dialog, and without full screen (browsers need the reader's tap). It is off when `navigator.webdriver` is set, so automated tests aren't surprised by it; `focus-test.mjs` sets `app.testAutoFocus`. Motion uses only transforms and opacity: going in, the bars slide off their edges while the viewer rises with the top bar (no gap above the music), then the layout changes under it; coming back, the viewer is drawn where it was and glides down (FLIP) as the bars slide in. 60 fps with the CPU slowed 4x (longest frame 17 ms); none with `prefers-reduced-motion`. `scripts/focus-test.mjs`: touch on a phone and an iPad, the mouse on a desktop, and a note and the title area on every test score. |
| Preview in the Reso website | `?embed=reso` inside the NUS Resonance library (`../reso-website`, `ScorePreview.js`): the page posts `pocketscore-ready` to its parent, which answers with `{ type: "pocketscore-open", name, data }` (the `.mscz` as an ArrayBuffer, fetched there with the member's sign-in). Accepted only from the parent window at `EMBED_ORIGINS` (`VITE_EMBED_ORIGINS`, default www.nusresonance.com, nusresonance.com and localhost:3000, so a local copy of the website can use it), and opened once `engineReady`. **The website runs its own frozen copy of the 1.0.4 build** from its `public/pocketscore/` (served as `/pocketscore/index.html`, since Next.js redirects `/pocketscore/`), so releases here don't change it and it works when GitHub Pages is down; replacing it means copying a new `app/dist` there (81 MB of Vercel Hobby's 100 MB upload; the website's deploy stops above 95 MB). The website's bar around it adds Files (the `.mscz` download and the PDFs and recordings beside it in Drive); PocketScore itself is unchanged. The `embedded` class hides Open, Save, Notes, the title and the tip heart (the website's bar names the score and closes it); `MixStore(key, false)` keeps nothing. `scripts/preview-shots.mjs` screenshots and checks it with the website running locally (`npm run db:dev` and `npm run dev` there): it plays, Solo leaves one part, a part's sound changes, it is the website's 1.0.4 copy, nothing is kept, Files lists and downloads the score, and the bar fits a phone. `QUERY=` and `FILE=` pick the score (e.g. `QUERY=2002 FILE="2002 v3"`). |
| Sound per part | Any MS Basic preset, grouped as desktop's mixer menu (`MS_BASIC_PRESET_CATEGORIES`, "Choose automatically" first, "Expr." presets hidden, names as `audioSourceName`). Engine: `mss_sounds`, `mss_set_track_sound` -> `IPlayback::setInputParams`. The choice is kept in `localStorage` per score and reapplied when playback is ready. *Several parts* (a small button by the sound list's title, so the list stays uncluttered) shows chips for every part and All parts; a sound picked goes to all chosen parts, and *Each part's sound in the score* restores them. |
| Notes mode taps | With *Draw with finger* off, a finger's tap on a note plays it and moves the playback (`Annotations.fingerTapIsFree`), except with the Text tool, whose taps make text boxes. |
| Back button | Mixer, sound list, colour palette and notes mode each add a history entry, so Android's Back closes them instead of leaving the app. |
| Save | One **Save** in the top bar for everything changed on a score: notes (`annotations.ts`) and mixer (`mixerstore.ts`), in `localStorage` per score (SHA-256 of the file). Nothing is saved until then; a draft is kept on every change, so closing the app loses nothing and the changes come back next time, still unsaved, with a message (iOS home-screen apps get no `beforeunload`). The only question: opening another score with unsaved changes (Save / Don't save / Cancel). Ctrl/Cmd+S. Notes saved by 0.2.x are read as saved; 0.2.1 saved mixers and 0.2.0 sound choices are carried over. A part's sound is stored only when it isn't the score's own. The score's saved master volume is read (`mss_master_volume`). |
| Mixer before Play | The audio engine starts when a score opens (the `AudioContext` starts suspended until a tap; Play or tapping a note resumes it), so the sounds load straight away. The mixer works from the moment the score is open: the engine sets each part's volume, reverb and mute/solo from the score at load (no longer when the sounds are added), so changes made before the sounds arrive are kept. Sound choices made or restored before then are applied once the sounds are loaded. |
| Metronome | Its mixer strip is muted whenever a score opens (`Session::load` resets it; desktop's metronome is off by default), and its on/off is not kept in saved settings; unmuting it turns the clicks on in the playback model (`setMetronome`), muting turns them off. |
| Leaving the app | `visibilitychange` to hidden pauses playback (the audio would otherwise go on in the background); coming back shows a message. |
| Saved sounds on reopening | The `playbackReady` handler waits for the opened score's saved settings to be restored (`mixLoading`). Before, when the audio was already running, the sounds could become ready while saved settings were being put back part by part, and the sound choices queued after that were never applied (parts back on the score's sound, e.g. 6 of 9 voices of GODS on MS Basic). `reopen-test.mjs` (SLOW=1 makes the restore slow, as on a phone) lost them in 4 of 6 reopenings before, 0 after. |
| Screen fit | The app is pinned to the screen's edges (`body { position: fixed; inset: 0 }`) instead of `100dvh`, which was stale after an installed app restarted for an update (Android: bottom bar buried) and short of the screen (iPad: gap at the bottom). The bottom bar keeps the larger of its padding and the home-indicator space, not both. In the iPhone/iPad home-screen app the status bar is `black` (not `black-translucent`): with translucent, iOS 26 started the page under the status bar but kept it one status bar short (window 812 of 874 px on an iPhone) and left a light strip under the bottom bar that no CSS reaches. |
| Cursor at barlines | A bar's end point (on the barline, at the same moment as the next bar's first note) is left out of the timeline when the next bar is on the same line, so the cursor glides from the last note of a bar to the first of the next instead of stopping at the barline and jumping. |
| Interruptions | When the device stops the sound (a call, Siri, a system dialog; the `AudioContext` leaves "running"), playback pauses so the cursor stops too. The app never uses `confirm()`/`alert()` (on iPad they stop the sound); questions use its own dialog. Opening a score stops playback first. |
| Fonts | Chrome rejects MuseScore's `BravuraText.otf` (its format 4 `cmap` lacks the 0xFFFF terminator), and a page using it (Paper Hearts' page 1) was not drawn. `scripts/fix-fonts.py` (fontTools, run by `build-resources.mjs`) rewrites just that table; the mapping and every other table are unchanged, and page counts are the same. A font that still fails no longer stops a page from being drawn. |
| Offline | After the first visit, the web app opens and plays scores with no network. |
| First-time help | `firsttime.ts` decides once per device whether someone is new (issue #16): anyone with notes, mixer settings or preferences already saved counts as returning, and blocked storage too, so nobody is asked every visit. Newcomers see *Take the tour* on the start screen until they take it or open a score. The tour (`tour.ts`, issue #15) rings one control at a time with a card beside it (below, above, or inside a big area such as the score), steps for the start screen or for an open score, leaving out controls not shown in the layout; the **?** in the top bar starts it any time, Back/Escape/Skip close it, and it never starts by itself. Not in the website preview. `firsttime-test.mjs`, `tour-test.mjs` (5 sizes, each ring checked against its control, screenshots in `build/tour-shots`). |
| Install | Chrome/Edge's `beforeinstallprompt` shows an *Install PocketScore* button on the start screen. iPhone and iPad (iPadOS also passes for a Mac, so: a Mac with touch) have no prompt, so the start screen says how (*Share*, then *Add to Home Screen*) until PocketScore runs as the installed app (issue #13); the start-screen tour includes it. `install-hint-test.mjs` (iPhone, iPad, home-screen app, Mac, Android, preview). |

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
| Android phone (Pixel 9a, Android 17, Chrome 154) over USB (`android-test.mjs`): 0.3.4 in the installed app and a tab, all six scores, 30-60 s each, also with a finger scrolling | Claude | no sound gaps while playing, 60 fps, no frame over 50 ms, the playback line never stood still over one frame. The only gaps came from **jumps while playing** (fixed after 0.3.4, see Playback self-check). Issue #4 not reproduced otherwise; next time it happens, read `app.engine.health` over USB before closing the app |
| Open picker filter on Android (`android-picker-test.mjs`, all six filters of `picker-test.html`) | Claude | Android's file picker shows every file whatever the filter (Word, zip and PDF files included, none greyed out): it knows no type for `.mscz`. The app's check after picking is what helps there (issue #7) |
| Tapping notes (`tap-precision-test.mjs`): every notehead on the first 2 pages (found in the page drawing) tapped with a phone fingertip's reach picks that note, the playback line is drawn at it, and a left loop marker at each line's first note is drawn there | Chromium, 6 scores | pass (0.3.7: markers at 2-8 of 12 line starts drawn at the end of the line before) |
| Tapping notes on the Pixel with real touch: the line lands 5 px left of the notehead, stopped and (since 0.3.8) 0.15 s after a tap while playing | Pixel 9a | pass (0.3.7 while playing: 20-34 px before the note for half a second) |
| Zoom never blanks the pages (`zoom-test.mjs`): + / − / pinch / scroll at CPU 4x, with a 256 and 128 MB canvas limit, and on the Pixel with real touch (`PHONE=`) | Chromium, Pixel 9a | pass (0.3.4 on the Pixel: blank for good after the first pinch) |
| Pinch zoom and two-finger scroll (`pinch-test.mjs`, real touch input): the point between the fingers stays within 0.5 px during and after a pinch (9 failures on 0.3.3), the − / + buttons keep the middle, two-finger scroll in reading and notes mode follows the fingers exactly | Chromium | pass |
| Save stays dark when nothing changed (`no-change-test.mjs`): waits for sounds, mixer, sound list, touching every slider, notes mode, play/pause, tapping a note, zoom, views, reopening | Chromium, 5 scores | pass (27 failures on 0.3.3) |
| Several parts' sound at once and back (`sounds-multi-test.mjs`) | Chromium | pass |
| Self-check (`selfcheck-test.mjs`): a gap caused on purpose is detected, logged, told once, the queue grows, no further gaps | Chromium | pass |
| Notes-mode taps (`notes-tap-test.mjs`): finger draws a dot with Draw with finger on; plays the note with it off (pen, highlighter, eraser), not with Text | Chromium | pass |

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
3. With the phone on USB debugging (adb from Google's platform-tools; on the Windows PC it is in
   `D:/tools/platform-tools`), `scripts/android-test.mjs` drives the phone's own Chrome over its debugging
   socket: a new tab at a local build (`npx vite preview --host --port 4173` in `app/`, then
   `adb reverse tcp:4173 tcp:4173`), or `ATTACH=1` for the installed app as the reader runs it. It measures
   gaps, frames and the playback line, also with `SCROLL=1` (a finger scrolling) and jumps while playing.
   It installs and writes nothing on the phone; a local build is its own site, so the reader's notes and
   mixers are never touched. Playwright's `launchBrowser` does not work with release Chrome (it ignores
   the command-line file) and leaves that file behind. Keep the page under test in front: a hidden tab
   is throttled (it never even said Ready).

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
APP_URL=http://localhost:4173/ [SCROLL=1] [PLAY_SECONDS=30] node scripts/android-test.mjs <score>   # Chrome on a USB phone; ATTACH=1: the installed app
node scripts/android-picker-test.mjs     # Android's file picker for each Open filter (screenshots)
node scripts/mobile-test.mjs [score]     # dev server; phone-sized touch screen in Chromium
node scripts/cursor-test.mjs [score]     # dev server; cursor smoothness with Android-like audio clocks
node scripts/layout-shots.mjs [score]    # dev server; screenshots at phone and iPad sizes in build/layout
SLOW=1 node scripts/reopen-test.mjs [score] [times]   # dev server; saved sounds survive reopening (slow-device race)
node scripts/stress-test.mjs <score> 4   # dev server; CPU slowed 4x, reports audio gaps and fps
node scripts/note-preview-test.mjs <score>
node scripts/pinch-test.mjs <score>          # pinch zoom and two-finger scroll (touch)
node scripts/no-change-test.mjs <folder>     # Save stays dark when nothing changed
node scripts/sounds-multi-test.mjs <score>   # several parts' sound at once
node scripts/selfcheck-test.mjs <score>      # playback self-check after a gap
node scripts/notes-tap-test.mjs <score>      # finger taps in notes mode
[CANVAS_MB=256] [PHONE=<url>] node scripts/zoom-test.mjs [score]   # pages never blank while zooming
node scripts/tap-precision-test.mjs [folder] [pages]   # tapping noteheads picks them; line and markers drawn there
# app/public/picker-test.html: try six Open filters on a device (issue #7)
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
