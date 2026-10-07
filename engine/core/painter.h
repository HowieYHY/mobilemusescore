/*
 * SPDX-License-Identifier: GPL-3.0-only
 *
 * A muse::draw::IPaintProvider that records MuseScore's drawing calls as a
 * compact JSON list, which the app replays onto an HTML canvas.
 *
 * Coordinates are engraving units (1200 per inch). Text and music symbols
 * carry the font file MuseScore's own font database resolved them to, so the
 * browser draws them with exactly the faces MuseScore measured.
 */
#pragma once

#include <functional>
#include <map>
#include <string>
#include <vector>

#include "draw/ipaintprovider.h"

namespace mss {
class RecordingPaintProvider : public muse::draw::IPaintProvider
{
public:
    // Maps a font to the resource path of the file that renders it ("" if unknown).
    using FontResolver = std::function<std::string(const muse::draw::Font&)>;

    explicit RecordingPaintProvider(FontResolver resolver);

    std::string takeJson();

    bool isActive() const override { return true; }
    void beginTarget(const std::string&) override {}
    void beforeEndTargetHook(muse::draw::Painter*) override {}
    bool endTarget(bool) override { return true; }
    void beginObject(const std::string&) override {}
    void endObject() override {}

    void setAntialiasing(bool) override {}
    void setCompositionMode(muse::draw::CompositionMode) override {}
    void setWindow(const muse::RectF&) override {}
    void setViewport(const muse::RectF&) override {}

    void setFont(const muse::draw::Font& font) override;
    const muse::draw::Font& font() const override { return m_state.font; }

    void setPen(const muse::draw::Pen& pen) override;
    void setNoPen() override;
    const muse::draw::Pen& pen() const override { return m_state.pen; }

    void setBrush(const muse::draw::Brush& brush) override;
    const muse::draw::Brush& brush() const override { return m_state.brush; }

    void save() override;
    void restore() override;

    double deviceLogicalDpi() const override { return 1200.0; }

    void setTransform(const muse::draw::Transform& transform) override;
    const muse::draw::Transform& transform() const override { return m_state.transform; }

    void drawPath(const muse::draw::PainterPath& path) override;
    void drawPolygon(const muse::PointF* points, size_t pointCount, muse::draw::PolygonMode mode) override;

    void drawText(const muse::PointF& point, const muse::String& text) override;
#ifdef MSS_MUSESCORE_4_7
    void drawText(const muse::RectF& rect, int flags, const muse::String& text) override;
    void drawTextWorkaround(const muse::draw::Font& f, const muse::PointF& pos, const muse::String& text) override;
#else
    void drawText(const muse::RectF& rect, muse::draw::Alignment alignment, muse::draw::TextFlags textFlags,
                  const muse::String& text) override;
#endif
    void drawSymbol(const muse::PointF& point, char32_t ucs4Code) override;

    void drawPixmap(const muse::PointF& point, const muse::draw::Pixmap& pm) override;
    void drawTiledPixmap(const muse::RectF& rect, const muse::draw::Pixmap& pm, const muse::PointF& offset) override;

    // false: Paint::paintScore then clips to the page's own rectangle. With true it
    // clips to the page's position on the multi-page canvas, which hides every page
    // after the first when pages are drawn one at a time at the origin.
    bool hasClipping() const override { return false; }
    void setClipRect(const muse::RectF& rect) override;
    void setMask(const muse::RectF& background, const std::vector<muse::RectF>& maskRects) override;
    void setClipping(bool enable) override;

private:
    struct State {
        muse::draw::Font font;
        muse::draw::Pen pen;
        muse::draw::Brush brush;
        muse::draw::Transform transform;
    };

    void op(const std::string& s);
    void flushFont();
    std::string fontId(const muse::draw::Font& f);

    FontResolver m_resolver;
    State m_state;
    std::vector<State> m_stack;
    bool m_fontDirty = true;
    std::string m_json;
    bool m_first = true;
    std::map<std::string, int> m_fontIds;
};
}
