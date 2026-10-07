/*
 * SPDX-License-Identifier: GPL-3.0-only
 *
 * The font engine MuseScore's layout measures text and symbols with.
 *
 * Every build uses MuseScore 5.0's FreeType font engine
 * (muse_framework/framework/draw/internal): it is the production engine of
 * 5.0 and was written to reproduce the Qt font metrics that MuseScore 4.x
 * desktop builds lay scores out with. MuseScore 4.7's own FreeType engine is
 * an early version that desktop 4.7 never used (it measures text with Qt),
 * and it produced invalid layouts for some scores.
 *   fonts50.cpp - the engine, built with 5.0's headers. In 4.7 builds it also
 *                 provides the IFontProvider that 4.7's engraving expects.
 */
#pragma once

#include "draw/types/font.h"
#include "draw/types/fontstypes.h"

namespace mss::fonts {
// Registers IFontProvider (and the engine behind it) with MuseScore's IoC.
void registerEngine();

void addFont(const muse::draw::FontDataKey& key, const std::string& path);
void setDefaultFont(muse::draw::Font::Type type, const muse::draw::FontDataKey& key);
void insertSubstitution(const muse::String& family, const muse::String& substitute);

// The font that actually serves a request, after defaults and substitutions.
muse::draw::FontDataKey actualFont(const muse::draw::FontDataKey& key, muse::draw::Font::Type type);
}
