# PocketScore: notes for Claude

Read [README.md](README.md) (user guide) and [docs/DEVELOPMENT.md](docs/DEVELOPMENT.md) (architecture,
build, tests, status) before working here.

## Standing requirements

- The user works from several machines. Commit and push when they say the session is ending, after
  updating the README and DEVELOPMENT.md so each is one current picture, not a log.
- Their test scores are in `real test musescores/` (gitignored, copied by hand between machines),
  with desktop MP3 exports in `real test musescores/audio equivalents/`. Run the tests on every score.
- Android gets the **installable web app from Chrome** (the Capacitor project was removed in 0.2.0).
  iPad/iPhone use Safari's Add to Home Screen. One web app, one update path. Don't mention APKs in the
  README: the user was the only one who used one.
- Match desktop MuseScore 4.7.5 where there is a desktop equivalent (sound menu, sound names, mixer
  rules); read its source in `third_party/musescore-4.7` rather than guessing.
- Mixer volume is shown as loudness in % against the score's own setting (100% = as saved); the user
  asked for this over dB.
- Notes: black is the default colour; double-tap adds a text box, one tap outside finishes it and
  the text stays exactly where it was; the box being edited is outlined, never filled (no yellow);
  *Draw with finger* is a visible switch for people without a stylus; each tool has a size choice.
- **One Save for the whole score** (notes + mixer), in the top bar, kept in PocketScore on the device
  (the user chose this over writing a copy of the .mscz). Ask only when opening another score with
  unsaved changes (Save / Don't save / Cancel); no bars or prompts after each change. Keep a silent
  draft so closing the app loses nothing.
- The README must say plainly that notes stay on the device and are not in the file, so people the
  score is shared with won't see them.
- The mixer works as soon as a score is open (sounds load on open, not on Play). The metronome
  starts muted and unmuting it turns the clicks on. Opening a score stops playback.
- Text is sized by dragging the text box corner (no text size buttons).
- The music pauses when the app is left (another app, home screen, screen locked), and the README
  says so; nothing plays on unseen.
- No on-screen playback diagnostics (removed once Android was smooth); use `app.engine.stats`.
- On phones the score's name sits on its own row above the top buttons.
- **Don't clutter the UI, especially on mobile.** New controls that most people won't need every time
  go behind a small button or link (e.g. the sound list's *Several parts*), not as permanent rows.
- **Issues live on GitHub** (`gh issue list`). One commit per issue, `Fixes #N` when it is verified,
  `Refs #N` when it still needs checking on the user's device (e.g. Android playback, picker filters).
- Publish with `npm run build` in `app/` then `bash scripts/deploy-pages.sh`; bump `app/package.json`'s
  version for each release (shown on the start screen and in the mixer's playback check).

## Lessons learnt

- **Touch is not mouse.** A double-tap text box worked with the mouse but vanished on a phone: after a
  finger lifts, the browser sends emulated mouse events that move focus away, and the empty box removed
  itself on blur. Cancel the pointerdown of the second tap. Rule: test touch features with real touch
  input (`Input.dispatchTouchEvent` via CDP, see `scripts/mobile-test.mjs`), not only mouse clicks.
- **Finger drawing on Android needs `touch-action: none` set before the touch starts.** With
  `pan-x pan-y`, Chrome takes the gesture for scrolling and cancels the stroke; `preventDefault` in
  `touchstart` alone is not reliable there.
- **Windows scripting:** Python's `open()` defaults to cp1252, so non-ASCII text (`·`, `…`) silently
  fails to match; always pass `encoding="utf-8"` and normalise CRLF. Long inline heredocs through the
  Bash tool can fail to parse; write the script to the scratchpad and run it.
- **emsdk on Windows** picked the Microsoft Store `python3` stub and emcc was "not found";
  `scripts/env.sh` now sets `EMSDK_PYTHON`.
- **Check layout at every device size, not one.** The notes bar looked fine on a phone and in
  landscape but wrapped Undo/Clear/Done onto their own row on iPad portrait (820 px), leaving big empty
  bands. Rule: lay toolbars out as a grid with an explicit arrangement per width range, and run
  `scripts/layout-shots.mjs` (phone, iPad mini, Air both ways, Pro 13) and look at every shot.
- **Diagnostics must be right on every device.** The playback check said "1002666.7x faster" on
  iPad because Safari's worker timer counts whole milliseconds, so a sub-millisecond block measured 0;
  on Android it showed huge numbers while stopped. Rule: measure only while it matters, over seconds,
  and when the timer is too coarse say so ("under 5%") instead of dividing by almost zero.
- **The cursor must not follow a stepped clock.** On Android the audio clock moves in ~100 ms batches
  (some devices give no output timestamp) and position reports wobble, so the cursor stuttered while
  the sound was fine. Rule: run the cursor on the system clock and pull it gently toward the audio
  clock; test with `scripts/cursor-test.mjs`, which imitates those clocks.
- **Buttons that appear on selection must not move the content.** The text box's move and delete
  buttons sat in the same row as the text, so the text jumped sideways when the box was finished.
  Rule: position such handles outside the content (absolutely), and test that the content's position
  is unchanged before and after selecting.
- **Ask what "save" covers before building it.** A mixer-only Save with a bar after every change was
  not what the user wanted: one Save for everything, asked only when leaving the score. Rule: follow
  the familiar document model (one Save, question on leaving, quiet recovery) unless told otherwise.
- **Two async steps that both touch the same state must be ordered.** Restoring saved settings and
  the engine's "sounds ready" ran side by side; when "ready" came in the middle of the restore, saved
  sound choices were dropped (6 of 9 GODS voices back on MS Basic, "randomly"). Rule: make the later
  step wait for the earlier (`mixLoading`), and reproduce races by slowing one side down in a test
  (`SLOW=1 scripts/reopen-test.mjs`), checking the test fails without the fix.
- **Per-score defaults must be reset per score.** The metronome was "muted by default" only for the
  first score: the engine's `m_metronome` was session-wide, so after unmuting it once every later
  score opened with clicks, and saved settings from older versions replayed it too. Rule: anything
  the user wants "by default" is set in `Session::load` and not restored from saved settings.
- **The device decides, not a web search.** From web reports I told the user iPadOS's photo and
  camera options could not be removed; on their iPad (0.3.2: `accept` with `.mscz` plus generic
  types, and the file input over the Open button instead of `hidden`) Open score already went straight
  to Files. Rule: say "I can't test this here, please check" rather than declaring something
  impossible from secondhand reports. Keep the input over the button, or iPadOS opens its menu
  mid-screen.
- **Never use `confirm()`/`alert()`.** On iPad a system dialog stops the sound; Clear during playback
  left the cursor running in silence. Use the app's own `ask()` dialog, pause when the
  `AudioContext` leaves "running", and never extrapolate a stopped audio clock.
- **Late messages look behind, never ahead.** On iPad the engine's position reports arrive late and
  in bursts; snapping or nudging toward each one made the cursor jerk back and forth. Rule: use the
  upper edge of recent reports, limit corrections per unit of time, and add any newly seen timing
  pattern to `scripts/cursor-test.mjs` before fixing it.
- **Chrome rejects fonts that desktop accepts.** MuseScore's BravuraText.otf fails Chrome's font
  checks, so Paper Hearts' first page (which uses it) was blank on Android, and one failed font
  blocked the whole page. Rule: `scripts/fix-fonts.py` repairs fonts at build time, page drawing
  never waits on a font that fails, and every shipped font is loaded in Chrome when fonts change.
- **A self-check can be fooled by the app's own actions.** On the Pixel the only "sound gaps" were
  jumps while playing: the queue is emptied on purpose and the first fresh block played at once ran
  dry, so the self-check grew the delay for good and told the reader the phone stuttered. Rule: after
  a deliberate flush, refill before playing (`PRIME_FRAMES`) and don't count that refill; test jumps
  as well as steady playback (`android-test.mjs`).
- **Test the phone over USB in the reader's own setting, and leave it as found.** Use the phone's
  Chrome socket (not Playwright's `launchBrowser`, which leaves a file in `/data/local/tmp`), a local
  build on its own origin so the reader's saved data is never touched, the page under test in front,
  and close only your own tabs. Ask the user not to use the phone meanwhile and tell them when it's
  free.
- **An event can be lost when its target is removed.** Pinch zoom rebuilt the pages when the first
  finger lifted; the other finger's touchend went to a removed element, the app counted a finger
  down for good, and page drawing (which waits for fingers) never ran again: blank pages after a
  zoom, "sometimes" (issue #9). Rule: never remove the element under a pointer mid-gesture (finish
  on the last finger), and never let a wait depend on one event arriving.
- **The engine's load path must make every call desktop makes.** Swing markings did nothing
  because our `Session::load` skipped `Score::updateSwing()` (desktop calls it in
  `MasterNotation::setMasterScore`). Rule: when something plays differently from desktop, compare
  our load and playback set-up with desktop's call by call before looking elsewhere.
- **A nearly full system drive breaks browser caching silently** (the 49 MB sound font was not cached,
  so the update test reported a 60 MB download). Check free space before blaming the service worker;
  run browser tests with `TMP`/`TEMP` on a drive with space.
- **A control that rounds must not change what it shows.** Volume sliders count whole percent; touching
  one re-sent the rounded value (and cut +12 dB parts to the slider's +10 dB), so Save lit up with no
  change (issue #5). Rule: until the control moves to another mark, keep the exact stored value; cover
  every source unit's range (desktop saves up to +12 dB).
- **Tests must not trust state left from before the step.** Waiting for `app.state.playbackReady`
  after opening a score passed at once on the previous score's `true`; tapping a fixed screen point
  after the view had followed the playback hit the gap between pages; the status bar coming and going
  above the score moved it mid-gesture. Rule: reset or wait for the new state, compute screen points
  just before using them, and measure layout once the status bar has settled.
- **Every long frame during playback was a page drawing.** Drawing a page at once (100+ ms on a phone)
  froze the playback line at each page turn. Rule: long main-thread work while music plays goes in
  pieces (`pageDrawer`), and `build/jank`-style measurement (long frames vs `performance.measure`)
  finds the cause before guessing.
