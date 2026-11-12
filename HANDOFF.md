# Handoff (12 Nov 2026)

## Where things are
- **Live: 1.0.30**, from `main` (`08e6e97`). Nothing below is merged or published.
- **Branch `voice-metronome`** (`8296c28`): issue #35, Sing it in's metronome. Waits for a real voice and microphone.
- **Branch `bug-hunt`** (made from `voice-metronome`, so it contains #35 too): the record is
  [docs/BUG-HUNT.md](docs/BUG-HUNT.md). 25 findings; fixed: 2 to 15, 18, 19, 21, 22, 23, and the sound queue
  changes for a friend's playback report (25). Not fixed, with reasons, under "Where the fixing stands": 1, 16,
  17, 20, 24. Nine things that could be done better across the codebase are B1 to B9 in the same file.
- The Composer is still hidden on the live site (`?composer` or the dev server shows it).

## Tests run on `bug-hunt` (all on Paper Hearts, phone size, desktop Chromium)
`open-fail-test` (new), `sounds-retry-test` (new), `worklet-burst-test` (new, Node only), `reopen-test`,
`edit-draft-test`, `resume-list-test`, `notes-test` (its two known failures), `update-restart-test`,
`selfcheck-test`. Each new test was seen failing on the old code. Many small fixes are typechecked only; the
record says which under each finding.

## Needs the user or their friend
- The friend's tablet: after a release, play as before and send a new playback report. The queue should start
  at 512 ms, no gap should be logged at Play, and a second visit should start with the queue the first ended on.
- #35 with a real voice; Two pages on iPhone and iPad (1.0.30); nothing here was run on a phone.
- Decisions: merge `bug-hunt` (with or without #35) and release; finding 24 (what notes are pinned to once
  the music can be edited); finding 1 (the update path); which of B1 to B9 to take up (B1 and B2 first).

## Next step
Review `bug-hunt`, then merge and release (bump `app/package.json`, `npm run build` in `app/`,
`bash scripts/deploy-pages.sh`; fetch and reset `build/ghpages` first). Then B2 (an hour) and B1.

## This PC (HOWIE)
Scores in `real test musescores/`; adb is `D:/Android/sdk/platform-tools/adb.exe`; Playwright's browsers in
`D:\ms-playwright`; run browser tests with `TMP`/`TEMP` on D:. The engine is not in git: on another PC,
`source scripts/env.sh; cmake --build build/wasm47; node scripts/copy-engine.mjs`.

## Continuation prompt
"Read HANDOFF.md and docs/BUG-HUNT.md ('Where the fixing stands' and B1 to B9). On branch `bug-hunt`: ask me
whether to merge and release; then narrow `scripts/tests.json` (B2) and start the ScoreSession object (B1),
writing a Node test for the Back-entry accounting before fixing finding 16."
