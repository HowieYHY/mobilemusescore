"""Repairs fonts that Chrome refuses to load.

Chrome (and Android's WebView) checks every web font with OTS, which rejects
a format 4 'cmap' table whose last segment isn't the 0xFFFF terminator.
MuseScore's BravuraText.otf has one (its last segment runs 0xF52B-0xFFFF), so
Chrome drops the font, and a page using it was not drawn. Desktop MuseScore
doesn't check fonts this way, so the font is fine there.

Only fonts with that fault are changed, and only their 'cmap' table is
rewritten (fontTools writes a correct terminator); every other table is kept
byte for byte (only the file checksum in 'head' changes, as it must).

Usage: python scripts/fix-fonts.py <font or folder> ...
"""

import os
import sys

from fontTools.ttLib import TTFont


def bad_format4(font):
    for sub in font["cmap"].tables:
        if sub.format != 4:
            continue
        # fontTools keeps the decoded mapping; check the raw segments it read
        raw = font.reader["cmap"]
        if raw_last_segment_bad(raw):
            return True
    return False


def raw_last_segment_bad(data):
    """True if a format 4 subtable's last segment is not 0xFFFF-0xFFFF."""
    import struct
    _, n = struct.unpack(">HH", data[:4])
    for i in range(n):
        _, _, offset = struct.unpack(">HHL", data[4 + i * 8:12 + i * 8])
        fmt = struct.unpack(">H", data[offset:offset + 2])[0]
        if fmt != 4:
            continue
        seg_x2 = struct.unpack(">H", data[offset + 6:offset + 8])[0]
        ends = offset + 14
        last_end = struct.unpack(">H", data[ends + seg_x2 - 2:ends + seg_x2])[0]
        starts = ends + seg_x2 + 2
        last_start = struct.unpack(">H", data[starts + seg_x2 - 2:starts + seg_x2])[0]
        if last_end != 0xFFFF or last_start != 0xFFFF:
            return True
    return False


def fix(path):
    font = TTFont(path, recalcTimestamp=False, recalcBBoxes=False)
    if "cmap" not in font or not bad_format4(font):
        return False
    # decoding the table makes fontTools write it again, with a proper terminator
    for sub in font["cmap"].tables:
        _ = sub.cmap
    font.getGlyphOrder()
    # every other table is written from the original bytes, not re-encoded
    for tag in list(font.tables):
        if tag not in ("cmap", "head"):
            del font.tables[tag]
    font.save(path + ".tmp")
    font.close()
    os.replace(path + ".tmp", path)
    return True


def main(args):
    paths = []
    for a in args:
        if os.path.isdir(a):
            for root, _, files in os.walk(a):
                paths += [os.path.join(root, f) for f in files if f.lower().endswith((".otf", ".ttf"))]
        else:
            paths.append(a)
    fixed = [p for p in paths if fix(p)]
    for p in fixed:
        print("fixed cmap:", p)
    return 0


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
