# Handoff (11 Nov 2026, late: 1.0.30 published from branch `two-pages-view`)

## Newest: 1.0.30 is live, Two pages without the Composer
- **Published from `two-pages-view`, not from `main`** (the user: "push this branch to live"). `main` is still
  1.0.29, so publishing from `main` on any PC would take Two pages off the site again. Open question for the
  user: merge `two-pages-view` into `main`?
- **The Composer is hidden in the published app** (the user's choice: it was never tried on devices): `composer`
  in `app/src/main.ts` is true only on the dev server or with `?composer` in the address; CSS `.no-composer`
  hides Edit, New score and Continue, edit drafts aren't offered, the tour skips its step. README sections
  carry a "Not in the published app yet" note. To publish it: make `composer` true, drop the notes.
- **Two pages as the user asked after trying it on the Pixel:** Focus starts with the view; the pages are a
  row 4 px apart at every zoom with the two in the middle of the screen (`PAIR_GAP`, padded row ends), the
  pages before and after showing at the sides on a wide screen; a swipe slides one page. Arrow keys now turn
  in Focus. Turning the screen keeps the page on short scores too (`lastTurned`).
- **Also fixed:** from Page view, Page by page and Two pages open on the first page showing whole
  (`pageInView`), not the one at the middle (landscape pages on a phone opened on page 2).
- **Testing rule changed** (CLAUDE.md): bare minimum, the user checks themselves.
- **Run after the last changes:** `pagepair-test` at 915x412 on Paper Hearts, 2002 v3 and Dream a little dream;
  a check that the built app hides the Composer and shows Two pages. **Not run:** iPad size, `pageturn-test`,
  `settings-test` (opening straight into Two pages now starts Focus), `android-pagepair-test.mjs` (new,
  rewritten for the Focus flow, never run in that form). The user tried the view on their Android and was
  happy; iPhone and iPad are untried.
- **This PC (HOWIE):** scores are in `real test musescores/`; adb is `D:/Android/sdk/platform-tools/adb.exe`
  (pass `ADB=`); Playwright's browsers are in `D:\ms-playwright` (the C: folder is a junction to it).
- Open: is #34 done (commit says `Refs #34`)? #33, #18, #3.

## Earlier the same day (branch `two-pages-view`, made from `composer`)

## Latest session (11 Nov 2026): issue #34, the *Two pages* view. Built, tests paused part-way
Branch `two-pages-view` = `composer` plus the composer work that was still uncommitted on this PC plus #34, in one
commit (the two could not be split: both change `app/src/main.ts`). Not merged, not published, version not bumped.

**What was built** (details in docs/DEVELOPMENT.md, row "Two pages (issue #34)"; user guide in the README):
- View menu and Settings' *Open scores in* have **Two pages** (`page_pair`): two pages side by side, a swipe or
  arrow key moves on **one** page (1-2, 2-3, 3-4; the right page goes to the left), as the issue asks.
- The user then asked for both ways (mid-session): Settings > View > **Two pages: a swipe turns both**
  (`pairSwipeTwo`, off by default) makes a swipe go 1-2, 3-4, 5-6.
- "Forces landscape": `keepSideways` asks `screen.orientation.lock("landscape")` while the view shows and unlocks
  after. Browsers allow that only in the installed app or in full screen (Focus button); iPhone/iPad can't be
  asked at all, so upright a line says *Turn your device on its side to read two pages*.
- It is Page by page's code with two slots per screen (`span`), not a second copy. Two fixes reach Page by page
  too: quick repeated arrow keys no longer lose steps, and following the music waits for a turn to land.
- Tour text (Views step), README, DEVELOPMENT.md, `scripts/tests.json` updated. New test `scripts/pagepair-test.mjs`.

**Test state when the user paused the round:**
- `pagepair-test` on "I am move it edited": all checks passed at phone-on-its-side (915x412) and iPad landscape
  (1180x820), after the last code change.
- "Cheap Thrills": iPad size passed; `pageturn-test` passed. Its phone-size run failed once at the very end
  (see next point). The other three scores were not rerun after the last two code changes (before them they
  passed at phone size and failed only the since-fixed "playing into page 3" check at iPad size).
- **Unexplained, look at this first:** twice a run lost the score mid-test (the page was back on the start
  screen: no pages, view menu disabled), once in the "swipe turns both" part and once in the upright part. The
  same score and size passed when run again. Not known whether the dev server reloaded the page (files were
  being edited / other runs going at the time) or the app did it. Rerun with nothing else touching `app/`;
  if it comes back, log `beforeunload` and vite's reload messages in the test.
- Not run yet after this change: `goto-test`, `scroller-test`, `tour-test`, `settings-test` (its defaults line
  was updated for `pairSwipeTwo`), `pageturn-test` on the other four scores and at iPad size,
  `layout-shots`. Nothing recorded in the ledger (`node scripts/tests.mjs record pagepair-test pass|fail`).
- **Needs the user's devices:** whether Android really turns the screen (installed app; Chrome tab + Focus),
  and the view on an iPhone/iPad. The orientation request is only checked with a stand-in on the PC.
- On this PC pass scores from `real test musescore files/` (the tests' default folder name isn't here).

**Open questions for the user:** is Settings the right place for "a swipe turns both" (they said "toggled"; a
second menu entry or a button in the view would be the alternatives)? Should the issue be closed with `Fixes #34`
once they have tried it on the phone (this commit says `Refs #34`)?

**Other open issues:** #33 (Composer should look and work like the Flat app; the user will give access to their
Android to explore it), #18, #3.

**Left out of the commit on purpose:** `app/android/` (untracked leftover of the removed Capacitor project) and
the changes inside the `third_party` submodules.

# Earlier handoff (3 Nov 2026, branch `composer`)

## Done (all on branch `composer`, see docs/COMPOSER.md for the design)
- Phase 1-2: Edit mode (select, move, pitch, length, delete, undo, Save a copy), note letters, silent edit drafts.
- Voice to notes (single voice; only tested on a synthetic voice, not a real mic).
- New score from the start screen (any number of named lines, clef, key, time, tempo, bars); unsaved new scores are offered as *Continue*.
- **Phase 3 "More"** (three dots in the edit bar): sing it in, sharp/flat/natural, tie, triplet, add to chord, dynamics, words above, lyrics, key and time from the picked bar, add bars, rename line, add line. First-tap sound fix. Pen Notes stay read-only-mode only (Edit closes them).
- Tests passing on desktop Chromium: edit-more-test, edit-more-ui-test (new, read back through desktop MuseScore), edit-test, edit-layout-test, voice-edit-test, new-score-flow-test. Recorded with `node scripts/tests.mjs record`.

## Not tested / needs the user
- Real microphone singing; a phone, iPhone and iPad (nothing run there for the new features); hearing a newly added line (the engine lists its track, the sound itself was not listened to); the first-tap sound fix on a device; the More panel on a real 320 px phone.

## Remaining ideas
- Hear the other lines while recording; clef/sound of an existing line; multi-voice voice-to-notes; More panel is tall on a short phone (scrolls at 40% height).
- Sounds picked in the mixer go back to the score's when a line is added or undone (`rebuildPlayback`).

## Next step
User tries it on localhost (`cd app && npx vite --port 5180 --host 127.0.0.1`), reports problems; then decide when to merge `composer` and release (bump `app/package.json`).

## Important
- **The engine is not in git.** On another PC: `source scripts/env.sh; cmake --build build/wasm47; node scripts/copy-engine.mjs` (new engine functions `mss_edit_*` are needed or the app falls back / fails).
- Branch `composer` is pushed but not merged to `main`; nothing is published (no deploy).

## Continuation prompt
"Read HANDOFF.md (top section first), docs/DEVELOPMENT.md's 'Two pages' row and docs/COMPOSER.md. Check out
`two-pages-view`, rebuild the engine on this PC, start the dev server, finish the paused test round for issue #34
(`pagepair-test` and `pageturn-test` on every score at phone and iPad sizes, then goto, scroller, tour, settings
tests; look into the page that lost its score mid-test), record the results, and tell the user what to try on
their phone. After that: the user's feedback on the Edit 'More' panel, and issue #33."
