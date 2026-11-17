# Handoff (18 Nov 2026)

## Latest: the Bluetooth crackle, branch `buffer-player` (not merged, nothing published)
- **Found:** over the user's AirPods on the Pixel 9a, Chrome's **AudioWorklet output crackles** (blind listening
  tests: even a worklet that only copies memory), while buffer sources are clean. PocketScore plays through a
  worklet. Other apps and PocketScore on the speaker are clean. Full record, numbers and what I got wrong on the
  way: `docs/DEVELOPMENT.md`, *Open: crackle over Bluetooth*; lessons in `CLAUDE.md`.
- **Built:** `?player=chunk` (`app/src/engine/chunkplayer.ts`, wired in `engine.ts`): the same audio worker,
  played as buffer sources scheduled back to back. Default is still the worklet. `chunk-player-test.mjs` passes
  for both players on desktop (and fails on a deliberately broken flush).
- **Not done:** the blind A/B of PocketScore itself over the AirPods, `scripts/android-bt-player-ab.mjs`. The user
  paused it to push the branch. Setup: `cd app && npm run build && npx vite preview --host --port 4173`,
  `adb reverse tcp:4173 tcp:4173`, the AirPods connected to the **phone**, screen on, no other Chrome tab using the
  camera, phone cool (`dumpsys thermalservice`). The user taps Clean / Slight / Bad after each of 6 segments.
- **Then decide:** buffer player clean 3 times and worklet not -> make it the one player for every platform (one
  code path), after the user checks iPad and iPhone by hand; otherwise the branch stays a flag.
- **Not tested:** screen off, walking, iPhone, iPad, Safari, other earbuds or phones, a main thread frozen longer
  than the queue (the buffer player schedules from the main thread).
- Scripts for the phone (read-only, no taps): `android-bt-earlyplay-test`, `-soak`, `-watch`, `-player-ab`;
  tone pages in `scripts/bt-blind-test/`.
- The Gesture Synth repo is cloned beside this one (`d:\cloned repos\gesture-synth`); its tab held the phone's
  camera open and loaded the phone during the first tests.

## Older state (12 Nov 2026)
## Where things are
- **Live: 1.0.31**, from `main`. It holds everything that was on `voice-metronome` (issue #35, Sing it in's
  metronome), `bug-hunt` and `notes-follow-edits`; those branches have nothing more than `main`.
- **The bug hunt** ([docs/BUG-HUNT.md](docs/BUG-HUNT.md)): 26 findings, all fixed except 20, which stays as it is
  by the owner's decision (the `ANDROID` check around *Keep playing*'s silent audio). Finding 24 (the reader's
  notes follow the music when it is edited, as desktop's staff texts do) needed an engine change
  (`Session::anchorsJson`, and two more values in the timeline). Nine things that could be done better across the
  codebase are B1 to B9 in the same file; B7 is done, B3 is started (`app/src/layers.ts`, `app/src/notepins.ts`).
- **The engine that is live was built on the second PC** from `main`, and compared with the 1.0.30 one on that
  PC's five scores (`compare-engines.mjs`: drawings, timelines, staves, info and audio identical). The first PC
  must build the engine from `main` before it publishes again, or `check-engine.mjs` refuses (`mss_anchors`).
- The Composer is still hidden on the live site (`?composer` or the dev server shows it).

## Tests run for 1.0.31 (desktop Chromium)
On the first PC (Paper Hearts, phone size): `open-fail-test`, `sounds-retry-test`, `worklet-burst-test` (Node
only), `reopen-test`, `edit-draft-test`, `resume-list-test`, `notes-test` (its two known failures),
`update-restart-test`, `selfcheck-test`.
On the second PC (I am move it edited, or its whole score folder): new `layers-test` and `notepins-test` (Node
only), `back-entries-test`, `new-score-key-test`, `update-fail-test` (a production build and a real service
worker), `notes-follow-test`, `notes-oldpins-test`; and again `open-fail-test`, `notes-edit-switch-test`,
`focus-test` (its known failure), `tour-test`, `settings-test`, `edit-draft-test`, `resume-list-test`,
`new-score-flow-test`, `new-score-inside-test`, `sounds-retry-test`, `selfcheck-test`, `update-restart-test`,
`notes-test` (its two known failures), `notes-views-test`, `notes-align-test`, `no-change-test`. Each new test was
seen failing on the old code. Many of the bug hunt's small fixes are typechecked only; the record says which.

## Needs the user or their friend
- The friend's tablet: play as before and send a new playback report. The queue should start at 512 ms, no gap
  should be logged at Play, and a second visit should start with the queue the first ended on.
- The phone's own Back button on a real phone (finding 16: the Mixer with a part's sound list open, then the
  Mixer button, then Back should leave the app at the first press), and an update arriving on a poor connection
  (finding 1): both were tested in desktop Chromium only.
- #35 with a real voice; Two pages on iPhone and iPad; nothing in 1.0.31 was run on a phone or in Safari.
- Notes following edits with a finger or a stylus (tested with a mouse), a line added above a note, and a stroke
  over several bars that end up on two lines or lose some of their bars (written, not tested in a browser).
- Decisions: which of B1 to B9 to take up (B1 and B2 first).

## Next step
B2 (narrow `scripts/tests.json`, an hour), then B1 (the ScoreSession object).

## The PCs
- **HOWIE:** scores in `real test musescores/`; adb is `D:/Android/sdk/platform-tools/adb.exe`; Playwright's
  browsers in `D:\ms-playwright`; run browser tests with `TMP`/`TEMP` on D:.
- **The second PC** (no D: drive): scores in `real test musescore files/`, without Paper Hearts, so pass
  `I am move it edited.mscz` (or the folder) to tests that default to it; `compare-engines.mjs` takes the folder
  as its third argument. Its local branches mirror GitHub.
- The engine is not in git: on another PC, `source scripts/env.sh; cmake --build build/wasm47; node
  scripts/copy-engine.mjs`.

## Continuation prompt
"Read HANDOFF.md and docs/BUG-HUNT.md (B1 to B9). On `main`: if this PC has not built the engine since 12 Nov
2026, build it first. Then narrow `scripts/tests.json` (B2) and start the ScoreSession object (B1)."

## Continuation prompt (Bluetooth)
"Read HANDOFF.md and docs/DEVELOPMENT.md (*Open: crackle over Bluetooth*). On branch `buffer-player`, run the
blind A/B `scripts/android-bt-player-ab.mjs` on the Pixel with the AirPods connected to the phone, and decide
whether `?player=chunk` becomes the default."
