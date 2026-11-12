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

**Phase 2, notes onto rests.** With a rest selected, the pitch buttons give way to the letters C D E F G A B
(same bar height). `mss_edit_enter_note(letter)` (`Session::editEnterNote`) does what desktop's letter keys do:
`Score::resolveNoteInputParams` (key signature, octave nearest the previous note) then `cmdAddPitch`, one undo
step, the rest's length kept (a whole-bar rest gets a quarter), the new note stays selected for Higher/Lower.
Tests: edit-test (enter, bar height, adjust, undo) and edit-layout-test (letters at every width).

**Silent draft.** `app/src/editdraft.ts`: after each edit (800 ms later, and when the page is hidden) the edited
score is saved with `mss_save` into IndexedDB, one draft per score key. Opening the same score asks *Continue my
edits / Start again*; *Save a copy* and *Don't keep* delete it. The undo history is not kept. Test:
`scripts/edit-draft-test.mjs`.

**Voice to notes, one voice.** `app/src/voice/transcribe.ts` (McLeod pitch, 16 kHz, plain JS, no model) finds the
notes: pitch every 10 ms, bridges short dropouts, a new note where the pitch settles somewhere new, the same
pitch sung again where the loudness dips and returns (measured over 20 ms, not the whole 64 ms window), and a
short note straight into another a step or two away is dropped as the slide into it. `toGrid` puts them on
sixteenths (or eighths) at the chosen speed, the first note starting the tune, gaps as rests. The dialog
(`#voice`, main.ts "sing it in") records with MediaRecorder or takes an audio file (`decodeAudioData`, resampled to 16 kHz
with an OfflineAudioContext), draws a piano roll, plays the result on a triangle synth, and offers an octave
that fits the target staff (`mid`, the pitch of the staff's middle line, from the engine). `mss_edit_insert_notes`
(`Session::editInsertNotes`) enters the events with `Score::setNoteRest` (rhythmic), one undo step, ties and
rests across bar lines done by the engine. Tests: `voice-test.mjs` (tracker on a synthetic tune: 10/10 notes,
36x real time) and `voice-edit-test.mjs` (the whole flow, tune in a Bass bar; `VIDEO=dir` films it to MP4).
**A metronome while recording (issue #35):** `voiceMetronome` beeps the beat on its own AudioContext (made in the
Record tap, before the microphone question), a switch in the dialog, on by default; its speed is the picked
bar's (`tempoAtBar`: the engine's bar starts and tempos, 120 where the score has none, halved or doubled into
50-200), shown in the Speed field, which is set before recording and locked during it. The beeps reach the
microphone from the device's own speaker and the tracker took them for notes (measured: up to 8 notes never
sung, some before the tune), so the beep is high and short (`CLICK_HZ` 2400, 40 ms) and a recording made with
beeps goes through `removeClicks` (8th-order low-pass at 1200 Hz, above every pitch the tracker looks for)
first: 8/8 cases right in `voice-test`, beeps up to three times the voice. The first sung note still starts
the tune (the beeps set the speed, not the place: the delay between speaker and microphone differs per
device). The dialog names the line and bar the tune goes into. `voice-edit-test` records on Chrome's stand-in
microphone and counts the beeps.
**Only tested on a synthetic voice and a synthetic recording; a real voice, a real microphone, a real
speaker's beeps and a phone are not tested** (on iPhone the system may play sound quietly through the earpiece
while the microphone is on). Several voices stay unbuilt.

Found on the way: Previous/Next (`mss_edit_move`) never moved the selection in phase 1: the engine wants
`select-next-chord`, not `next-chord`, and the test only waited for it to finish. Fixed, and tested for movement.

**New score.** `app/src/newscore.ts` writes a MuseScore 3.x `.mscx` (parts, key, time, tempo, N whole-bar rests; the engine
reads it like any file; desktop MuseScore 4.7 reads it too, `new-score-test.mjs`). The start screen's *New score*
dialog opens it and `beginFresh` turns on Edit with the first rest picked (`mss_edit_select_start`). A fresh score has
no file to reopen, so its silent draft is flagged `fresh` and the start screen offers *Continue* until a copy is
saved. It also has no contents to be known by (they change with every edit), so it gets a key of its own when it is
made (`newScoreKey`, kept in its draft and handed to `openScore` as `ownKey` by *Continue* and by the restart into an
update): the notes written on it and its mixer settings are found again each time (`new-score-key-test.mjs`). A copy
saved from it is another file, with another key: notes don't follow it. (every such draft: the newest first, the others behind a small *N more*, `resume-list-test.mjs`; desktop restores every unsaved score of a session) (`new-score-flow-test.mjs`: New score, Soprano, Alto, a Tenor letter, close the page, Continue, Save a copy;
`VIDEO=dir` films it). With a score open, the same dialog is in Edit's More (*Score → New score*), not in the
top bar, to keep the phone's bars as they are; `openChosen` returns false when the reader cancels at *Keep your
edits?*, so the open score is never turned into a new one, and Edit's Back entry is reused
(`new-score-inside-test.mjs`). Chromatic notes are spelled as desktop spells them (a C in E major shows as B sharp).
**Phase 3: More** (the three dots in the edit bar; the mic lives there too). Engine (`session.cpp`, `mss_edit_*`):
`editAddBars`, `editSetKey`/`editSetTime` (every line, from the picked bar), `editTie` (`cmdToggleTie` runs its own
command), `editAccidental`, `editTriplet`, `editAddToChord`, `editStaffText`, `editDynamic` (use the string
overload of `setDynamicType`, or the text is empty), `editLyric` (BEGIN/MIDDLE/END/SINGLE by the syllable before),
`editAddLine` (copies the last part's instrument, set at tick -1 like `appendPart`; tick 0 left a second, blank
instrument and a ghost mixer strip) and `editRenameLine`. Edits that rebuild bars or lines drop the selection, so
they pick the same place again (`placeOf`/`reselect`). A new or removed line (also by undo/redo) rebuilds the
playback (`rebuildPlayback`, keeping volumes, mutes and solos per line; **sounds chosen in the mixer return to the
score's**); a rename only renames the tracks (`syncTracks`). The selection also reports `tie`, `tuplet` and `part`.
Tests: `edit-more-test.mjs` (engine, read back through desktop MuseScore) and `edit-more-ui-test.mjs` (real touch,
every button's effect, layout of the open panel at 320/412/820/1280 px).
The pen Notes stay a read-only-mode tool; Notes and Edit are never on together (each one's button closes the other, the new mode taking the old one's Back entry, `swapLayer`; `notes-edit-switch-test.mjs`). Composers write text with More → Words.
The first tap that starts the audio now waits for it, so its note sounds (written, not yet heard on a device).
Not built: hearing the other lines while recording; choosing the clef or
sound of an existing line; several voices in one staff; the panel scrolls on a short phone (40% of the height).

**Phase 4 (4 Nov 2026), in the order the user approved** (the list: essential first, then low clutter):

- **#2 Note input that moves on** (`editEnterNote(letter, den, dots)`, `editEnterRest`): desktop's note input, one
  step per call. The input position is the selection; the length is the one chosen (`edit.len`, a quarter at each
  score's start, as desktop; tapping a note or rest makes its length the input length, as `InputState::update`
  does on desktop, while ‹ › during note input leave it); `InputState::moveToNextInputPos` gives the next place, which is selected. With a rest
  (or the place after a note just entered, `edit.step`) selected, the length buttons set the next notes' length
  instead of changing the rest. A rest key joins C to B (desktop's 0). The just-entered note is fixed with ‹, ⌄ ⌃, ›.
  `step-entry-test.mjs` (read back by desktop MuseScore).
- **#1 Ranges, Copy, Cut, Paste** (`editExtend`, `editCopy(cut)`, `editPaste`): holding a finger still for 450 ms
  on the score (or Shift+click) selects from the selection to there, `Score::select(RANGE)` as desktop's Shift+click.
  The engine reports a range as one box per system (`rangeJson`), drawn as a light wash. ‹ › give way to Copy and
  Cut while a range is selected; Paste sits at the end of the length row once something is copied (beside ‹ › it
  would have shrunk the letters to 21 px at 360). The clipboard is the engine's own, in desktop's format
  (`Selection::mimeData`, pasted through `Score::cmdPaste` with a small `IMimeData`), so it carries across scores.
  Delete and ⌄ ⌃ work on a range. `range-copy-test.mjs`.
- **#3 Voices** (`editVoice(v, input)`): More → Voice 1-4. On a note: `changeSelectedElementsVoice`. While entering:
  the place in that voice (`expandVoice` fills it with rests first, as desktop's note input does), so letters go on.
- **#4 Bars anywhere** (`editInsertBars`, `editDeleteBars`): MasterScore's `insertMeasure` before the picked bar
  (in the parts too), `deleteMeasures` for the picked bar or the range's bars, after asking.
- **#5 Marks** (`editMark`): staccato, accent, tenuto, marcato by `toggleArticulation` (every note of a range;
  again to remove); fermata, breath and caesura dropped on the chord as the palette does (`ChordRest::drop`).
- **#6 Slurs and hairpins** (`editSlur`, `editHairpin`): desktop's `doAddSlur` rules (a range: one per line, first
  to last chord; a note: to the next chord), `Score::addHairpins`.
- **#10 Keys** (main.ts "Edit by keyboard"): A-G, 0, 1-7 (desktop's lengths, no 64th), ".", arrows, Shift+arrows
  (`editMove("extend-…")`), ↑ ↓ and Ctrl+↑ ↓, Delete, Ctrl+C/X/V/Z/Y; only while Edit is the top layer and no field
  has focus. `composer-tools-test.mjs` covers #3-#6 and #10.

Still to come, by the same list: #7 transpose, #8 a line's clef and sound, delete and reorder lines, #9 title and
composer text, then #11-#19 (tempo, repeats, rehearsal marks, breath marks done in #5, pickup bar, verse 2, respell,
play from the selection, PDF and MusicXML export).

`RuntimeError: null function` from the engine (seen three times, 4 Nov 2026) came each time from the dev server
reloading the page while a test ran (an app file was changed mid-run; once the page also lost `app`). Don't edit app
files while tests run against the dev server.

Not done yet: the edit bar is three rows high on a phone, and the open More panel leaves little of the score on a 640 px phone.

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
