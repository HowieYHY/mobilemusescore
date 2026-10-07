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
- **App:** download `PocketScore-…apk` from the [download page](https://github.com/HowieYHY/mobilemusescore/releases) and open it. If your phone asks, allow your browser to *install unknown apps*.
- **Or** open **https://howieyhy.github.io/mobilemusescore/** in **Chrome**, tap the **⋮** menu, then **Add to Home screen**.

### Computer
Open the link in Chrome, Edge or Safari.

**The first time you press Play**, PocketScore downloads its instrument sounds (about 50 MB),
so use Wi-Fi. After that it works offline.

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
| Zoom | Pinch, or use **−** and **+** |
| Change the layout | Use the menu at the top right: *Page view*, *Continuous (vertical)* or *Continuous (horizontal)* |

A blue line shows where you are in the music, and the page follows it as it plays.
If you scroll away, it waits a moment before following again.

### Mixer: practise your part
Tap **Mixer**:
- **Slider**: volume for that part.
- **M** (mute): silences that part.
- **S** (solo): plays only that part; you can solo several.
- **Reverb**: how much room echo that part has.
- **Master**: the overall volume.

PocketScore starts with the volume, mute and solo settings saved in your score, as MuseScore does.
If a score opens with no sound, check whether its parts were saved muted.

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
- **Choppy sound on Android:** known on some phones and being worked on. Closing other apps helps.
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
