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
- [x] `app/src/render/pagerenderer.ts`, `newscore.ts` (nothing found there); `musicmap.ts`, `typing.ts`, `tour.ts` not read yet
- [x] `app/src/voice/transcribe.ts` (nothing found)
- [ ] `app/src/annotations.ts`
- [ ] `app/src/main.ts` (in parts). Read so far: 118-1625 (pages, tiles, zoom, pinch, taps, scroll handle, cursor, playback log: nothing found beyond 8), 2960-3290 (save, ask, opening, changeView)
- [ ] `engine/core/session.cpp` (only if usage allows)

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
