# Composer like Flat (#33), branch `composer-flat` (14 Nov 2026): first part done, pushed, not merged to main

**Done on this branch, working, not merged to `main` and not published** (details in [docs/COMPOSER.md](docs/COMPOSER.md), phase 5):
the bottom sheet with the lengths, the rest key, **Chord** and the **piano strip** (a key puts its note at the
picked place and moves on, as desktop's piano keyboard; a too-long note is tied over the barline), and **one line
at a time** on phones with the lines button (*All lines* and each line). The letters row and More's *Add to chord*
are gone (A to G still work on a keyboard). On a phone the picked note's name has a line of its own (the bar no
longer changes height with the words), and the piano makes way while More is open. The tour and the README are
updated. The engine has three new functions (`mss_edit_enter_pitch`, `mss_edit_show_part`, `mss_edit_parts`): it
was built on the second PC on 14 Nov; **the first PC must build it from this branch** before running or publishing.

**Tests run (second PC, desktop Chromium, phone size unless said):** `step-entry-test` (rewritten for the piano;
read back by desktop MuseScore), new `parts-view-test` (phone, one-line score, tablet), `piano-strip-test`
(Codex's, reviewed and corrected), and once each the tests whose letter buttons became piano keys: `edit-test`,
`edit-more-ui-test`, `composer-tools-test`, `range-copy-test`, `new-score-flow-test`, `new-score-inside-test`,
`new-score-key-test`, `resume-list-test`, `edit-layout-test` (7 sizes). All pass. `new-score-inside-test` threw
`RuntimeError: null function` once and passed on the next run (COMPOSER.md has that error as the dev server
reloading; not seen again).

**Not tested:** any real device (Android, iPhone, iPad), Safari, the piano under real fingers, a score with a
transposing instrument, a score with multi-bar rests saved while one line shows, notes written with Notes on a
score while one line shows (they are pinned by staff: a note on a hidden line is placed by its system).
A 320 x 640 phone has about 100 px of music left in Edit.

**Still to do for #33** (from docs/FLAT-STUDY.md section 14, none agreed in detail yet): More's groups as a
category strip with headed grids, the floating bar on a held note, a bar added when the last one is filled,
taps on the tempo, time signature or clef, reasons on dimmed buttons, picture buttons in New score.

# Handoff (12 Nov 2026)

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

## Checked by the owner, and what waits
- **The Back button is fine** on the owner's phone in 1.0.31 (finding 16; 12 Nov 2026).
- **Playback (the friend's tablet, finding 25) counts as fixed** until another report comes in (the owner, 12 Nov
  2026): don't ask for a new report. If one comes: the queue should start at 512 ms, no gap should be logged at
  Play, and a second visit should start with the queue the first ended on.
- **Waiting until the Composer is finished** (the owner will test them then, or report if something shows up
  earlier): #35 with a real voice; notes following edits with a finger or a stylus, with a line added above a
  note, and with a stroke over several bars that end up on two lines or lose some of their bars (written, not
  tested in a browser).
- Not run on any device: an update arriving on a poor connection (finding 1, desktop Chromium only); Two pages on
  iPhone and iPad; nothing in 1.0.31 was run in Safari.
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
