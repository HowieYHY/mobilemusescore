# PocketScore: notes for Claude

Read [README.md](README.md) (user guide) and [docs/DEVELOPMENT.md](docs/DEVELOPMENT.md) (architecture,
build, tests, status) before working here.

## Standing requirements

- The user works from several machines. Commit and push when they say the session is ending, after
  updating the README and DEVELOPMENT.md so each is one current picture, not a log.
- Their test scores are in `real test musescores/` (gitignored, copied by hand between machines),
  with desktop MP3 exports in `real test musescores/audio equivalents/`. Run the tests on every score.
- Android gets the **installable web app from Chrome**, not an APK (the Capacitor project was removed
  in 0.2.0). iPad/iPhone use Safari's Add to Home Screen. One web app, one update path.
- Match desktop MuseScore 4.7.5 where there is a desktop equivalent (sound menu, sound names, mixer
  rules); read its source in `third_party/musescore-4.7` rather than guessing.
- Mixer volume is shown as loudness in % against the score's own setting (100% = as saved); the user
  asked for this over dB.
- Notes: black is the default colour; double-tap adds a text box, one tap outside finishes it;
  *Draw with finger* is a visible switch for people without a stylus.
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
- **A nearly full system drive breaks browser caching silently** (the 49 MB sound font was not cached,
  so the update test reported a 60 MB download). Check free space before blaming the service worker;
  run browser tests with `TMP`/`TEMP` on a drive with space.
