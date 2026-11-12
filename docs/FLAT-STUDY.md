# How the Flat app works on a phone (study for issue #33)

Issue #33 asks for the Composer's functions and layout to follow the Flat app (`com.tutteo.flat`) as closely as
possible. This is the record of exploring Flat on the owner's Pixel 9a (1080 x 2424 px, 412 x 924 CSS-px
equivalent, Android 16) over USB on 12 Nov 2026, written down step by step as each thing was tried. Sizes are in
the phone's own pixels (divide by 2.625 for CSS px). Everything was done in one test score, "Pocketscore test".

What is taken from Flat: where things sit, the order of steps, what each tool does and how edge cases behave.
What is not: Flat's icons, artwork, colours and wording.

Each finding says **seen** (on the phone) or **guess** (not tried, or for iPad, which was not available).

## 1. Making a new score (seen)

A sheet that slides up over the dashboard, nearly full height, with three steps shown as three short bars under
the title bar (the current step's bar is longer and coloured).

- **Title bar:** back arrow at the left, the score's name in the middle-left, *Edit name* as a text link at the
  right. So the name is asked first (step 1) and can still be changed from any later step.
- **Step 2, instruments:** a search field (*Search instruments*) on top, then instrument families as cards, one
  under another, each a row with an icon, the family's name and a chevron that opens it in place: Brass,
  Electronic Instruments, Free Reed, Keyboards, Pitched Percussion, Percussion, Plucked Strings, Strings (more
  below, scrolled).
- **Bottom of the sheet, fixed:** at the left a count of what is chosen, at the right one button, *Next*, greyed
  until at least one instrument is chosen.
- **An instrument family opened** (seen): its instruments are listed in the same card. Each row has a small play
  button at the left (hear the sound before choosing), the name, and a **+** at the right. After one tap on +,
  the row turns to **− 1 +** (the same instrument can be added more than once) and its name is coloured; the
  family's title row shows a round badge with how many were chosen from it, and the bottom says *1 selected*.
  Instruments that need the paid plan sit under a tinted *Power instruments* band with an upgrade button; they
  have no +. Families further down: Vocals (Choir Alto, Choir Bass, Choir Soprano, ...), Woodwind, Special.
- **Next** (seen) does not go straight on: the sheet shrinks to a short one at the bottom listing only what was
  chosen (*Piano*, *Choir Soprano*, each with an ✕ to take it out), with *2 selected* and **Done**. A check of
  the list before moving on.
- **Step 3, "Fine-tune your setup"** (seen): one screen, no scrolling needed on the Pixel, three cards and one
  wide button pinned at the bottom:
  1. **Tempo**: a small drop-down for the beat's note value (a quarter note shown) and a number field (80) with
     − and + at its right; under it **Bars**: a number field (4) with − and +. So a new score starts with only
     4 bars by default.
  2. **Key signature**: "Starts with no sharps or flats by default." Two rows of seven square buttons: 1 to 7
     sharps on top, 1 to 7 flats below, each drawn as the key signature itself (no names). None is picked for
     C major; there is no button for it.
  3. **Time signature**: one row of seven squares: 2/4, 3/4, 4/4 (picked, outlined and tinted), C, cut C, 6/8,
     and a pencil for a custom one.
  - **Create Score**: full width, at the bottom.
- The subtitle says these can be changed later in the editor: the step is skippable in spirit, defaults suit.

**For PocketScore:** our New score dialog asks everything on one sheet (title, lines with clefs, key as a list of
names, time as a list, tempo, bars). Flat's order is name → instruments (grouped, searchable, with a count) →
review → setup with picture buttons. The big differences worth taking: key and time as rows of picture buttons
instead of drop-downs; − / + beside the tempo and bar numbers; the chosen lines shown as a list with ✕.

## 2. The editor: what is where on a phone (seen)

Creating the score opens the editor directly, in portrait, with the first rest already picked and a tour bubble
pointing at it. The screen has four bands, top to bottom (Pixel pixels; the screen is 1080 x 2424):

| Band | y | What is in it |
|---|---|---|
| Top bar | 194 to 299 | ← back to the library · *Instrument settings* (piano keys) · a rounded pill holding *Go to start*, Play, Loop, *Volume settings* · a note-input icon · Upgrade · ☰ Menu |
| Edit bar | 341 to 451 | *Switch voices* (a ring with "1") · ⌫ *Remove an element then go left* · Undo · Redo · Copy · Cut · Paste · *Switch display mode* · Comments |
| The score | 460 to about 1690 | The music, scrolled sideways (one long line, not pages). The place for the next note is a blue drop under the staff with a round handle. |
| Bottom sheet | about 1690 to 2361 | A drag handle, then three rows: the **tools of the open category** (1813 to 1900), the **category strip** (1939 to 2026), the **piano keyboard** (about 2080 to 2361) |

Details:

- **Nine controls in the edit bar, six in the top bar**, all icons, no words, each about 105 px (40 CSS px) wide
  with gaps: they fit one row at 412 CSS px.
- **Undo and Redo are greyed** with nothing to undo; their accessible names say why ("No modifications to undo").
- **The bottom sheet has rounded top corners and a grab handle**: it is a sheet over the score, not a bar.
- **Tools row for the first category (Notation):** a "note +" button at the left (196 px wide slot before it is
  empty: the row is scrolled by hand), then the lengths as bare note shapes: whole, half, quarter, eighth,
  sixteenth, thirty-second, sixty-fourth (the last one starts off-screen: the row scrolls sideways). The chosen
  length (quarter) is coloured; no box round it.
- **Category strip:** a rounded grey strip of small icons, one per category, scrolling sideways: Notation
  (picked: white tile), Pitch and Representation, Articulations, Ornament, Dynamics, Measure, Clef, Key
  signature, Time signature, Barlines and repeats, Text, ... and at the far right, outside the strip, an
  **Expand toolbar** button.
- **Piano keyboard:** always there under the tools, about 2.2 octaves... (one octave and a bit shown: B3 to B4),
  each white key labelled (C4, D4, ...) in a small rounded tag at its bottom. A thin coloured line under it.
- **Shortcuts in the names:** the lengths are named "Whole (1)" to "Sixty-fourth (7)", voices "(V)", delete
  "(⌫)", copy/cut/paste with Ctrl: the same tools serve a keyboard.
- **The first bar is 4/4 with four quarter rests**, not a whole-bar rest, so each beat is a place to tap; the
  picked rest is drawn in the accent colour.
- **Tempo "♩= 80" sits above bar 1 and bar numbers above every bar** (2, 3, 4).

**The tour's first bubble** (dark, anchored under the picked rest, *Skip tour* at its left and *Let's go* at
its right): "Welcome to your first score! Tap a key (or chord) on the piano to insert a note at the marked
position."

**The rest of the tour** (seen; four bubbles, each with *Skip tour* and *Next*, each with a short looping
picture): 2. "Navigate the score by tapping the note or rest you want to edit." with "Tip: Adjust the zoom by
pinching!"; 3. "Try changing a selected note by dragging it to a different line!"; 4. (went by too quickly to
read). So Flat teaches exactly three gestures first: tap a piano key to put a note in, tap a note to pick it,
drag a picked note up or down to change it.

A correction to the table above: the "Piano" I chose is drawn as a grand staff (treble and bass joined by a
brace), and the Choir Soprano line is under it, below the fold.

## 3. Putting notes in (seen)

- **A tap on a piano key puts a note of the chosen length at the marked place**, in place of the rest there, and
  the blue drop moves on to the next rest. It sounds as it goes in. Undo lights up at once. Two taps (C4, E4)
  gave two quarter notes on beats 1 and 2; the drop then stood under the rest on beat 3, drawn in the accent
  colour.
- **Edge: a note too long for what is left of the bar is cut to fit.** With two beats left in bar 1, I chose
  *Whole* and tapped G4: a **half** note went in (filling the bar exactly), nothing was tied over the barline,
  and the chosen length in the tools row changed to *Half* by itself. The drop moved to bar 2, whose first two
  quarter rests were shown merged as one half rest (the rests ahead are regrouped to the length now chosen).
  This is unlike MuseScore, which would put in a half note tied to another half note in the next bar. *(For
  PocketScore: the owner's rule for Sing it in was the opposite, that what goes beyond the bar overflows into
  the next. To be decided: follow Flat here, or keep desktop MuseScore's tie-over.)*
- **A second tour bubble came up after the third note** (seen): "**Blue** attributes can be adjusted directly
  in the score. The list below can help identify them." with five chips: Tempo, Key signature, Time signature,
  Clef, Instruments; and *Complete tour*. At that moment the tempo mark, the clef, the key signature place, the
  time signature and the instrument name were all drawn blue in the score: they are buttons. So Flat's rule is
  **what is blue on the page can be tapped to change it there**, without going through a menu.
- A small clock-like icon appeared at the right end of the lengths row once notes existed (not tried yet).
- **The score grows by itself** (seen). The score was made with 4 bars. Putting a whole note into bar 4 (the
  last) added a bar 5 at once and moved the drop into it: the writer never runs out of bars and never has to add
  one by hand while writing a tune.
- **The view follows the drop** (seen): the music scrolled left by itself so the bar being written stayed in
  view; the instrument's name ("Piano", with its brace) stayed pinned at the left edge while the bars slid
  under it.
- **At the end of the last bar there are two buttons drawn on the page itself** (seen): a **+** above a **−**,
  each on a little piece of staff, just right of the final barline: add a bar, take the last bar away. They
  are part of the score area, not of any toolbar, and are only there when the end of the score is in view.
- A whole note in an empty 4/4 bar goes in as a whole note; the rest ahead is shown as a whole-bar rest (the
  rests ahead take the chosen length where it fits).

## 4. Picking and changing what is there (seen)

- **A tap on a note picks it**: the notehead turns the accent colour, the drop sits under it, and **the piano key
  of its pitch lights up** (A4 filled with the accent colour, its label white). The chosen length in the tools
  row shows that note's length. No pop-up, no handles, nothing else appears.
- **A tap on a piano key while a note is picked adds that pitch to it as a chord**, and the pick moves on to
  the next note or rest. (Picked the A4 whole note of bar 3, tapped C4: bar 3 became C4+A4, and bar 4's note was
  picked.) So in Flat a key always *adds* at the picked place and steps on; it never replaces the pitch. To
  change a pitch the tour teaches dragging the note.
- The two end-of-score buttons are named *Add measure at the end* and *Remove last measure*; the clock at the
  end of the tools row is *Recent tools*.
- **The delete key (⌫, "Remove an element then go left")** (seen): with the whole note of bar 4 picked, one
  press turned bar 4 back into rests (four quarter rests, not one whole rest) and moved the pick **left**, onto
  the chord in bar 3, with its lowest note picked and both its piano keys lit. A second press removed only that
  one note of the chord (C4), left the A4 picked, and did not move. So ⌫ works like a typewriter's backspace:
  it removes one note at a time and steps back only when the place is empty.

## 5. The bottom sheet and its two sizes (seen)

- **Small (the usual):** drag handle, tools row of the open category, category strip, piano keyboard.
- **Expanded** (the button at the right end of the category strip, *Expand toolbar*): the sheet grows to about
  half the screen (its top goes from y ≈ 1690 up to ≈ 1370), **the piano keyboard goes away**, and in its place
  is **one long scrolling list of every category, each with a heading and all its tools laid out as a grid of
  bordered square cells, 8 to a row** (5 to a row for clefs). The category strip moves to the very bottom of
  the sheet and now works as a jump list: tapping an icon scrolls the list to that heading, and the icon of the
  section in view is marked. Two buttons sit right of the strip: one with lines (not tried) and one that puts
  the keyboard back.
- **Dragging the sheet down collapses it** back to the small size (found by accident: a downward swipe on the
  list while it was at its top).
- **Tools that can't be used here are greyed, and say why.** Their accessible names, read from the phone:
  "Tie: The next note must have the same pitch. Maybe you should use a slur instead?", "Cannot insert a tuplet
  of the current duration at this place", "Grace note: Can't use on a rest", "Switch Enharmonic: Can't switch
  the enharmonic of this note". Nothing is hidden; unavailable tools stay in place, dimmed.
- **Paid tools carry a small flame badge** on the cell's corner (e.g. *Repeat X times*).

**The categories, in order, with what could be read by name** (many cells are pictures without a name; they
are identified from screenshots in the next section):

| Category | Tools read by name |
|---|---|
| Notation | Whole (1), Half (2), Quarter (3), Eighth (4), Sixteenth (5), Thirty-second (6), Sixty-fourth (7), Tie, Tuplet, Sharp (=), Flat (-), Switch Enharmonic |
| Pitch and Representation | sub-headings *Editing*, *Duration*, *Rest*, *Transposition*, *Beaming notes*; Grace note, Acciaccatura, Note Color |
| Articulations | Slurs (S) and unnamed cells |
| Ornament | Mordent and unnamed cells |
| Dynamics | unnamed cells |
| Measure | Insert Measure Before, Insert Measure After, Remove Measure (Ctrl + ⌫), Multimeasure rest, Set a new tempo, Add custom rehearsal |
| Clef | G2 (and 8va, 8vb, 15ma, 15mb), C1 to C5, F4 (and 8va, 8vb, 15ma, 15mb), F3, F5: 17 clefs, 5 to a row |
| Key signature | C major/A minor (natural), then 1 to 7 sharps, then 1 to 7 flats, each named by both keys ("Set G Major/E Minor key signature (1#)") |
| Time signature | 2/4, 3/4, 4/4, common, cut, 6/8, and a full-width *Customize* button under them |
| Barlines and repeats | double bar, start repeat, end repeat, *Repeat X times* (paid), two more line kinds, segno, coda; second row: Fine, D.S., D.C., to Coda, volta 1., 2., 3., 4. |
| Text | five cells (lyrics, chord grid, roman numerals, figured bass (paid), text) |

**The same categories from the pictures** (seen; cells left to right, top row first; "paid" = flame badge;
"dim" = greyed because a rest was picked):

- **Notation** (2 rows of 8): *add-a-note* (a note with a +), whole, half, quarter, eighth, sixteenth,
  thirty-second, sixty-fourth / dot, double dot, tie (dim), tuplet "3" (dim), natural, sharp, flat, enharmonic
  swap (dim). The chosen length's cell is tinted.
- **Pitch and Representation** (2 rows of 8): beaming, a crossed note, *turn into rests* (a note with rest
  signs), transpose (paid), one more (paid), three dim cells / grace note (dim), a bracketed notehead (dim),
  cross notehead (dim), note colour (paid), 8va, 8ba, 15ma, 15mb.
- **Articulations** (2 rows): staccato, staccatissimo, tenuto, tenuto-staccato, accent, marcato, fermata, slur /
  two dim cells, breath mark, caesura, +, o.
- **Ornament** (2 rows, all dim on a rest): trill, tremolo with 1, 2, 3, 4 strokes, three two-note tremolos /
  a fourth, arpeggio, glissando, a wavy line with a drop-down arrow, turn, inverted turn.
- **Dynamics** (2 rows): ppp, pp, p, mp, mf, f, ff, fff / sfz, rfz, fp, pf, crescendo hairpin, diminuendo
  hairpin, pedal.
- **Measure** (3 rows): a magnifier-with-arrow cell, insert bar before, insert bar after... (named: Insert
  Measure Before, Insert Measure After, Remove Measure), a return arrow (line break), a boxed return arrow
  (page break), multimeasure rest (paid), one-bar repeat sign, two-bar repeat sign (paid) / accel, rit,
  a tempo (paid), set a new tempo (metronome), two swing settings (paid), rehearsal letter [A], rehearsal
  number [1] / custom rehearsal text.
- **Clef**, **Key signature**, **Time signature**: as listed above; **the value in force at the picked place is
  tinted** (treble clef, the natural sign for C major, 4/4), so the grid doubles as a read-out.
- **In the expanded size the open category's tools row stays on top** of the list (with *Recent tools* at its
  right end), so the lengths are one tap away even while browsing the grid.

**For PocketScore:** this is the main thing to take from Flat. Our Edit bar puts lengths and letters in a bar
and everything else in a *More* panel of labelled groups. Flat's shape is: (1) a slim always-visible row for
the category in use, (2) a strip of category icons to switch that row, (3) an input surface (the piano), and
(4) one expanded sheet with every tool in headed grids, where the strip becomes a jump list. Dim-with-a-reason
instead of hide matches our own Settings rule ("shown off with 'Not available…', never hidden").

## 6. Note input mode: writing on the staff with a finger (seen)

- The first cell of the Notation row (a note with a +) is a **switch**, not a tool. Tapping it turns it the
  accent colour and shows a dark message across the bottom, over the piano, with a ✓ to dismiss:
  "Note input mode on — tap any note or rest, then drag to place a new note."
- **The score zooms in by itself** when the mode goes on (the staff became about 1.4 times bigger), so the lines
  are far enough apart for a finger.
- With it on, touching a rest and dragging up or down puts a note of the chosen length there, at the height
  the finger ends on, and the drop moves to the next rest. The piano keys stay and still work.
- So Flat has **two ways in, both always on screen**: piano keys (no mode), and finger-on-staff (a mode that
  must be switched on, because otherwise a touch on the staff means "pick this").

**For PocketScore:** our note input is letters C to B, shown when a rest is picked. Flat's equivalent is the
piano strip, always visible, which also shows the picked note's pitch and takes chords. Letters need an octave
rule (we use "nearest the previous note", as desktop does); piano keys don't. Worth deciding: piano strip
instead of, or switchable with, the letters.

## 7. Changing things by tapping them in the score (seen)

- **The tempo mark** ("♩= 80" above bar 1): a tap opens a **full-screen picker**, white, nothing else on it: a
  large filled circle in the middle with the number (80) and the Italian name under it (ANDANTE); under the
  circle a small row to choose the beat's note value (the quarter note ringed, dotted values either side);
  at the bottom left, in large grey words, "Hold and swipe up and down"; at the bottom right a red ✕ and a
  green ✓. The names (LARGO, LARGHETTO, ADAGIO, ANDANTE, MODERATO, ALLEGRO) are laid up the left edge as a
  scale that the swipe moves through. So the number is set by holding the circle and sliding, not by typing.
- When the score is zoomed in, the instrument's name is shortened ("Piano" becomes "Pno.") so it takes less of
  the width.
- A pale natural sign is drawn where the key signature would be in C major: the place to tap for the key, even
  though there is nothing there.
- **The time signature** drawn in the staff: a tap opens another **full-screen picker** in the same style:
  "Slide up and down to change the time signature"; two columns headed **Current** and **Anacrusis** (the
  pickup bar), each with two digits drawn on a little staff, labelled *Beat* and *Beat type* at the left, each
  digit a wheel that is slid up or down; a switch "Use common time symbol"; red ✕ and green ✓ at the bottom
  right. The pickup bar is set here, next to the time signature, not as a separate tool.
- Both pickers put **cancel and confirm at the bottom right**, where the thumb is, and nothing at the top.
- **The clef:** a tap dims the whole screen with a dark veil (the tapped clef stays lit in the accent colour)
  and slides up a **small bottom sheet** headed *Clef* with an ✕ at its right, holding the same grid of clefs
  as the toolbar's Clef section, the clef in force tinted. One tap on a cell sets it. So: simple choices get a
  bottom sheet with that category's grid; values that are numbers (tempo, time signature) get a full screen.
- **The instrument's name** in the score: a tap did nothing I could see (seen once; perhaps it needs the zoomed
  out size). Its settings are reached from the top bar instead (next section).

## 8. The top bar's buttons (seen)

- **Instrument settings** (the piano-keys icon, second from the left): dims the screen and slides up a bottom
  sheet with a grab handle and an ✕:
  - a switch **All** at the top (off);
  - one row per instrument: its icon and name, an **S** in a ring (solo) and an **eye** (shown or hidden).
    Piano: eye open, coloured. Choir Soprano: greyed, eye closed.
  - a button **Edit instruments** at the bottom right (back to the add/remove list of section 1).
- **So on a phone Flat shows one instrument at a time.** The score I made has a piano and a choir line, but only
  the piano was on screen: the other was hidden, not below the fold as I first wrote. *All* shows the full
  score. This is the phone answer to "a full score doesn't fit": edit one part, switch parts in a sheet.

**For PocketScore:** we always lay out every line, and on a phone a choir score's system is taller than the
screen. Flat's one-part-at-a-time view, with a sheet to switch and an *All* switch, is the single biggest
layout idea here for Edit on phones. (Our engine can already hide staves per part for playback layouts; to be
checked whether a part-only view is cheap.)
- In that sheet, tapping the closed eye of the second instrument showed it and turned **All** on by itself;
  the score behind re-laid itself at once, under the dimming veil. With both shown, the instrument names
  ("Piano", "Choir Soprano", written in full) are pinned at the left and take 330 of the 1080 px: about a
  third of the width is names, which is why one part at a time is the default.
- **Volume settings** (the speaker in the rounded pill): a bottom sheet **Playback options** with three rows:
  *Audio playback*, *Metronome*, *Playback speed* (paid). *Audio playback* slides in a second page of the same
  sheet (back arrow at its top left, title centred): a **Master** slider, then one card per instrument with a
  solo button (headphones), a mute button, and two sliders, **Volume** and **Reverb**. This is the mixer;
  ours has the same parts (master, per part mute/solo/volume/reverb) and more (sound choice, balance).
- The pill groups the playing controls: *Go to start*, Play, Loop, Volume. They stay in the top bar while
  editing; there is no separate "playing" and "editing" screen.
- **Android's Back button, with a sheet open:** the first press goes back one page inside the sheet (from
  *Audio playback* to *Playback options*), and the next **leaves the editor for the library** rather than only
  closing the sheet (seen: two presses from the mixer page landed on *Your Library*). There was no "save?"
  question: the score is kept as it is typed (the library said "You have used 1/15 scores" and listed it).
  *(PocketScore's rule is the better one here: Back closes the top panel first.)*
- **Reopening the score** (seen): it opens zoomed as it was left, with the first note picked, **the piano
  strip scrolled so the picked note's key is in the middle** (C4, lit), and Undo and Redo greyed: the undo
  history does not survive leaving the score. The first-score tour offers itself again.
- **☰ Menu** (far right of the top bar): a **drawer from the right edge**, about 60% of the width, the rest
  dimmed. From the top: *Collaborators*; then a plain list: Advanced Settings, Credits, Manage instruments,
  Version history, MIDI input (BETA tag), Layout, Export Score, Help; at the bottom a card *Publish Score* with
  a *Publish* button (not touched). Everything that is about the score as a whole, not the picked note, lives
  here: title and composer (Credits), page layout, export.

## 9. The edit bar's buttons (seen)

- **Switch display mode** (eighth button; its icon is four upright bars in one mode and stacked lines in the
  other): toggles between the **one long line** scrolled sideways (the default, big notes) and a **page view**:
  the whole page fitted to the screen's width with the title on top, the systems under each other and the bar
  number at the start of each system. In page view the notes are tiny on a phone (a 5-line staff is about 30 px
  high) but everything still works: the drop is there, the piano strip stays. It is the "see the whole thing"
  view; writing is done in the long line.
- After reopening, the category strip showed a **Tempo** category (a metronome icon) between Dynamics and
  Measure, so the full order is: Notation, Pitch and Representation, Articulations, Ornament, Dynamics, Tempo,
  Measure, Clef, Key signature, Time signature, Barlines and repeats, Text.
- **Switch voices** (first button, a ring with the voice's number): a **small drop-down menu** hanging from the
  button, over the score: *Use voice 2*, *Remove voice 1*, *Swap voices* (paid, dim), *Split staff* (paid).
  Two voices per staff, switched from one button whose number says which voice is being written.
- **Play** (in the pill): nothing changes place. Play turns into a **Stop square**, a thin upright line in the
  accent colour runs across the staves as the cursor, and the music scrolls to keep up. The edit bar, the
  bottom sheet and the piano all stay where they are. Playback started from the picked place.

## 10. Selecting several notes (seen)

- **Press and hold a note** starts a selection: the note gets a tinted box with **two round handles, one at each
  side**, to drag wider, and a **floating toolbar appears just above the staff**, at the selection: six icon
  cells in a white rounded bar: Remove, Copy, Cut, Paste, Select all, and one more (two arrows in a loop:
  repeat the selection or loop it; not tried). The piano key of the held note lights and the strip scrolls to
  it. The edit bar's own Copy, Cut and Paste stay too.
- So a selection brings its own tools to where the finger is, instead of sending the hand to a bar.

**For PocketScore:** we select a range by holding a second note, and the bar changes to range tools. Flat's
handles are the familiar text-selection gesture and its floating bar is next to the selection. Both are worth
taking; the handles need the engine to report the selection's box, which it already does for the outline.

## 11. Landscape (seen in part: the controls' places were read, the picture was not kept)

Turned sideways (2424 x 1080), the layout changes shape, read from the controls' positions:

- The **top bar and the edit bar stay as two full-width rows** at the top (y 105 to 210 and 262 to 362), their
  buttons simply spread further apart (the nine edit buttons sit about 270 px apart instead of 115).
- The **tools row comes next, as a third full-width row** (y 441 to 530) and it is long enough to show the whole
  Notation category at once: all seven lengths, then tie, tuplet, sharp, flat, enharmonic, with *Recent
  tools* and a display-mode button at its right end.
- The tool **grid appeared beside the score** rather than under it (cells at x 327 to 1443, y 679 to 916, with
  the next section, *Editing*, starting to their right): in landscape the sections are laid out in columns
  across, not in one tall list.
- The end-of-score + and − buttons are still on the page at the last barline.

Not seen: where the piano strip sits in landscape (the screen was covered at that moment).

## 12. Not tried (the phone was needed back)

The remaining edge cases on the list: a dot where there is no room for it, ties and tuplets, what *Remove last
measure* does to a bar with notes in it, the keyboard strip's own scrolling and its limits, *Recent tools*, the
Pitch and Representation sub-rows, the Tempo and Text categories, the sixth cell of the selection bar, Copy and
Paste across bars, and the piano's place in landscape. Lyrics and chord symbols (Text) matter for choir scores
and should be looked at before that part is built.

## 13. iPad: a best guess (not seen; no iPad was available)

From the landscape layout above and the way the phone layout is built, on an iPad (820 x 1180 portrait,
1180 x 820 landscape, CSS px) I would expect:

- **The same two rows at the top**, with room to spare: the buttons keep their size and spread out, as they did
  in landscape on the phone. Words are still not added; it stays icons.
- **The tools row shows a whole category without scrolling** (Notation's 16 cells fit in 820 px at 48 px each),
  so the row scrolls far less than on a phone.
- **The bottom sheet stays at the bottom in portrait**, the same three rows, but the piano shows about three
  octaves instead of one and a bit, with the same key width (a key about 54 CSS px wide is what a finger needs;
  more width means more keys, not wider keys).
- **In landscape the expanded grid sits beside the score** (seen on the phone turned sideways), so the score
  keeps its height: a side panel about 400 px wide with the sections in a column, the score to its left.
- **All instruments shown by default** (the *All* switch on), since a system of four choir staves fits an iPad's
  height; one part at a time is the phone's answer.
- The full-screen pickers (tempo, time signature) would more likely be centred cards than whole screens.

**For PocketScore on iPad:** the same code with the width deciding (our rule: one block of code, with an
arrangement per width range): under 700 px one part and the sheet at the bottom; from 700 px all parts, a wider
piano and the whole category in the tools row; in landscape from about 1000 px the expanded grid as a side
panel. Each to be checked with `scripts/layout-shots.mjs` at every size.

## 14. What this means for the Composer (proposal, to be agreed)

Our Edit mode today: a bar under the top buttons with previous/next, lower/higher, lengths, delete, the letters
C to B when a rest is picked, and a **More** panel of labelled groups. Flat's shape, piece by piece:

| Flat | PocketScore now | Proposed |
|---|---|---|
| Edit bar: voice, ⌫, undo, redo, copy, cut, paste, display mode | Undo, Redo, Save a copy, Done at the top right of the Edit bar; voice and copy/cut/paste in More or on a range | One slim edit row in the same order: voice, ⌫, undo, redo, copy, cut, paste, then our own Save a copy and Done |
| Bottom sheet: tools row + category strip + piano | Edit bar on top, letters in it, More panel | A bottom sheet with the three rows; the open category's tools in the row; our More panel's groups become the categories |
| Expanded sheet: every category as a headed grid, strip as a jump list | More panel (labelled groups) | The same panel, re-laid as headed grids of square cells, opened by the strip's last button |
| Piano strip, lit for the picked note, a tap adds a note and steps on | Letters C to B (octave nearest the last note) | **Decision 1** below |
| A note too long is cut to fit the bar | MuseScore's way: tied over the barline | **Decision 2** below |
| One instrument at a time on a phone, *All* switch | Every line always | **Decision 3** below |
| The score grows a bar when the last one is filled; + and − at the final barline | Bars added in More | Take both: they remove a whole step from writing a tune |
| Tap the tempo, time signature or clef in the score to change it | From More (Key, Time, tempo) | Take it: the engine already tells us what was tapped |
| Hold a note: handles and a floating bar | Hold a second note for a range; the bar changes | Take the floating bar; handles later |
| Dim-with-a-reason | Buttons disabled without a reason | Take it: the reason as the button's title and in the status line |
| New score: name → instruments → review → setup with picture buttons | One sheet | Keep one sheet (fewer steps), take the picture buttons for key and time and − / + for numbers |

Not to copy: Flat's icons and artwork, its paid badges, the right-hand drawer (our gear and top bar already
hold those), Back leaving the editor (ours closes the top panel first).

**Decisions for the owner:**
1. **Piano strip or letters?** Flat's strip is always visible, shows the picked note, takes chords and needs no
   octave rule, but costs about 280 px of a phone's height. Letters cost one row. Proposal: the piano strip as
   Flat has it, with the letters kept for a hardware keyboard only.
2. **A note longer than the bar's room:** cut to fit (Flat) or tied over the barline (desktop MuseScore, and
   the owner's rule for Sing it in, #35)? The two standing wishes disagree here: "as Flat" and "match desktop".
3. **One part at a time on phones?** It changes the page behind Edit (a part-only layout from the engine).
   Proposal: yes, on phones only, with an *All* switch, as Flat.
