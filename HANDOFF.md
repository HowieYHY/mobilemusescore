# Handoff (3 Nov 2026, branch `composer`)

## Done (all on branch `composer`, see docs/COMPOSER.md for the design)
- Phase 1-2: Edit mode (select, move, pitch, length, delete, undo, Save a copy), note letters, silent edit drafts.
- Voice to notes (single voice; only tested on a synthetic voice, not a real mic).
- New score from the start screen (any number of named lines, clef, key, time, tempo, bars); unsaved new scores are offered as *Continue*.
- **Phase 3 "More"** (three dots in the edit bar): sing it in, sharp/flat/natural, tie, triplet, add to chord, dynamics, words above, lyrics, key and time from the picked bar, add bars, rename line, add line. First-tap sound fix. Pen Notes stay read-only-mode only (Edit closes them).
- Tests passing on desktop Chromium: edit-more-test, edit-more-ui-test (new, read back through desktop MuseScore), edit-test, edit-layout-test, voice-edit-test, new-score-flow-test. Recorded with `node scripts/tests.mjs record`.

## Not tested / needs the user
- Real microphone singing; a phone, iPhone and iPad (nothing run there for the new features); hearing a newly added line (the engine lists its track, the sound itself was not listened to); the first-tap sound fix on a device; the More panel on a real 320 px phone.

## Remaining ideas
- Hear the other lines while recording; New score from inside an open score; clef/sound of an existing line; multi-voice voice-to-notes; More panel is tall on a short phone (scrolls at 40% height).
- Sounds picked in the mixer go back to the score's when a line is added or undone (`rebuildPlayback`).

## Next step
User tries it on localhost (`cd app && npx vite --port 5180 --host 127.0.0.1`), reports problems; then decide when to merge `composer` and release (bump `app/package.json`).

## Important
- **The engine is not in git.** On another PC: `source scripts/env.sh; cmake --build build/wasm47; node scripts/copy-engine.mjs` (new engine functions `mss_edit_*` are needed or the app falls back / fails).
- Branch `composer` is pushed but not merged to `main`; nothing is published (no deploy).

## Continuation prompt
"Read HANDOFF.md and docs/COMPOSER.md. Rebuild the engine on this PC, run `node scripts/tests.mjs which`, then continue with the user's feedback on the Edit 'More' panel."
