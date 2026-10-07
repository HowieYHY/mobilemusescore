/*
 * SPDX-License-Identifier: GPL-3.0-only
 *
 * See fonts.h. Registration follows muse::draw::DrawModule::registerExports /
 * onInit (muse_framework, GPL-3.0-only) without the Qt providers.
 */
#include "fonts.h"

#include "global/modularity/ioc.h"

// MuseScore 5.0's font engine (this file is compiled with 5.0's draw headers first)
#include "internal/fontsdatabase.h"
#include "internal/fontsengine.h"

#ifdef MSS_MUSESCORE_4_7
#include "draw/ifontprovider.h" // 4.7's interface, as 4.7's engraving uses it
#else
#include "internal/fontprovider.h"
#endif

using namespace muse;
using namespace muse::draw;

namespace {
const std::string MODULE = "mss";

#ifdef MSS_MUSESCORE_4_7
// MuseScore 4.7's IFontProvider in front of 5.0's engine: what 5.0's
// FontProvider (framework/draw/internal/fontprovider.cpp) does, minus the
// three metrics 4.7's interface does not have.
class FontProvider47 : public IFontProvider
{
public:
    explicit FontProvider47(std::shared_ptr<IFontsEngine> engine)
        : m_engine(std::move(engine)) {}

    int addSymbolFont(const String&, const io::path_t&) override { return 1; }

    double lineSpacing(const Font& f) const override { return m_engine->lineSpacing(f); }
    double xHeight(const Font& f) const override { return m_engine->xHeight(f); }
    double height(const Font& f) const override { return m_engine->height(f); }
    double capHeight(const Font& f) const override { return m_engine->capHeight(f); }
    double ascent(const Font& f) const override { return m_engine->ascent(f); }
    double descent(const Font& f) const override { return m_engine->descent(f); }
    bool inFont(const Font& f, char32_t ucs4) const override { return m_engine->inFont(f, ucs4); }

    double horizontalAdvance(const Font& f, const String& s) const override
    {
        return m_engine->horizontalAdvance(f, s.toStdU32String());
    }

    double horizontalAdvance(const Font& f, char32_t ucs4) const override { return m_engine->horizontalAdvance(f, ucs4); }

    RectF boundingRect(const Font& f, const String& s) const override { return m_engine->boundingRect(f, s.toStdU32String()); }
    RectF boundingRect(const Font& f, char32_t ucs4) const override { return m_engine->boundingRect(f, ucs4); }
    RectF tightBoundingRect(const Font& f, const String& s) const override
    {
        return m_engine->tightBoundingRect(f, s.toStdU32String());
    }

private:
    std::shared_ptr<IFontsEngine> m_engine;
};
#endif

std::shared_ptr<FontsDatabase> s_db;
}

void mss::fonts::registerEngine()
{
    auto ioc = modularity::globalIoc();
    s_db = std::make_shared<FontsDatabase>();
    ioc->registerExport<IFontsDatabase>(MODULE, s_db);

    auto engine = std::make_shared<FontsEngine>(nullptr);
    ioc->registerExport<IFontsEngine>(MODULE, engine);

#ifdef MSS_MUSESCORE_4_7
    ioc->registerExport<IFontProvider>(MODULE, std::make_shared<FontProvider47>(engine));
#else
    ioc->registerExport<IFontProvider>(MODULE, new FontProvider(nullptr));
#endif

    engine->init();
}

void mss::fonts::addFont(const FontDataKey& key, const std::string& path)
{
    s_db->addFont(key, io::path_t(path));
}

void mss::fonts::setDefaultFont(Font::Type type, const FontDataKey& key)
{
    s_db->setDefaultFont(type, key);
}

void mss::fonts::insertSubstitution(const String& family, const String& substitute)
{
    s_db->insertSubstitution(family, substitute);
}

FontDataKey mss::fonts::actualFont(const FontDataKey& key, Font::Type type)
{
    return s_db->actualFont(key, type);
}
