# Handoff (12 Nov 2026)

## Where things are
- **Live: 1.0.30**, from `main` (`08e6e97`). Nothing below is merged or published.
- **Branch `voice-metronome`** (`8296c28`): issue #35, Sing it in's metronome. Waits for a real voice and microphone.
- **Branch `bug-hunt`** (made from `voice-metronome`, so it contains #35 too): the record is
  [docs/BUG-HUNT.md](docs/BUG-HUNT.md). 26 findings; fixed: 1 to 19, 21, 22, 23, 26, and the sound queue
  changes for a friend's playback report (25). 20 stays as it is (the owner's decision: the `ANDROID`
  check around *Keep playing*'s silent audio); 24 is fixed on its own branch (below). Nine
  things that could be done better across the codebase are B1 to B9 in the same file; B7 is done, B3 is started
  (`app/src/layers.ts`).
- **Branch `notes-follow-edits`** (made from `bug-hunt`, the second PC, 12 Nov): finding 24, the reader's notes
  follow the music when it is edited, as desktop's staff texts do. **It needs an engine built from this branch**
  (`Session::anchorsJson`, and two more values in the timeline): with an older engine the app works as before and
  notes stay where they are. `check-engine.mjs` will refuse to publish without it.
- The Composer is still hidden on the live site (`?composer` or the dev server shows it).

## Tests run on `bug-hunt`
On the first PC (Paper Hearts, phone size, desktop Chromium): `open-fail-test`, `sounds-retry-test`,
`worklet-burst-test` (Node only), `reopen-test`, `edit-draft-test`, `resume-list-test`, `notes-test` (its two
known failures), `update-restart-test`, `selfcheck-test`.
On the second PC, for findings 1, 16, 17 and 26 (I am move it edited, desktop Chromium): new `layers-test`
(Node only), `back-entries-test`, `new-score-key-test`, `update-fail-test` (a production build and a real
service worker); and again `open-fail-test`, `notes-edit-switch-test`, `focus-test` (its known failure),
`tour-test`, `settings-test`, `edit-draft-test`, `resume-list-test`, `new-score-flow-test`,
`new-score-inside-test`, `sounds-retry-test`, `selfcheck-test`, `update-restart-test`. On `notes-follow-edits`,
with the engine built there: new `notepins-test` (Node only), `notes-follow-test`, `notes-oldpins-test`; and again
`notes-test` (its two known failures), `notes-views-test`, `notes-align-test`, `no-change-test`, `edit-draft-test`,
`new-score-flow-test`, `new-score-key-test`, `notes-edit-switch-test`. Each new test was seen
failing on the old code. Many of the first day's small fixes are typechecked only; the record says which.

## Needs the user or their friend
- The friend's tablet: after a release, play as before and send a new playback report. The queue should start
  at 512 ms, no gap should be logged at Play, and a second visit should start with the queue the first ended on.
- The phone's own Back button on a real phone (finding 16: the Mixer with a part's sound list open, then the
  Mixer button, then Back should leave the app at the first press), and an update arriving on a poor connection
  (finding 1): both were tested in desktop Chromium only.
- #35 with a real voice; Two pages on iPhone and iPad (1.0.30); nothing here was run on a phone or in Safari.
- Notes following edits with a finger or a stylus on a phone or tablet (tested with a mouse in desktop Chromium),
  and `compare-engines.mjs` for the new engine build (it needs the first PC's score folder).
- Decisions: merge `bug-hunt` (with or without #35) and release; merge `notes-follow-edits` after it; which of
  B1 to B9 to take up (B1 and B2 first).

## Next step
Review `bug-hunt`, then merge and release (bump `app/package.json`, `npm run build` in `app/`,
`bash scripts/deploy-pages.sh`; fetch and reset `build/ghpages` first). Then B2 (an hour) and B1.

## The PCs
- **HOWIE:** scores in `real test musescores/`; adb is `D:/Android/sdk/platform-tools/adb.exe`; Playwright's
  browsers in `D:\ms-playwright`; run browser tests with `TMP`/`TEMP` on D:.
- **The second PC** (no D: drive): scores in `real test musescore files/`, without Paper Hearts, so pass
  `I am move it edited.mscz` (or the folder) to tests that default to it. Its local branches mirror GitHub.
- The engine is not in git: on another PC, `source scripts/env.sh; cmake --build build/wasm47; node
  scripts/copy-engine.mjs`.

## Continuation prompt
"Read HANDOFF.md and docs/BUG-HUNT.md ('Where the fixing stands' and B1 to B9). On branch `bug-hunt`: ask me
whether to merge and release, then whether to merge `notes-follow-edits` (build its engine first); then narrow `scripts/tests.json` (B2) and start
the ScoreSession object (B1)."
