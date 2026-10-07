/*
 * SPDX-License-Identifier: GPL-3.0-only
 *
 * muse::ICryptographicHash without Qt: MD4 (RFC 1320), the only algorithm
 * MuseScore asks for (its image store names pictures by their MD4 hash).
 */
#pragma once

#include <cstdint>
#include <cstring>
#include <vector>

#include "global/icryptographichash.h"

namespace mss {
class Md4Hash : public muse::ICryptographicHash
{
public:
    muse::ByteArray hash(const muse::ByteArray& data, Algorithm) const override
    {
        uint32_t a = 0x67452301, b = 0xefcdab89, c = 0x98badcfe, d = 0x10325476;

        std::vector<uint8_t> msg(data.constData(), data.constData() + data.size());
        const uint64_t bitLen = uint64_t(data.size()) * 8;
        msg.push_back(0x80);
        while (msg.size() % 64 != 56) {
            msg.push_back(0);
        }
        for (int i = 0; i < 8; ++i) {
            msg.push_back(static_cast<uint8_t>(bitLen >> (8 * i)));
        }

        auto rol = [](uint32_t x, int s) { return (x << s) | (x >> (32 - s)); };
        auto F = [](uint32_t x, uint32_t y, uint32_t z) { return (x & y) | (~x & z); };
        auto G = [](uint32_t x, uint32_t y, uint32_t z) { return (x & y) | (x & z) | (y & z); };
        auto H = [](uint32_t x, uint32_t y, uint32_t z) { return x ^ y ^ z; };

        for (size_t off = 0; off < msg.size(); off += 64) {
            uint32_t X[16];
            for (int i = 0; i < 16; ++i) {
                X[i] = uint32_t(msg[off + i * 4]) | uint32_t(msg[off + i * 4 + 1]) << 8
                       | uint32_t(msg[off + i * 4 + 2]) << 16 | uint32_t(msg[off + i * 4 + 3]) << 24;
            }
            uint32_t aa = a, bb = b, cc = c, dd = d;

            static const int r1[4] = { 3, 7, 11, 19 };
            for (int i = 0; i < 16; ++i) {
                switch (i % 4) {
                case 0: a = rol(a + F(b, c, d) + X[i], r1[0]);
                    break;
                case 1: d = rol(d + F(a, b, c) + X[i], r1[1]);
                    break;
                case 2: c = rol(c + F(d, a, b) + X[i], r1[2]);
                    break;
                case 3: b = rol(b + F(c, d, a) + X[i], r1[3]);
                    break;
                }
            }

            static const int r2[4] = { 3, 5, 9, 13 };
            for (int i = 0; i < 16; ++i) {
                const int k = (i % 4) * 4 + i / 4;
                switch (i % 4) {
                case 0: a = rol(a + G(b, c, d) + X[k] + 0x5a827999, r2[0]);
                    break;
                case 1: d = rol(d + G(a, b, c) + X[k] + 0x5a827999, r2[1]);
                    break;
                case 2: c = rol(c + G(d, a, b) + X[k] + 0x5a827999, r2[2]);
                    break;
                case 3: b = rol(b + G(c, d, a) + X[k] + 0x5a827999, r2[3]);
                    break;
                }
            }

            static const int r3[4] = { 3, 9, 11, 15 };
            static const int order3[16] = { 0, 8, 4, 12, 2, 10, 6, 14, 1, 9, 5, 13, 3, 11, 7, 15 };
            for (int i = 0; i < 16; ++i) {
                const int k = order3[i];
                switch (i % 4) {
                case 0: a = rol(a + H(b, c, d) + X[k] + 0x6ed9eba1, r3[0]);
                    break;
                case 1: d = rol(d + H(a, b, c) + X[k] + 0x6ed9eba1, r3[1]);
                    break;
                case 2: c = rol(c + H(d, a, b) + X[k] + 0x6ed9eba1, r3[2]);
                    break;
                case 3: b = rol(b + H(c, d, a) + X[k] + 0x6ed9eba1, r3[3]);
                    break;
                }
            }

            a += aa;
            b += bb;
            c += cc;
            d += dd;
        }

        muse::ByteArray out(16);
        const uint32_t words[4] = { a, b, c, d };
        for (int w = 0; w < 4; ++w) {
            for (int i = 0; i < 4; ++i) {
                out.data()[w * 4 + i] = static_cast<uint8_t>(words[w] >> (8 * i));
            }
        }
        return out;
    }
};
}
