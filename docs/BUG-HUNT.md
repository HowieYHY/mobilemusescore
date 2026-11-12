# Bug hunt (started 12 Nov 2026, branch `bug-hunt`, made from `voice-metronome`)

The user asked for a read-through of the code for hidden bugs: **diagnose first, record each finding the
moment it is found, fix only once the reading is done.** A session can stop at any time (usage limit), so this
file is the record. Nothing here is fixed unless its line says so.

Each finding: where, what goes wrong and when, how sure (**proved** = reproduced or measured, **read** = from
reading the code only), and the fix proposed.

## Progress (what has been read)

- [x] `app/public/sw.js`
- [x] `app/src/editdraft.ts`, `mixerstore.ts`, `settings.ts`, `playlog.ts` (nothing found); `firsttime.ts` not read
- [x] `app/src/engine/core.worker.ts`, `engine.ts`
- [x] `app/src/render/pagerenderer.ts`, `newscore.ts` (nothing found there); `musicmap.ts` (nothing found); `typing.ts`, `tour.ts` not read
- [x] `app/src/voice/transcribe.ts` (nothing found)
- [ ] `app/src/annotations.ts` (only the storage part, lines 254-478, read)
- [ ] `app/src/main.ts` (in parts). Read so far: 118-1625 (pages, tiles, zoom, pinch, taps, scroll handle, cursor, playback log: nothing found beyond 8), 2960-3290 (save, ask, opening, changeView), 3415-3665 (updates, restart, shared file), 3884-3960 and 4228-4565 (Edit: selection, runEdit, drafts, keys, Save a copy), 2095-2335 (Back-button layers, Focus), 4958-5128 (New score, Continue, website preview), 1625-1775 (wake lock, keep playing, Play), 2874-2960 (mixer restore and save: nothing found), 1774-2095 (seek, mixer, sound list), 3960-4170 (Edit's More tools), 2420-2855 (speed, loop, go to bar, panels, Settings: nothing new), 3290-3420 (Two pages: turning, swipes). Checked across all of `app/src`: no text from a score (title, part and sound names) is put into the page as HTML; it all goes through `textContent`
- [ ] `engine/core/session.cpp`: only `Session::load` read. The rest (3,100 lines of C++, the edit functions above all) is **not read**; a bug there needs an engine build to confirm
- [ ] **Not read:** `annotations.ts` drawing and text boxes (478-1071), `main.ts` 2362-2420, 3665-3884 (install, notes bar), 4170-4228, 4852-4958, the tour, `typing.ts`, `firsttime.ts`, the audio worker and worklet in `app/public/worklet`, `scripts/`

## Findings

### 1. An update on a bad connection can leave the app unable to open offline (`app/public/sw.js`, install + activate) — read, medium

`install` swallows every failed file ("the fetch handler fills gaps later") and still finishes; `activate`
then deletes every older cache. If a file fails during an **update** (connection drops while the 49 MB sound
font or the engine downloads, or a response is not `ok`), the new version takes over with that file missing
and the old complete copy is gone. The app then needs the network for that file; offline, the score opens
without sound or the engine does not start. Before the update it worked offline.
**Fix proposed:** count the files that could not be stored; if any are missing, throw from `install` so the
old service worker and its cache stay, and the browser tries again on the next visit. (First install: same,
the page still works from the network.)

### 2. The cache key for an address with `?…` is built wrongly (`app/public/sw.js` fetch handler) — read, low

`key = url.href + "index.html"` when the path ends in `/`, but `href` includes the query, so `./?shared=1`
gives `…/?shared=1index.html`. It works only by accident: `ignoreSearch` makes the lookup a miss, the network
answers, and offline the `navigate` fallback serves the shell. A side effect: the network's copy of the page is
stored under that odd key and is then served for every later `/?…` visit of this version.
**Fix proposed:** build the key from `url.origin + url.pathname` (+ `index.html`).

### 3. If the sounds fail to load once, they never load again until the app is restarted (`app/src/engine/engine.ts` `startAudio`) — read, medium

`audioStarting` is set once and kept even when it rejects (the 49 MB sound font download drops on mobile data,
or the worklet module fails to load). Every later `startAudio()` (each Play, each score opened) returns the
same rejected promise, so the reader sees "Audio failed to start" and Play can never work again in this
visit; only closing and reopening the app helps, and nothing says so.
**Fix proposed:** when the failure happens before the ports are handed to the audio worker (the fetch and
`addModule` stage), close the context and clear `audioStarting`, `ctx` so the next Play tries again; say
"Couldn't load the sounds. Check the connection and tap Play again."

### 4. A worker call that throws leaks the strings passed to it (`core.worker.ts` `callStr`/`callVoid`, and `load`'s temp file) — read, low

`_free` runs after the call, not in `finally`; `load` unlinks the score file only when `mss_load` returns.
Each throw leaks a few bytes (or the whole score file in the engine's memory file system, until a file of the
same name is opened). Only matters after engine errors. **Fix proposed:** `try/finally`.

### 5. A font that fails to load once is never tried again (`app/src/render/pagerenderer.ts` `ensureFonts`) — read, medium-low

`fontLoads` keeps the promise of a failed load, so the same font is not asked for again in this visit. If the
music font (Bravura/Leland) fails once (a blip on the first visit, before the offline copy exists), every page
drawn afterwards has no noteheads or clefs until the app is reloaded, and nothing tells the reader.
**Fix proposed:** on failure, take the entry out of `fontLoads` so the next page drawn asks again.

### 6. Decoded pictures are kept for the whole visit (`pagerenderer.ts` `images`) — read, low

The map is keyed by the picture's whole data URL and never emptied, so opening several scores with pictures
keeps every picture (and its text copy) in memory. **Fix proposed:** clear it when a score is opened.

### 7. Sing it in: a recording that ends late can land in the next session of the dialog (`main.ts` `voiceRecord` `rec.onstop`) — read, low

Closing the dialog while recording stops the microphone tracks, and the recorder's `stop` event comes a moment
later. If the dialog is opened again (or a new recording started) before it comes, the old handler sees the
dialog open and processes the old recording, and its `voiceReleaseMic()` ends the new recording's microphone
and metronome. **Fix proposed:** give each recording the `voice.token` it started with and ignore its `stop`
when the token has moved on; also release the stream if `new MediaRecorder` throws.

### 8. A page tile whose drawing failed stays blank while it is near the view (`main.ts` `renderTile`, `drawJobs`) — read, low

When the page's drawing commands can't be fetched (`pageOps` rejects) or a draw throws, the tile's key stays in
`state.rendered`, so nothing draws it again until it has been scrolled far away and back.
**Fix proposed:** take the key out of `state.rendered` on both failures and try again after a moment (as the
"no canvas memory" path already does).

### 9. Opening a file that can't be read leaves the previous score on screen but half disconnected (`main.ts` `openScore`) — read, **medium-high; the engine side is confirmed**: `Session::load` (`engine/core/session.cpp:454`) drops the open score (`m_project.reset()`) before it tries the new file, and refuses files from a newer MuseScore (`ignoreVersionError` false), so this is what happens when someone opens a score saved by a newer MuseScore while another is open

Before the engine has accepted the new file, `openScore` already: sets `state.scoreKey` to the new file's key,
replaces `openedScore` (used to reopen after an update), empties `mix` (`store: null`), sets
`playbackReady = false`, disables the Mixer button and clears the cached page drawings. If `engine.load` then
fails ("Could not open this score": a damaged file, a draft that can't be read), it returns with the old score
still showing: the Mixer button stays disabled, mixer changes are no longer kept, edit drafts would be written
under the wrong score's key, an update restart reopens the bad file, and if the engine dropped the old score on
the failed load, Play and page drawing fail too.
**Fix proposed:** do nothing to the app's state until `engine.load` succeeded (work out the key, look for the
draft and ask first, load, then switch everything over); if the engine no longer holds the old score after a
failure, go back to the start screen with the message.

### 10. "Don't save" / "Don't keep" is carried out before the new file is known to be a score (`main.ts` `openChosen` → `openScore`) — read, medium-low

`openChosen` asks about unsaved notes, mixer changes and edits and discards them (`discardAll()`,
`editDraft.remove`) before `openScore` checks the name (`"…" is not a MuseScore file`) or the engine tries the
file. Picking a PDF by mistake, or a damaged file, after answering "Don't save" throws the unsaved notes away
while the old score stays open. **Fix proposed:** check the name before asking; discard only once the new score
has loaded.

### 11. Dismissing "Continue your edits?" with Back or Escape deletes the edits (`main.ts` `openScore`, with `ask`) — read, medium

`ask` resolves `"cancel"` when the dialog is dismissed. The question has only *Start again* and *Continue my
edits*, and the code treats anything but `"continue"` as *Start again*: `await editDraft.remove(key)`. So the
phone's Back button, Escape, or anything else that closes the dialog throws away the unsaved edits for good.
**Fix proposed:** on `"cancel"` stop opening and keep the draft (possible once finding 9's reordering is done);
only the *Start again* button deletes.

### 12. A discarded edit draft can come back (`main.ts` `saveEditDraft` against `openChosen`'s "Don't keep") — read, low

`saveEditDraft` waits for the engine to write the score, then stores it if `edit.dirty` is still true and the
score key is unchanged. "Don't keep" removes the draft, but `edit.dirty` stays true and the key unchanged until
the new score is loaded, so a draft save already under way (started by the 800 ms timer or by leaving the app)
puts the draft back after it was removed. Next time that score is opened it asks "Continue your edits?".
**Fix proposed:** set `edit.dirty = false` when the reader chooses "Don't keep" (before removing the draft).

### 13. Restarting into an update does not wait for the edit draft (`main.ts` `restartForUpdate`) — read, low

When the app goes to the background with an update ready, the same `visibilitychange` starts
`saveEditDraft()` (not awaited) and `restartForUpdate()`, which reloads the page. If the last edit was made
under a second before (Edit already closed with Done), the reload can come before the draft is stored, and
that edit is lost. Mixer changes are handled (their draft is written first); edits are not.
**Fix proposed:** `await saveEditDraft()` in `restartForUpdate` before reloading.

### 14. An update reloads the start screen at once, whatever is open on it (`main.ts` `controllerchange`) — read, low

With no score open the page reloads immediately when an update is installed, without `quietForUpdate()`: a
New score dialog being filled in, the Settings panel or the tour closes under the reader's finger.
**Fix proposed:** use the same quiet-moment rule there (no dialog, panel or tour open).

### 15. *Continue* deletes a new score's draft even when it could not be opened (`main.ts` `continueDraft`) — read, medium-low

`openChosen` returns `true` whenever the reader did not cancel, also when `openScore` then failed to load the
file. `continueDraft` takes `true` as "opened" and runs `editDraft.remove(key)`: a draft that fails to load
once is gone for good. The same wrong reading in New score (`ns-create`): after a failed load with another
score open, `state.score` is still the old score, so `beginFresh()` marks that one as a new unsaved score.
**Fix proposed:** `openScore` returns whether it loaded; `openChosen` passes that on; delete the draft and
call `beginFresh` only then.

### 16. Closing a panel that is not the top one leaves a spare Back entry (`main.ts` `closeLayer`) — read, low

When the panel closed is under another (`i` is not the last), it is taken out of `layers` but no history entry
is removed. History then holds one entry more than there are panels, so after everything is closed the
phone's Back button does nothing once before it leaves the app. **Fix proposed:** go back one entry in that
case too (counted in `ownBacks`), or re-number: to be tested with `notes-edit-switch-test`.
Two ways to get there, both read in the code: (a) the Mixer with a part's sound list open, then the Mixer
button, Speed, Loop or Settings: `openSheet` takes both panels out of `layers` and adds one, but history keeps
both entries; (b) `closeMixer` under the sound list: the Mixer's entry is spliced out, only the sound list's
goes back.

### 17. A new score's notes and mixer settings are lost each time it is continued (`main.ts` `scoreKey`, `continueDraft`) — read, medium-low (Composer only, hidden on the live site)

Notes, mixer settings and drafts are kept under the score's key, which is the hash of the file's bytes. A
score made with New score has no file: after the app is closed, *Continue* loads the draft's bytes, which
differ after every edit, so it gets a new key each time and the notes written on it and its mixer changes
stay behind under the old key, unreachable. (An opened file is fine: "Continue my edits" keeps the original
file's key.) The same applies to *Save a copy*: the copy is another file, so the notes don't follow it.
**Fix proposed:** give a new score a key of its own when it is made (kept in its draft: `EditDraft.key`
already exists) and reuse it on Continue instead of hashing the bytes.

### 18. The last stroke or mixer change can miss its draft when the app is left at once (`annotations.ts` `save`, `main.ts` `draftTimer`) — read, low

Note drafts are written 300 ms after a change and mixer drafts 400 ms after; nothing writes them at once when
the page is hidden (edits do: `visibilitychange` → `saveEditDraft`). A phone that freezes or kills the app
right after it is left can lose the last change. **Fix proposed:** on `visibilitychange` to hidden (and
`pagehide`), write both drafts at once; `restartForUpdate` does the same for notes.

### 19. A Play tapped while the sounds were loading starts the *next* score by itself (`main.ts` `pendingPlay`, `openScore`) — read, medium-low

Play before the sounds are ready sets `pendingPlay`, carried out when `playbackReady` comes. `openScore` does
not clear it (nor `pendingPreview`, a tapped note waiting to sound). So: tap Play on a slow first load, give up
and open another score, and that one starts playing by itself as soon as its sounds are ready, against the
standing rule that opening a score stops playback. **Fix proposed:** `pendingPlay = false; pendingPreview =
null;` at the top of `openScore`.

### 20. Cleanup, not a bug: *Keep playing*'s silent audio is behind an `ANDROID` check (`main.ts:1661`) — read

The project's rule (17 Oct 2026) is one block of code for every platform, with no `ANDROID` check around a
fix. `updateKeepAlive` runs only where the user agent says Android. Left as it is unless the user wants it
changed: on iPhone the silent `<audio>` might help or might do harm (it can't be tested from this PC).

### 21. Two quick taps on a part's sound button open the sound list twice (`main.ts` `openSounds`) — read, medium-low

The first time, `openSounds` waits for the engine's sound list before it shows the panel, and nothing stops a
second tap meanwhile; each call ends with `openLayer(closeSounds)`. The panel then has two entries in
`layers` and in history. Closing it once leaves one behind: `layers.length` stays above zero with nothing
open, so Focus no longer starts by itself, an installed update is never applied (`quietForUpdate`), the arrow
keys stop turning pages, and one Back press does nothing, until Back is pressed.
**Fix proposed:** ignore the call while the list is loading or the panel is open.

### 22. Words typed for a staff text are cleared even when they could not be put in (`main.ts` `edit-text`) — read, low

`runEdit(...).then(() => { em.words.value = ""; })` clears the field whether the edit worked or not (the lyric
button checks). **Fix proposed:** clear only when `runEdit` resolved `true`.

### 23. Page by page: settling on a page after a trackpad scroll trusts a finger count that can be stale (`main.ts:3408`) — read, low

The settle timer returns when `fingersDown > 0`. The app's own rule (issue #9) is that this count is not to be
trusted after 3 s without touch activity (`fingersBusy()`), because a touch that ended on a removed element
never reports. With a stale count the view can stay between two pages after a trackpad or wheel scroll.
**Fix proposed:** use `fingersBusy()` there.

### 24. Notes on the score don't follow the music after it is edited (`annotations.ts` pins, `main.ts` `afterEdit`) — read, medium-low (Composer only, hidden on the live site)

Notes written in the current layout are kept at their place on the page, and shown in other layouts by the
moment in the music under them (seconds) and the staff's number. An edit that moves the music (bars inserted
or deleted, a line added, lengths changed so the systems break elsewhere) changes neither: a circle drawn
round bar 12 stays where bar 12 was on the paper, and in the other views lands a bar early or late; adding a
line above renumbers the staves. Nothing warns the reader. **Fix proposed:** needs a decision, not a patch:
pin notes by bar and beat rather than seconds, and re-place the current layout's notes from their pins after
an edit. Until then, say in the README that notes written before editing may no longer sit on their music.

## Reading stopped here (12 Nov 2026)

24 findings from about two thirds of the app's own code. The parts listed above as not read may hold more.
Order proposed for fixing, by what a reader of the live site can hit today: 9 (with 10, 11, 15, 19: the
opening flow), 3, 21, 1, 5, 16, 18, then the Composer-only ones (12, 13, 17, 22, 7, 24) and the small ones
(2, 4, 6, 8, 14, 23).
