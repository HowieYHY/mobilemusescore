# Composer (branch `composer`, not published)

Plan and findings for letting PocketScore edit `.mscz` files. Started 3 Nov 2026. Nothing here is on the
live site; the user tests it on localhost first (the user, 3 Nov 2026).

## Decisions (the user, 3 Nov 2026)

- **Edit is a mode inside the player**, not a separate app. One code path for every platform.
- **Save a copy** (download or share a `.mscz`; MusicXML and MIDI optional). The original is never overwritten.
  The existing *Save* (notes and mixer kept on the device) stays as it is.
- **Voice to notes, one voice, is a must.** Several voices is optional, and only if it costs no lag.
- **Lag is the first rule.** Nothing that adds a big download or a lot of memory to every reader.
  Heavy parts load only when someone opens that feature.

## Design taken from the demo video (Scorecraft), not its code

1. Record, or pick an audio file.
2. Setup: tempo, rhythmic detail (smallest note, e.g. 1/16), key, time signature, where to put the notes.
3. Transcribe, on the device (nothing is uploaded).
4. Preview: hear the detected notes and see them on staves before they touch the score.
5. Insert into the score at the selected bar. More than one voice detected: a preview of one line per voice,
   to assign, merge, move an octave or delete lines first. One voice: straight to step 5.

The demo's output was unreadable (stray accidentals, no key, notes cut into slivers). The fixes belong in the
cleanup: key estimate and snapping to it, a minimum note length, a beat grid from the tempo, spelling by key,
and onsets from loudness as well as pitch (a repeated note has no pitch change).

## Findings so far

### The engine can edit and save (spike, passed 3 Nov 2026)

`mss_edit_add_note`, `mss_edit_undo`, `mss_edit_redo`, `mss_save` (session.cpp, mscore.cpp). `node scripts/edit-spike.mjs`
adds a note, saves, undoes, redoes, reloads the saved file and plays it. On all 7 test scores: 15 edits each,
none refused, 13 to 81 ms per edit (layout and playback model included), saved files reload, and desktop
MuseScore 4.7.5 opens them (bar counts equal; note counts differ only by the notes added).

Two things the spike hit, both fixed:

- **Writing needs `IApplication`.** `Writer::writeScore` stamps the file with the application version; nothing
  answered for it, so the write ran off the end of memory. `AppInfo` in session.cpp answers (version 4.7.5).
- **WebAssembly converts doubles to int differently from x86.** After an edit next to a melisma, a lyrics line had
  no laid-out start (`-DBL_MAX`). The dash count then became INT_MIN on x86 (one dash, harmless) but INT_MAX in
  WebAssembly (saturating), and the dash list ran out of memory ("bad_alloc" in `LyricsLayout::layoutDashes`,
  GODS: add a note in bar 5, then bar 6). `patches/musescore-4.7.patch` now draws nothing for such a line.
  Rule: when the engine crashes in WebAssembly on something desktop survives, suspect float-to-int conversion
  and uninitialised sentinels before suspecting the edit.

### Memory (measured 3 Nov 2026, desktop Chromium, phone-sized window; phones will differ)

| State | All browser processes |
| --- | --- |
| Start screen | 377 MB |
| GODS open | 1001 MB |
| After 15 s of playing | 971 MB |

Of the ~620 MB a score adds, the audio engine's WebAssembly memory is 266 MB (sound font and synth) and the
score engine's is 128 MB, and the score engine does not grow with edits (10 edits: still 128 MB). So the
composer's editing costs almost nothing; the existing audio engine is where memory goes. Not looked at yet:
whether the audio engine's 266 MB can shrink (a separate task, worth doing before adding more).

### Pitch detection (spike, synthetic voice only)

`node scripts/pitch-spike.mjs`: plain-JavaScript McLeod pitch tracker, 16 kHz, 10 ms steps. On a synthetic sung
line (vibrato, glides, breath noise, a rest) it found 9 of 10 notes at 37 times real time on one desktop thread,
with memory of just the audio buffer. The miss is two equal notes in a row, which needs loudness-based onsets.
**Not yet tested on a real voice.** Several voices (Basic Pitch needs TensorFlow.js, tens of MB) is a separate,
lazy-loaded, optional step, and is not started.

## Built so far (3 Nov 2026, branch `composer`, unpublished)

**Phase 1, Edit mode.** The *Edit* button (top bar) opens the edit bar (`#editbar`, main.ts "edit mode"): tap a
note or rest to select it (the engine picks the nearest within a fingertip), previous/next, pitch up/down by a
step or an octave, length whole to 32nd and dotted, delete (to a rest), undo/redo, *Save a copy*, Done. Engine:
`mss_edit_select / selection / move / pitch / duration / dot / delete / undo / redo`, `mss_save` (session.cpp).
After each change the page asks for the score info, timeline, bars and tempos again and redraws
(`afterEdit`), about 60 to 140 ms on a desktop and the Android emulator. *Save a copy* shares a file where the
device's share sheet takes files, and downloads otherwise; it never overwrites the opened file.

Tests: `node scripts/edit-api-test.mjs` (engine in Node), `scripts/edit-test.mjs` (real touch in Chromium;
`CDP=http://127.0.0.1:9333` drives the Android emulator's Chrome), `scripts/edit-layout-test.mjs` (top bar and
edit bar at 320 to 1366 px).

Not done yet: a silent draft of the edits (closing the tab loses them; the browser asks first), entering notes
into rests (phase 2), notes written with the pen are not moved when the music changes, the first tap that
starts the audio does not sound its note, and the edit bar is three rows high on a phone.

Emulator: Android SDK on `D:ndroid-sdk` (cmdline-tools, emulator, platform-tools, Android 35 Play image),
AVD `pixel35` (`ANDROID_AVD_HOME=D:ndroid-sdkvd`, `JAVA_HOME=D:ndroid-sdk\jdk\jdk-17.0.20.1+1`).

## Plan

0. Spike: engine edit and save (done); pitch tracker on a real voice (the user's recordings, on localhost).
1. Edit core in the app: Edit mode, select a note, pitch up/down, duration, rest, delete, undo/redo, Save a copy.
2. Tap entry: duration buttons and an on-screen piano or pitch ladder; optional Web MIDI keyboard (Chrome only).
3. Voice to notes, one voice (the flow above).
4. Several voices: only if the memory and size cost is small, and loaded only on demand.
5. Tour step, README, tests, and a localhost round for the user.

## Testing

- Browser: Playwright with phone emulation (no Android emulator is installed on this PC, and its microphone
  is unreliable anyway). Real phone over USB when the user has one connected.
- Voice: fed from audio files; the real microphone is the user's to try on localhost.
- Each edit feature: check against desktop MuseScore (`MuseScore4.exe -o x.musicxml saved.mscz`).
