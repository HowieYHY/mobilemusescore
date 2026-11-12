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
- [ ] `app/src/main.ts` (in parts; the lines read are noted here)
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
