# Handoff (18 Nov 2026)

## Released: 1.0.32 on 23 Nov 2026 (the buffer player is the default, Sound delay in Settings), from `main`
Published with this PC's `deploy-pages.sh`; the engine is the live 1.0.31 one copied from `gh-pages` (identical bytes, no engine change; this PC's old engine is in `build/engine-backup-23nov`). The user asked for the release without checking iPad and iPhone: **a report from either is still the first thing to look for.** `buffer-player` is merged and deleted.

## The Bluetooth crackle (23 Nov 2026)
- **Proven on the Pixel 9a + AirPods:** blind A/B of PocketScore itself, 3 rounds: worklet bad x3 (1 gap counted each),
  buffer player clean x3 (0 gaps). The user then used the buffer player freely, in a Chrome tab and as an installed
  copy (127.0.0.1:4173 installed as a second home-screen app), and heard no stutter.
- **Changed on the branch:** the buffer player is the default (`?player=worklet` for the old one); a new **Sound delay**
  setting (Settings > Playback, default 0, `engine.extraLatency`), with its README row and tour wording. Scripts:
  `android-bt-delay-tune.mjs` (user taps Earlier/Later on the phone), `android-bt-player-ab.mjs` now passes
  `?player=worklet` for the worklet. Typecheck and `chunk-player-test` pass on the PC.
- **Sound delay findings:** Android says 230 ms for the A2DP path; Chrome's `outputLatency` with "playback" is 344-648 ms;
  the user's pick was -200 ms but they couldn't tell it from 0, so the default stays 0. A microphone loopback is not
  possible (opening the mic switches the AirPods to `bt_sco`). Details: `docs/DEVELOPMENT.md`.
- **Next:** (1) the user checks iPad and iPhone by hand with this build (scheduling buffer sources there is untested);
  (2) done: released as 1.0.32;
  (3) optional: log the time of each sound gap, to see whether one gap per worklet segment is the start of play or the crackle.
- **Not tested:** screen off, walking, iPhone, iPad, Safari, other earbuds or phones, a main thread frozen longer than the queue.

## Older state (12 Nov 2026)
## Where things are
- **Live: 1.0.31**, from `main`. It holds everything that was on `voice-metronome` (issue #35, Sing it in's
  metronome), `bug-hunt` and `notes-follow-edits`; those branches have nothing more than `main`.
- **The bug hunt** (its record, `docs/BUG-HUNT.md`, was deleted on 24 Nov 2026 at the owner's request; the fixes stay in the code, marked "bug hunt, finding N"): 26 findings, all fixed except 20, which stays as it is
  by the owner's decision (the `ANDROID` check around *Keep playing*'s silent audio). Finding 24 (the reader's
  notes follow the music when it is edited, as desktop's staff texts do) needed an engine change
  (`Session::anchorsJson`, and two more values in the timeline). The list of nine possible clean-ups (B1 to B9) went with the file.
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
seen failing on the old code. Many of the bug hunt's small fixes were typechecked only.

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
(The 12 Nov continuation prompt, about the clean-ups B1 to B9, is gone with docs/BUG-HUNT.md.)

## Continuation prompt (Bluetooth)
"Read HANDOFF.md and docs/DEVELOPMENT.md (*Open: crackle over Bluetooth*). On branch `buffer-player`, run the
blind A/B `scripts/android-bt-player-ab.mjs` on the Pixel with the AirPods connected to the phone, and decide
whether `?player=chunk` becomes the default."
