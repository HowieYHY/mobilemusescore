/*
 * SPDX-License-Identifier: GPL-3.0-only
 *
 * muse::draw::IImageProvider without Qt. MuseScore keeps a picture's encoded
 * bytes (PNG, JPEG, GIF, BMP) in a Pixmap; layout only needs its pixel size,
 * which is read from the file header here. The browser decodes and draws the
 * bytes (see painter.cpp "img" and app/src/render/pagerenderer.ts).
 */
#pragma once

#include "draw/iimageprovider.h"
#include "draw/types/pixmap.h"

namespace mss {
class ImageProvider : public muse::draw::IImageProvider
{
public:
    std::shared_ptr<muse::draw::Pixmap> createPixmap(const muse::ByteArray& data) const override
    {
        return std::make_shared<muse::draw::Pixmap>(data, imageSize(data));
    }

    std::shared_ptr<muse::draw::Pixmap> createPixmap(int w, int h, int, const muse::draw::Color&) const override
    {
        return std::make_shared<muse::draw::Pixmap>(w, h);
    }

    muse::draw::Pixmap scaled(const muse::draw::Pixmap& origin, const muse::Size& s) const override
    {
        return muse::draw::Pixmap(origin.data(), s);
    }

    muse::draw::IPaintProviderPtr painterForImage(std::shared_ptr<muse::draw::Pixmap>) override
    {
        return nullptr; // drawing into images (thumbnails, exports) is not needed by a player
    }

    void saveAsPng(std::shared_ptr<muse::draw::Pixmap>, muse::io::IODevice*) override {}

    static muse::Size imageSize(const muse::ByteArray& ba)
    {
        const uint8_t* d = ba.constData();
        const size_t n = ba.size();
        auto be16 = [d](size_t i) { return int(d[i]) << 8 | d[i + 1]; };
        auto le16 = [d](size_t i) { return int(d[i + 1]) << 8 | d[i]; };
        auto be32 = [d](size_t i) { return int(d[i]) << 24 | int(d[i + 1]) << 16 | int(d[i + 2]) << 8 | d[i + 3]; };
        auto le32 = [d](size_t i) { return int(d[i + 3]) << 24 | int(d[i + 2]) << 16 | int(d[i + 1]) << 8 | d[i]; };

        if (n >= 24 && d[0] == 0x89 && d[1] == 'P' && d[2] == 'N' && d[3] == 'G') {
            return muse::Size(be32(16), be32(20));
        }
        if (n >= 10 && d[0] == 'G' && d[1] == 'I' && d[2] == 'F') {
            return muse::Size(le16(6), le16(8));
        }
        if (n >= 26 && d[0] == 'B' && d[1] == 'M') {
            return muse::Size(le32(18), std::abs(le32(22)));
        }
        if (n >= 4 && d[0] == 0xFF && d[1] == 0xD8) {
            // JPEG: find a start-of-frame marker
            size_t i = 2;
            while (i + 9 < n) {
                if (d[i] != 0xFF) {
                    ++i;
                    continue;
                }
                const uint8_t marker = d[i + 1];
                if (marker >= 0xC0 && marker <= 0xCF && marker != 0xC4 && marker != 0xC8 && marker != 0xCC) {
                    return muse::Size(be16(i + 7), be16(i + 5));
                }
                i += 2 + be16(i + 2);
            }
        }
        return muse::Size();
    }
};
}
