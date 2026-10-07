/*
 * SPDX-License-Identifier: GPL-3.0-only
 *
 * Output format (one JSON array of ops; numbers rounded to 0.01 units):
 *   ["T",m11,m12,m21,m22,dx,dy]            set transform
 *   ["P",color|null,width,cap,join,[dash]] pen (null = no pen; cap/join: 0 flat/miter, 1 square/bevel, 2 round)
 *   ["B",color|null]                       brush (null = no brush)
 *   ["F",file,sizePx,bold,italic]          font: resource path of the font file, size in units
 *   ["S"] / ["R"]                          save / restore
 *   ["p",fillRule,[cmd,x,y,...]]           path: cmd 0 move, 1 line, 2 cubic (x1,y1,x2,y2,x,y)
 *   ["g",mode,[x,y,...]]                   polygon: 0 odd-even, 1 winding, 2 convex, 3 polyline
 *   ["t",x,y,text]                         text at baseline point
 *   ["tr",x,y,w,h,align,text]              text in rectangle
 *   ["y",x,y,codepoint]                    music symbol
 *   ["c",x,y,w,h] / ["c"]                  clip rect / clipping off
 *   ["img",x,y,w,h,dataUrl]                picture (PNG/JPEG/GIF/BMP bytes), w/h in its pixels
 * Colors are "#rrggbbaa".
 */
#include "painter.h"

#include <cmath>
#include <cstdio>

#include "draw/types/painterpath.h"

using namespace muse;
using namespace muse::draw;
using namespace mss;

static std::string num(double v)
{
    if (!std::isfinite(v)) {
        return "0";
    }
    char buf[32];
    double r = std::round(v * 100.0) / 100.0;
    if (r == 0.0) {
        r = 0.0; // avoid "-0"
    }
    std::snprintf(buf, sizeof(buf), "%.2f", r);
    // trim trailing zeros
    std::string s(buf);
    if (s.find('.') != std::string::npos) {
        while (!s.empty() && s.back() == '0') {
            s.pop_back();
        }
        if (!s.empty() && s.back() == '.') {
            s.pop_back();
        }
    }
    return s;
}

static std::string jsonStr(const std::string& s)
{
    std::string out = "\"";
    for (unsigned char c : s) {
        switch (c) {
        case '"': out += "\\\""; break;
        case '\\': out += "\\\\"; break;
        case '\n': out += "\\n"; break;
        case '\r': out += "\\r"; break;
        case '\t': out += "\\t"; break;
        default:
            if (c < 0x20) {
                char buf[8];
                std::snprintf(buf, sizeof(buf), "\\u%04x", c);
                out += buf;
            } else {
                out += static_cast<char>(c);
            }
        }
    }
    out += "\"";
    return out;
}

static std::string color(const Color& c)
{
    char buf[16];
    std::snprintf(buf, sizeof(buf), "\"#%02x%02x%02x%02x\"", c.red(), c.green(), c.blue(), c.alpha());
    return buf;
}

RecordingPaintProvider::RecordingPaintProvider(FontResolver resolver)
    : m_resolver(std::move(resolver))
{
    m_json.reserve(1 << 16);
    m_json = "[";
}

std::string RecordingPaintProvider::takeJson()
{
    std::string out = m_json + "]";
    m_json = "[";
    m_first = true;
    m_fontDirty = true;
    return out;
}

void RecordingPaintProvider::op(const std::string& s)
{
    if (!m_first) {
        m_json += ",";
    }
    m_first = false;
    m_json += s;
}

void RecordingPaintProvider::setFont(const Font& font)
{
    m_state.font = font;
    m_fontDirty = true;
}

void RecordingPaintProvider::flushFont()
{
    if (!m_fontDirty) {
        return;
    }
    m_fontDirty = false;

    const Font& f = m_state.font;
    double size = f.pixelSize() > 0 ? f.pixelSize() : f.pointSizeF() * 1200.0 / 72.0;
    std::string file = m_resolver ? m_resolver(f) : std::string();
    op("[\"F\"," + jsonStr(file) + "," + num(size) + "," + (f.bold() ? "1" : "0") + "," + (f.italic() ? "1" : "0") + "]");
}

void RecordingPaintProvider::setPen(const Pen& pen)
{
    m_state.pen = pen;
    if (pen.style() == PenStyle::NoPen) {
        op("[\"P\",null]");
        return;
    }

    auto capIdx = [](PenCapStyle c) {
        switch (c) {
        case PenCapStyle::SquareCap: return 1;
        case PenCapStyle::RoundCap: return 2;
        default: return 0;
        }
    };
    auto joinIdx = [](PenJoinStyle j) {
        switch (j) {
        case PenJoinStyle::BevelJoin: return 1;
        case PenJoinStyle::RoundJoin: return 2;
        default: return 0;
        }
    };

    std::string dash = "[";
    std::vector<double> pattern;
    switch (pen.style()) {
    case PenStyle::DashLine: pattern = { 4, 2 };
        break;
    case PenStyle::DotLine: pattern = { 1, 2 };
        break;
    case PenStyle::DashDotLine: pattern = { 4, 2, 1, 2 };
        break;
    case PenStyle::DashDotDotLine: pattern = { 4, 2, 1, 2, 1, 2 };
        break;
    case PenStyle::CustomDashLine: pattern = pen.dashPattern();
        break;
    default: break;
    }
    for (size_t i = 0; i < pattern.size(); ++i) {
        if (i) {
            dash += ",";
        }
        dash += num(pattern[i]); // in pen widths, like Qt
    }
    dash += "]";

    op("[\"P\"," + color(pen.color()) + "," + num(pen.widthF()) + "," + std::to_string(capIdx(pen.capStyle())) + ","
       + std::to_string(joinIdx(pen.joinStyle())) + "," + dash + "]");
}

void RecordingPaintProvider::setNoPen()
{
    m_state.pen.setStyle(PenStyle::NoPen);
    op("[\"P\",null]");
}

void RecordingPaintProvider::setBrush(const Brush& brush)
{
    m_state.brush = brush;
    if (brush.style() == BrushStyle::NoBrush) {
        op("[\"B\",null]");
    } else {
        op("[\"B\"," + color(brush.color()) + "]");
    }
}

void RecordingPaintProvider::save()
{
    m_stack.push_back(m_state);
    op("[\"S\"]");
}

void RecordingPaintProvider::restore()
{
    if (!m_stack.empty()) {
        m_state = m_stack.back();
        m_stack.pop_back();
    }
    m_fontDirty = true;
    op("[\"R\"]");
}

void RecordingPaintProvider::setTransform(const Transform& t)
{
    m_state.transform = t;
    op("[\"T\"," + num(t.m11() * 1000) + "," + num(t.m12() * 1000) + "," + num(t.m21() * 1000) + "," + num(t.m22() * 1000) + ","
       + num(t.dx()) + "," + num(t.dy()) + "]");
}

void RecordingPaintProvider::drawPath(const PainterPath& path)
{
    std::string s = "[\"p\"," + std::to_string(path.fillRule() == PainterPath::FillRule::WindingFill ? 1 : 0) + ",[";
    bool first = true;
    auto add = [&](const std::string& v) {
        if (!first) {
            s += ",";
        }
        first = false;
        s += v;
    };

    const size_t n = path.elementCount();
    for (size_t i = 0; i < n; ++i) {
        PainterPath::Element e = path.elementAt(i);
        switch (e.type) {
        case PainterPath::ElementType::MoveToElement:
            add("0");
            add(num(e.x));
            add(num(e.y));
            break;
        case PainterPath::ElementType::LineToElement:
            add("1");
            add(num(e.x));
            add(num(e.y));
            break;
        case PainterPath::ElementType::CurveToElement: {
            if (i + 2 < n) {
                PainterPath::Element c2 = path.elementAt(i + 1);
                PainterPath::Element end = path.elementAt(i + 2);
                add("2");
                add(num(e.x));
                add(num(e.y));
                add(num(c2.x));
                add(num(c2.y));
                add(num(end.x));
                add(num(end.y));
                i += 2;
            }
        } break;
        case PainterPath::ElementType::CurveToDataElement:
            break;
        }
    }
    s += "]]";
    op(s);
}

void RecordingPaintProvider::drawPolygon(const PointF* points, size_t pointCount, PolygonMode mode)
{
    std::string s = "[\"g\"," + std::to_string(static_cast<int>(mode)) + ",[";
    for (size_t i = 0; i < pointCount; ++i) {
        if (i) {
            s += ",";
        }
        s += num(points[i].x()) + "," + num(points[i].y());
    }
    s += "]]";
    op(s);
}

void RecordingPaintProvider::drawText(const PointF& point, const String& text)
{
    flushFont();
    op("[\"t\"," + num(point.x()) + "," + num(point.y()) + "," + jsonStr(text.toStdString()) + "]");
}

#ifdef MSS_MUSESCORE_4_7
// 4.7: alignment and text flags share one Qt-style int; the alignment bits are the low byte
void RecordingPaintProvider::drawText(const RectF& rect, int flags, const String& text)
{
    flushFont();
    op("[\"tr\"," + num(rect.x()) + "," + num(rect.y()) + "," + num(rect.width()) + "," + num(rect.height()) + ","
       + std::to_string(flags & 0xff) + "," + jsonStr(text.toStdString()) + "]");
}

// 4.7: text with an explicit font (Painter::drawTextWorkaround)
void RecordingPaintProvider::drawTextWorkaround(const Font& f, const PointF& pos, const String& text)
{
    setFont(f);
    drawText(pos, text);
}
#else
void RecordingPaintProvider::drawText(const RectF& rect, Alignment alignment, TextFlags, const String& text)
{
    flushFont();
    op("[\"tr\"," + num(rect.x()) + "," + num(rect.y()) + "," + num(rect.width()) + "," + num(rect.height()) + ","
       + std::to_string(static_cast<int>(alignment)) + "," + jsonStr(text.toStdString()) + "]");
}
#endif

void RecordingPaintProvider::drawSymbol(const PointF& point, char32_t ucs4Code)
{
    flushFont();
    op("[\"y\"," + num(point.x()) + "," + num(point.y()) + "," + std::to_string(static_cast<uint32_t>(ucs4Code)) + "]");
}

static std::string dataUrl(const ByteArray& ba)
{
    static const char* chars = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
    const uint8_t* d = ba.constData();
    const size_t n = ba.size();
    std::string mime = "image/png";
    if (n > 3 && d[0] == 0xFF && d[1] == 0xD8) {
        mime = "image/jpeg";
    } else if (n > 3 && d[0] == 'G' && d[1] == 'I') {
        mime = "image/gif";
    } else if (n > 2 && d[0] == 'B' && d[1] == 'M') {
        mime = "image/bmp";
    }
    std::string out = "\"data:" + mime + ";base64,";
    out.reserve(out.size() + n * 4 / 3 + 8);
    for (size_t i = 0; i < n; i += 3) {
        const uint32_t v = uint32_t(d[i]) << 16 | (i + 1 < n ? uint32_t(d[i + 1]) << 8 : 0) | (i + 2 < n ? d[i + 2] : 0);
        out += chars[(v >> 18) & 63];
        out += chars[(v >> 12) & 63];
        out += i + 1 < n ? chars[(v >> 6) & 63] : '=';
        out += i + 2 < n ? chars[v & 63] : '=';
    }
    return out + "\"";
}

void RecordingPaintProvider::drawPixmap(const PointF& point, const Pixmap& pm)
{
    op("[\"img\"," + num(point.x()) + "," + num(point.y()) + "," + num(pm.width()) + "," + num(pm.height()) + ","
       + (pm.isNull() ? std::string("null") : dataUrl(pm.data())) + "]");
}

void RecordingPaintProvider::drawTiledPixmap(const RectF& rect, const Pixmap& pm, const PointF&)
{
    // tiling is only used for desktop wallpapers; draw the picture once, stretched
    op("[\"img\"," + num(rect.x()) + "," + num(rect.y()) + "," + num(rect.width()) + "," + num(rect.height()) + ","
       + (pm.isNull() ? std::string("null") : dataUrl(pm.data())) + "]");
}

void RecordingPaintProvider::setClipRect(const RectF& rect)
{
    op("[\"c\"," + num(rect.x()) + "," + num(rect.y()) + "," + num(rect.width()) + "," + num(rect.height()) + "]");
}

void RecordingPaintProvider::setMask(const RectF& background, const std::vector<RectF>& maskRects)
{
    // ["m",bx,by,bw,bh,[x,y,w,h,...]]: clip to background minus mask rects
    std::string s = "[\"m\"," + num(background.x()) + "," + num(background.y()) + "," + num(background.width()) + ","
                    + num(background.height()) + ",[";
    for (size_t i = 0; i < maskRects.size(); ++i) {
        if (i) {
            s += ",";
        }
        const RectF& r = maskRects[i];
        s += num(r.x()) + "," + num(r.y()) + "," + num(r.width()) + "," + num(r.height());
    }
    s += "]]";
    op(s);
}

void RecordingPaintProvider::setClipping(bool enable)
{
    if (!enable) {
        op("[\"c\"]");
    }
}
