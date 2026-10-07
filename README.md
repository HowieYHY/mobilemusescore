# PocketScore

**Your MuseScore scores on your phone or tablet: read them, play them, practise your part.**

PocketScore opens the `.mscz` files you make in MuseScore and plays them with the same
MS Basic sounds you hear on your computer. Turn instruments or voices up, down, off or
solo them to practise your own part. It works without an internet connection.

**Open PocketScore: https://howieyhy.github.io/mobilemusescore/**

---

## Install

You don't need an app store.

### iPad and iPhone
1. Open **https://howieyhy.github.io/mobilemusescore/** in **Safari**.
2. Tap the **Share** button, then **Add to Home Screen**, then **Add**.
3. Open **PocketScore** from your home screen.

### Android
1. Open **https://howieyhy.github.io/mobilemusescore/** in **Chrome**.
2. Tap **Install PocketScore** on the start screen, then **Install**.
   (If you don't see the button, tap Chrome's **⋮** menu, then **Add to Home screen**, then **Install**.)
3. Open **PocketScore** from your home screen or app list. It opens in its own window, like any app.

### Computer
Open the link in Chrome, Edge or Safari. Chrome and Edge also offer **Install PocketScore**.

**The first time you press Play**, PocketScore downloads its instrument sounds (about 50 MB),
so use Wi-Fi. After that it works offline.

### Updates
When you open PocketScore with internet, it checks for a new version and downloads only what
changed. When it's ready, PocketScore restarts by itself, or, if a score is open, asks you to tap
the yellow bar. This is the same on every device. The version number is on the start screen.

---

## Using PocketScore

### Open a score
Tap **Open score** and choose a `.mscz` file. On iPad and iPhone, first save your scores to the
**Files** app (AirDrop them, or save them from email or a cloud drive).

### Play
| To… | Do this |
| --- | --- |
| Play or pause | Tap **▶** / **❚❚** |
| Go back to the start | Tap **⏮** |
| Jump anywhere | Drag the position slider |
| Play from a particular note | Tap the note or rest in the score |
| Hear a note | While stopped, tap it: it sounds, and Play starts from there |
| Zoom | Pinch, or use **−** and **+** |
| Change the layout | Use the menu at the top right: *Page view*, *Continuous (vertical)* or *Continuous (horizontal)* |
| Close a panel | Tap **Done**, or use your phone's **Back** button or gesture |

A blue line shows where you are in the music, and the page follows it as it plays.
If you scroll away, it waits a moment before following again.

### Write on the score
Tap the **pencil** button at the top:
- **Pen** and **Highlight**: write or mark with a stylus (Apple Pencil, S Pen) or your finger.
- **Draw with finger**: when it's on, one finger draws and two fingers scroll. Turn it off to scroll
  with one finger and draw only with a stylus. It starts on, and turns off by itself the first time
  you use a stylus (you can turn it back on).
- **Text**: **double-tap** the score to add a text box, then type. Tap once outside the box when
  you're done. Tap a box to change it, drag the arrows to move it, tap **×** to delete it.
- **Erase**: tap or rub over a mark or text box.
- **Colours**: black (the default), white, red, blue, green and yellow. Tap **+** for more colours,
  or pick any colour. While you're typing in a text box, a new colour changes that box.
- **Undo** and **Clear** (everything on this score).

**Notes save by themselves** as you write: the bar says *Saved on this device*. There is no Save
button to remember. Tap **Done** to go back to playing. Your notes come back when you open the same
score again, even if you rename the file. They stay on the device: they are not added to the `.mscz`
file and are not shared. Notes made in page view and in the continuous views are kept separately.

### Mixer: practise your part
Tap **Mixer**:
- **Slider**: how loud that part is, compared with the score. **100%** (the small mark in the
  middle) is as the score was saved; **50%** sounds about half as loud, **200%** about twice as loud.
- **M** (mute): silences that part. It shows **Muted**.
- **S** (solo): plays only that part; you can solo several. The other parts are dimmed.
- **The sound under a part's name** (for example *Grand Piano*): tap it to play that part with a
  different instrument sound. The sounds are grouped as in MuseScore's mixer; *In score* marks the
  one the score uses.
- **Reverb**: tap **Reverb** at the top to show how much room echo each part has.
- **Master**: the overall volume.

PocketScore starts with the volume, mute and solo settings saved in your score, as MuseScore does.
If a score opens with no sound, check whether its parts were saved muted.

**Saving mixer changes.** Mixer changes are for practising now, until you keep them:
- After a change, the mixer says *Changes not saved*, with **Save** and **Discard**, and the
  **Mixer** button gets a yellow dot.
- **Save** keeps them for this score on this device, for next time you open it.
  **Discard** puts the mixer back as it was.
- If you open another score first, PocketScore asks whether to save them. If you close the app
  without saving, they come back next time you open the score, and you can save or discard them then.
- Once saved, the mixer says *Using your saved settings*. **Use score's settings** goes back to the
  score's own mixer.
- Your score file is never changed.

---

## Questions

**Does it sound like MuseScore on my computer?**
Yes, if your scores use MuseScore's standard **MS Basic** sounds. PocketScore uses the same sound
engine and sounds as MuseScore 4.7.5. In side-by-side tests the volume, timing and tone matched
desktop MuseScore.

**What about Muse Sounds or other sound libraries?**
Muse Sounds, VST plugins and extra sound fonts only work in desktop MuseScore. Parts that use
them play with the nearest MS Basic sound instead, and the mixer tells you which ones.

**Does the page look exactly like MuseScore?**
Very nearly. PocketScore lays scores out with MuseScore's own code, so the pages, systems and
page breaks match. Spacing can differ very slightly, because computers and phones measure text
a little differently.

**Can I edit scores?**
No. PocketScore is for reading and playing. Make changes in MuseScore.

**Are my scores uploaded anywhere?**
No. Everything happens on your device. Your scores are never sent anywhere.

**Which files does it open?**
MuseScore files: `.mscz` (and uncompressed `.mscx`). Not PDF, MusicXML or MIDI.

---

## Something not working?

- **No sound on iPhone or iPad:** check the volume buttons, and that Bluetooth isn't sending sound to another device.
- **"Audio could not start":** close PocketScore completely, reopen it, and tap Play again.
- **Drawing scrolls the page instead (or the page won't scroll):** check **Draw with finger** in the notes bar.
- **Choppy sound or jumpy scrolling:** make sure you have the latest version (shown on the start screen, and at the bottom of the mixer). If it still happens, play the score for a minute, open the **Mixer**, and send a screenshot of the *Playback check* line at the bottom, with your phone model. It says how busy the sound engine is (well under 100% is fine), whether the moving line jumped, and whether the sound had gaps.
- **A score won't open:** make sure it is a `.mscz` file saved by MuseScore.

To report a problem, [open an issue](https://github.com/HowieYHY/mobilemusescore/issues) or send the
developer a message. Please include:
- your device and its system version (for example "iPad, iPadOS 26.6");
- which score you used;
- what you did, and what happened instead;
- a screenshot or screen recording, if you can.

---

PocketScore is free and open source (GPL-3.0). It is built with code from MuseScore Studio and uses
the MS Basic sound font; see [credits and licences](THIRD_PARTY_NOTICES.md).
PocketScore is not affiliated with or endorsed by MuseScore Ltd. "MuseScore" is a trademark of MuseScore Ltd.

Developers: see [docs/DEVELOPMENT.md](docs/DEVELOPMENT.md).
