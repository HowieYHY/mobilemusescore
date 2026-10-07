# Third-party notices

This app is built from, and ships, the following components. Full licence
texts are in the referenced files inside `third_party/`.

| Component | Licence | Where |
| --- | --- | --- |
| MuseScore Studio 4.7.5 (engraving, playback model, file reading, audio engine) — © MuseScore Limited and others | GPL-3.0-only | `third_party/musescore-4.7/LICENSE.txt` |
| MuseScore Studio 5.0 development sources (alternative build; font engine used in all builds) — © MuseScore Limited and others | GPL-3.0-only | `third_party/musescore/LICENSE.txt` |
| Muse Framework (audio engine, drawing, fonts engine, global) — © MuseScore Limited and others | GPL-3.0-only | `third_party/muse/LICENSE.txt` |
| FluidSynth 2.3.3 (part of Muse Framework) | LGPL-2.1-or-later | `third_party/muse/framework/audio/thirdparty/fluidsynth/fluidsynth-2.3.3/LICENSE` |
| MS Basic sound font — S. Christian Collins, based on FluidR3Mono (Michael Cowgill) and FluidR3 (Frank Wen) | MIT | `third_party/musescore/share/sound/MS Basic_License.md` |
| Leland, Leland Text, Edwin fonts — MuseScore | SIL Open Font License 1.1 | `third_party/musescore/fonts/leland/LICENSE.txt`, `fonts/edwin/` |
| Bravura and Petaluma (Steinberg), Gootville (G. Pruchniakowski), MuseJazz, Campania (M. Sabatella), Finale Maestro / Broadway (MakeMusic, reserved font names), MScore Text | SIL Open Font License 1.1 (see each folder or the font's embedded licence) | `third_party/musescore/fonts/*` |
| MScore (Emmentaler, derived from GNU LilyPond's Feta) | GPL-3.0-or-later with font exception (embedded in the font) | `third_party/musescore/fonts/mscore/` |
| FreeSerif, FreeSans (GNU FreeFont) | GPL-3.0-or-later with font exception | `third_party/musescore/fonts/` |
| picojson, pugixml, utfcpp (via muse_deps, SHA-256 pinned) | BSD-2-Clause, MIT, BSL-1.0 | fetched at build time |
| FreeType, HarfBuzz, zlib (Emscripten ports) | FreeType License, MIT ("Old MIT"), zlib | Emscripten |
| Capacitor (Android wrapper) | MIT | `app/node_modules/@capacitor/*` |

"MuseScore" is a trademark of MuseScore Limited. This project is not affiliated
with or endorsed by MuseScore Limited.
