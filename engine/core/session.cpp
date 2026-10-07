/*
 * SPDX-License-Identifier: GPL-3.0-only
 *
 * See session.h. Code marked "as in X" follows the named MuseScore Studio
 * function closely; see docs/MUSESCORE_REUSE.md.
 */
#include "session.h"

#include <emscripten.h>

#include <cmath>
#include <map>
#include <sstream>
#include <type_traits>

#include "global/modularity/ioc.h"
#include "global/async/processevents.h"
#include "global/io/ifilesystem.h"
#include "global/defer.h"

#include "draw/painter.h"
#include "draw/types/fontstypes.h"

#include "audio/common/audioutils.h"

#include "engraving/compat/engravingcompat.h"
#include "engraving/dom/box.h"
#include "engraving/dom/drumset.h"
#include "engraving/dom/figuredbass.h"
#include "engraving/dom/instrument.h"
#include "engraving/dom/masterscore.h"
#include "engraving/dom/measure.h"
#include "engraving/dom/mscore.h"
#include "engraving/dom/page.h"
#include "engraving/dom/part.h"
#include "engraving/dom/repeatlist.h"
#include "engraving/dom/segment.h"
#include "engraving/dom/staff.h"
#include "engraving/dom/stafftype.h"
#include "engraving/dom/system.h"
#ifndef MSS_MUSESCORE_4_7
#include "engraving/dom/tempotimeline.h"
#endif
#include "engraving/dom/textbase.h"
#include "engraving/infrastructure/localfileinfoprovider.h"
#include "engraving/infrastructure/mscreader.h"
#include "engraving/infrastructure/smufl.h"
#include "engraving/internal/engravingfontsprovider.h"
#include "engraving/rendering/score/scorerenderer.h"
#include "engraving/rendering/single/singlerenderer.h"
#include "engraving/rendering/editmode/editmoderenderer.h"
#include "engraving/rw/inoutdata.h"
#include "engraving/style/defaultstyle.h"

#include "articulationprofiles.h"
#include "engravingconfig.h"
#include "audiobackend.h"
#include "fonts.h"
#include "md4hash.h"
#include "imageprovider.h"
#include "painter.h"
#include "posixfilesystem.h"

#include "log.h"

using namespace muse;
using namespace muse::audio;
using namespace muse::draw;
using namespace mu::engraving;
using namespace mss;

static const std::string MODULE = "mss";

// mu::playback (src/playback/playbacktypes.h)
static constexpr aux_channel_idx_t AUX_CHANNEL_NUM = 2;
static constexpr aux_channel_idx_t REVERB_CHANNEL_IDX = 0;
static constexpr double PLAYBACK_TAIL_SECS = 3; // NotationPlayback::PLAYBACK_TAIL_SECS

EM_JS(void, mss_js_emit, (const char* type, const char* json), {
    if (Module["onEvent"]) {
        Module["onEvent"](UTF8ToString(type), UTF8ToString(json));
    }
});

// ---------------------------------------------------------------------------
// Helpers

// Played time <-> played ("unrolled", repeats expanded) ticks, as in
// NotationPlayback: 4.7 asks the score, 5.0 its tempo timeline.
static double uticksToSecs(const Score* sc, int utick)
{
#ifdef MSS_MUSESCORE_4_7
    return sc->utick2utime(utick);
#else
    return sc->tempoTimeline(true).utick2utime(utick);
#endif
}

static int secsToUticks(const Score* sc, double secs)
{
#ifdef MSS_MUSESCORE_4_7
    return sc->utime2utick(secs);
#else
    return sc->tempoTimeline(true).utime2utick(secs);
#endif
}

static const RepeatList& playedRepeats(const Score* sc)
{
#ifdef MSS_MUSESCORE_4_7
    return sc->repeatList(true);
#else
    return sc->expandedRepeatList();
#endif
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
    return out + "\"";
}

// Volume/balance are plain floats in 4.7 and number_t<float> (with raw()) in 5.0
template<typename T>
static double rawValue(const T& v)
{
    if constexpr (std::is_arithmetic_v<T>) {
        return static_cast<double>(v);
    } else {
        return static_cast<double>(v.raw());
    }
}

static std::string num(double v)
{
    if (!std::isfinite(v)) {
        return "0";
    }
    std::ostringstream ss;
    ss.precision(10);
    ss << v;
    return ss.str();
}

// ---------------------------------------------------------------------------
// Fonts: registered exactly as EngravingModule::onInit does, remembering which
// file serves each font so the page recorder can tell the browser.

static std::map<std::string, std::string> s_fontFiles; // "family|bold|italic" -> resource path

static std::string fontKeyStr(const FontDataKey& k)
{
    return k.family().id().toStdString() + "|" + (k.bold() ? "1" : "0") + "|" + (k.italic() ? "1" : "0");
}

static void initFonts(const std::shared_ptr<EngravingFontsProvider>& engravingFonts)
{
    auto addFont = [](const FontDataKey& key, const std::string& path) {
        fonts::addFont(key, path);
        s_fontFiles[fontKeyStr(key)] = path;
    };

    // Text
    addFont(FontDataKey(u"Edwin", false, false), ":/fonts/edwin/Edwin-Roman.otf");
    addFont(FontDataKey(u"Edwin", false, true), ":/fonts/edwin/Edwin-Italic.otf");
    addFont(FontDataKey(u"Edwin", true, false), ":/fonts/edwin/Edwin-Bold.otf");
    addFont(FontDataKey(u"Edwin", true, true), ":/fonts/edwin/Edwin-BdIta.otf");

    // MusicSymbol[Text]
    auto addMusicFont = [&](const std::string& name, const FontDataKey& key, const std::string& path) {
        addFont(key, path);
        engravingFonts->addInternalFont(name, key.family().id().toStdString(), io::path_t(path));
    };

    addMusicFont("Bravura", FontDataKey(u"Bravura"), ":/fonts/bravura/Bravura.otf");
    addFont(FontDataKey(u"Bravura Text"), ":/fonts/bravura/BravuraText.otf");
    addMusicFont("Leland", FontDataKey(u"Leland"), ":/fonts/leland/Leland.otf");
    addFont(FontDataKey(u"Leland Text"), ":/fonts/leland/LelandText.otf");
    addMusicFont("Emmentaler", FontDataKey(u"MScore"), ":/fonts/mscore/MScore.otf");
    addFont(FontDataKey(u"MScore Text"), ":/fonts/mscore/MScoreText.otf");
    addMusicFont("Gonville", FontDataKey(u"Gootville"), ":/fonts/gootville/Gootville.otf");
    addFont(FontDataKey(u"Gootville Text"), ":/fonts/gootville/GootvilleText.otf");
    addMusicFont("MuseJazz", FontDataKey(u"MuseJazz"), ":/fonts/musejazz/MuseJazz.otf");
    addFont(FontDataKey(u"MuseJazz Text"), ":/fonts/musejazz/MuseJazzText.otf");
    addMusicFont("Petaluma", FontDataKey(u"Petaluma"), ":/fonts/petaluma/Petaluma.otf");
    addFont(FontDataKey(u"Petaluma Text"), ":/fonts/petaluma/PetalumaText.otf");
    addMusicFont("Finale Maestro", FontDataKey(u"Finale Maestro"), ":/fonts/finalemaestro/FinaleMaestro.otf");
    addFont(FontDataKey(u"Finale Maestro Text"), ":/fonts/finalemaestro/FinaleMaestroText.otf");
    addMusicFont("Finale Broadway", FontDataKey(u"Finale Broadway"), ":/fonts/finalebroadway/FinaleBroadway.otf");
    addFont(FontDataKey(u"Finale Broadway Text"), ":/fonts/finalebroadway/FinaleBroadwayText.otf");

    // Tabulature
    addFont(FontDataKey(u"FreeSerif"), ":/fonts/FreeSerif.ttf");
    addFont(FontDataKey(u"FreeSerif", true, false), ":/fonts/FreeSerifBold.ttf");
    addFont(FontDataKey(u"FreeSerif", false, true), ":/fonts/FreeSerifItalic.ttf");
    addFont(FontDataKey(u"FreeSerif", true, true), ":/fonts/FreeSerifBoldItalic.ttf");
    addFont(FontDataKey(u"FreeSans"), ":/fonts/FreeSans.ttf");
#ifdef MSS_MUSESCORE_4_7
    addFont(FontDataKey(u"MScoreTabulature"), ":/fonts/mscoreTab.ttf");
#else
    addFont(FontDataKey(u"MuseScoreTabRenaiss"), ":/fonts/MuseScoreTabRenaiss.ttf");
    addFont(FontDataKey(u"MuseScoreTabPhalese"), ":/fonts/MuseScoreTabPhalese.ttf");
    addFont(FontDataKey(u"MuseScoreTabBonneuilDeVisee"), ":/fonts/MuseScoreTabBonneuilDeVisee.ttf");
    addFont(FontDataKey(u"MuseScoreTabBonneuilGaultier"), ":/fonts/MuseScoreTabBonneuilGaultier.ttf");
    addFont(FontDataKey(u"MuseScoreTabDowland"), ":/fonts/MuseScoreTabDowland.ttf");
    addFont(FontDataKey(u"MuseScoreTabLuteDidactic"), ":/fonts/MuseScoreTabLuteDidactic.ttf");
    addFont(FontDataKey(u"MuseScoreTabModern"), ":/fonts/MuseScoreTabModern.ttf");
    addFont(FontDataKey(u"MuseScoreTabItalian"), ":/fonts/MuseScoreTabItalian.ttf");
    addFont(FontDataKey(u"MuseScoreTabFrench"), ":/fonts/MuseScoreTabFrench.ttf");
    addFont(FontDataKey(u"MuseScoreTabFrenchBaroqueHeadless"), ":/fonts/MuseScoreTabFrenchBaroqueHeadless.ttf");
    addFont(FontDataKey(u"MuseScoreTabFrenchBaroque"), ":/fonts/MuseScoreTabFrenchBaroque.ttf");

#endif

    // Figured Bass
    addFont(FontDataKey(u"MscoreBC"), ":/fonts/mscore-BC.ttf");

    // Roman Numeral Analysis
    addFont(FontDataKey(u"Campania"), ":/fonts/campania/Campania.otf");

    // Defaults
    fonts::setDefaultFont(Font::Type::Unknown, FontDataKey(u"Edwin"));
    fonts::setDefaultFont(Font::Type::Text, FontDataKey(u"Edwin"));
    fonts::setDefaultFont(Font::Type::Tablature, FontDataKey(u"FreeSerif"));
    fonts::setDefaultFont(Font::Type::MusicSymbolText, FontDataKey(u"Bravura Text"));
    fonts::setDefaultFont(Font::Type::MusicSymbol, FontDataKey(u"Bravura"));

    engravingFonts->setFallbackFont("Bravura");

    fonts::insertSubstitution(u"Leland Text", u"Bravura Text");
    fonts::insertSubstitution(u"Bravura Text", u"Leland Text");
    fonts::insertSubstitution(u"MScore Text", u"Leland Text");
    fonts::insertSubstitution(u"Gootville Text", u"Leland Text");
    fonts::insertSubstitution(u"MuseJazz Text", u"Leland Text");
    fonts::insertSubstitution(u"Petaluma Text", u"MuseJazz Text");
    fonts::insertSubstitution(u"Finale Maestro Text", u"Leland Text");
    fonts::insertSubstitution(u"Finale Broadway Text", u"MuseJazz Text");
    fonts::insertSubstitution(u"ScoreFont", u"Leland Text");

    Smufl::init();
    engravingFonts->loadAllFonts();
}

static std::string resolveFontFile(const Font& f)
{
    FontDataKey actual = fonts::actualFont(FontDataKey(f.family(), f.bold(), f.italic()), f.type());
    auto it = s_fontFiles.find(fontKeyStr(actual));
    if (it != s_fontFiles.end()) {
        return it->second;
    }
    it = s_fontFiles.find(fontKeyStr(FontDataKey(actual.family())));
    return it != s_fontFiles.end() ? it->second : std::string();
}

// ---------------------------------------------------------------------------

Session* Session::instance()
{
    static Session s;
    return &s;
}

void Session::emit(const std::string& type, const std::string& json) const
{
    mss_js_emit(type.c_str(), json.c_str());
}

void Session::init()
{
    using namespace muse::modularity;

    m_ctx = std::make_shared<Context>(1);

    auto ioc = globalIoc();
    ioc->registerExport<io::IFileSystem>(MODULE, std::make_shared<PosixFileSystem>());
    ioc->registerExport<ICryptographicHash>(MODULE, std::make_shared<Md4Hash>());
    ioc->registerExport<IImageProvider>(MODULE, std::make_shared<ImageProvider>());

    // MuseScore 5.0's FreeType font engine in every build (see fonts.h)
    fonts::registerEngine();

    auto config = std::make_shared<EngravingConfig>();
#ifdef MSS_MUSESCORE_4_7
    auto engravingFonts = std::make_shared<EngravingFontsProvider>(nullptr);
#else
    auto engravingFonts = std::make_shared<EngravingFontsProvider>();
#endif
    ioc->registerExport<IEngravingConfiguration>(MODULE, config);
    ioc->registerExport<IEngravingFontsProvider>(MODULE, engravingFonts);
    ioc->registerExport<rendering::IScoreRenderer>(MODULE, new rendering::score::ScoreRenderer());
    ioc->registerExport<rendering::ISingleRenderer>(MODULE, new rendering::single::SingleRenderer());
    ioc->registerExport<rendering::IEditModeRenderer>(MODULE, new rendering::editmode::EditModeRenderer());
    ioc->registerExport<mpe::IArticulationProfilesRepository>(MODULE, std::make_shared<ArticulationProfiles>(":/mpe/resources"));

    // as in EngravingModule::onInit
    initFonts(engravingFonts);
    DefaultStyle::instance()->init(config->defaultStyleFilePath(), config->partStyleFilePath(), config->defaultPageSize());
    StaffType::initStaffTypes(config->defaultColor());
    MScore::warnPitchRange = true;
    MScore::warnGuitarBends = true;
    MScore::pedalEventsMinTicks = 1;
    Drumset::initDrumset();
    FiguredBass::readConfigFile(String());
    MScore::setNudgeStep(0.1);
    MScore::setNudgeStep10(1.0);
    MScore::setNudgeStep50(0.01);

    LOGI() << "score engine ready";
}

// ---------------------------------------------------------------------------
// Audio

void Session::startAudio(unsigned sampleRate, unsigned blockSize, const std::string& soundFontUri)
{
    m_audio = AudioBackend::create();
    m_audio->start(sampleRate, blockSize, soundFontUri, [this](bool ok, const std::string& error) {
        if (!ok) {
            emit("error", "{\"message\":" + jsonStr(error) + "}");
            return;
        }
        // as in SoundProfilesRepository::refresh, for the "MuseScore Basic" profile
        m_audio->availableInputResources([this](const AudioResourceMetaList& resources) {
            for (const AudioResourceMeta& r : resources) {
                auto setup = r.attributes.find(u"playbackSetupData");
                if (setup != r.attributes.cend() && AudioInputParams { r, {} }.type() == AudioSourceType::Fluid) {
                    m_basicProfile.emplace(mpe::PlaybackSetupData::fromString(setup->second), r);
                }
            }
            onAudioReady();
        });
    });
}

void Session::onAudioReady()
{
    m_audioReady = true;

    m_audio->positionChanged().onReceive(this, [this](double pos) {
        emit("position", cursorJson(pos));
        if (pos + 0.001 >= m_totalPlayTime && m_totalPlayTime > 0) {
            m_audio->stop(); // as in PlaybackController::setupPlayer
        }
    });

    m_audio->statusChanged().onReceive(this, [this](PlaybackStatus st) {
        const char* s = st == PlaybackStatus::Running ? "playing" : st == PlaybackStatus::Paused ? "paused" : "stopped";
        emit("status", std::string("{\"status\":\"") + s + "\"}");
    });

    emit("audioReady", "{}");

    if (m_project && !m_playbackSetUp) {
        setupPlayback();
    }
}

// ---------------------------------------------------------------------------
// Loading: as in NotationProject::doLoad

std::string Session::load(const std::string& path)
{
    removeAllTracks();
    m_playbackModel.reset();
    m_project.reset();
    m_tracks.clear();
    m_auxOut.clear();
    m_hasAudioSettings = false;
    m_audioSettings = AudioSettings();
    ++m_loadKey;

    std::string suffix = io::suffix(io::path_t(path));

    MscReader::Params params;
    params.filePath = io::path_t(path);
    params.mode = mscIoModeBySuffix(suffix);
    if (params.mode == MscIoMode::Unknown) {
        return "{\"ok\":false,\"error\":\"Not a MuseScore file (.mscz or .mscx).\"}";
    }

    LOGI() << "load step 0";
    MscReader reader(params);
    Ret ret = reader.open();
    if (!ret) {
        return "{\"ok\":false,\"error\":" + jsonStr("Could not open the file: " + ret.toString()) + "}";
    }

    LOGI() << "load step 1";
    m_project = EngravingProject::create(m_ctx);
    m_project->setFileInfoProvider(std::make_shared<LocalFileInfoProvider>(io::path_t(path)));

    LOGI() << "load step 2";
    rw::ReadInOutData inOutData;
    ret = m_project->loadMscz(reader, &inOutData, /*ignoreVersionError*/ false);
    if (!ret) {
        std::string msg = ret.toString();
        m_project.reset();
        return "{\"ok\":false,\"error\":" + jsonStr("MuseScore could not read this score: " + msg) + "}";
    }

    LOGI() << "load step 3";
    MasterScore* ms = m_project->masterScore();
    ms->lockUpdates(true);

    ret = m_project->setupMasterScore(/*forceMode*/ false);
    if (!ret) {
        ms->lockUpdates(false);
        std::string msg = ret.toString();
        m_project.reset();
        return "{\"ok\":false,\"error\":" + jsonStr("Score setup failed: " + msg) + "}";
    }

    //! NOTE NotationProject also runs ProjectMigrator here, which may offer to
    //! update scores saved by MuseScore 3 (fonts, spacing). We open them as-is.

    LOGI() << "load step 4";
    // A phone or tablet reader opens in page view, whatever view the score was saved in
    // (the user can switch with setViewMode). As in NotationPainting::setViewMode.
    ms->setLayoutMode(LayoutMode::PAGE);

    compat::EngravingCompat::doPreLayoutCompatIfNeeded(ms);
    ms->updateCapo(/* ignoreNotationUpdate */ true);
    ms->lockUpdates(false);
    LOGI() << "load step 5";
    ms->setLayoutAll();
    ms->update();
    compat::EngravingCompat::doPostLayoutCompatIfNeeded(ms);

    // Audio settings, and the solo/mute states saved beside them
    LOGI() << "load step 6";
    m_hasAudioSettings = m_audioSettings.read(reader.readAudioSettingsJsonFile());

    // Playback model, with NotationConfiguration defaults:
    // play repeats on, chord symbols on, metronome off.
    LOGI() << "load step 7";
    m_playbackModel = std::make_unique<PlaybackModel>(m_ctx);
    m_playbackModel->setPlayRepeats(true);
    m_playbackModel->setPlayChordSymbols(true);
    m_playbackModel->setUseScoreDynamicsForOffstreamPlayback(true);
    m_playbackModel->setIsMetronomeEnabled(m_metronome);
    m_playbackModel->load(ms);

    // as in NotationPlayback::updateTotalPlayTime
    {
        const int lastTick = ms->repeatList(true).ticks();
        m_totalPlayTime = uticksToSecs(ms, lastTick) + PLAYBACK_TAIL_SECS;
    }

    LOGI() << "load step 8";
    // Tracks, named as in PlaybackController::addTrack
    int key = 0;
    for (const InstrumentTrackId& id : m_playbackModel->existingTrackIdSet()) {
        Track t;
        t.key = ++key;
        t.id = id;
        t.isMetronome = id == m_playbackModel->metronomeTrackId();
        t.isChordSymbols = m_playbackModel->isChordSymbolsTrack(id);

        // as in PlaybackController::addTrack: a track is dropped only when its
        // part or instrument is missing (an empty name is fine)
        bool known = t.isMetronome;
        if (t.isMetronome) {
            t.title = "Metronome";
        } else if (const Part* part = ms->partById(id.partId)) {
            t.hidden = !part->show();
            // Label strips with the name printed on the staff (desktop's mixer uses the
            // part's track name, which is often the sound, e.g. "Piano" for every
            // voice of a choir score), falling back to the part and track names.
            String partName = part->instrument()->nameAsPlainText();
            if (partName.empty()) {
                partName = part->partName();
            }
            if (partName.empty()) {
                partName = part->instrument()->trackName();
            }
            if (t.isChordSymbols) {
                known = true;
                t.title = "Chords." + partName.toStdString();
            } else if (id.instrumentId == part->instrument()->id()) {
                known = true;
                t.title = partName.toStdString();
            } else if (const Instrument* instr = part->instrumentById(id.instrumentId)) {
                known = true;
                t.title = "(" + instr->trackName().toStdString() + ")";
            }
        }

        if (!known) {
            continue;
        }
        if (t.title.empty()) {
            t.title = "Part " + std::to_string(t.key);
        }

        if (m_audioSettings.hasTrackSoloMuteState(id)) {
            t.soloMute = m_audioSettings.trackSoloMuteState(id);
        }
        // as in PlaybackController::onPartChanged with muteHiddenInstruments (default on)
        if (t.hidden) {
            t.soloMute.mute = true;
        }

        m_tracks.push_back(std::move(t));
    }

    // Order like the desktop mixer: score order, metronome last
    std::stable_sort(m_tracks.begin(), m_tracks.end(), [ms](const Track& a, const Track& b) {
        if (a.isMetronome != b.isMetronome) {
            return !a.isMetronome;
        }
        auto partIndex = [ms](const Track& t) {
            const std::vector<Part*>& parts = ms->parts();
            for (size_t i = 0; i < parts.size(); ++i) {
                if (parts[i]->id() == t.id.partId) {
                    return int(i);
                }
            }
            return 1 << 20;
        };
        int pa = partIndex(a), pb = partIndex(b);
        if (pa != pb) {
            return pa < pb;
        }
        return a.isChordSymbols < b.isChordSymbols;
    });

    m_playbackSetUp = false;
    if (m_audioReady) {
        setupPlayback();
    }

    return "{\"ok\":true,\"score\":" + scoreInfoJson() + "}";
}

std::string Session::scoreInfoJson() const
{
    if (!m_project || !m_project->masterScore()) {
        return "null";
    }
    MasterScore* ms = m_project->masterScore();

    std::string pages = "[";
    for (size_t i = 0; i < ms->pages().size(); ++i) {
        const Page* p = ms->pages()[i];
        RectF r = p->ldata()->bbox();
        if (i) {
            pages += ",";
        }
        pages += "{\"w\":" + num(r.width()) + ",\"h\":" + num(r.height()) + "}";
    }
    pages += "]";

    // The title the reader sees is the Title text on the first page; the
    // workTitle metadata is often left as "Untitled score".
    String title;
    for (const MeasureBase* mb = ms->first(); mb && title.empty(); mb = mb->next()) {
        if (!mb->isBox()) {
            break;
        }
        for (const EngravingItem* e : mb->el()) {
            if (e->isTextBase() && toTextBase(e)->textStyleType() == TextStyleType::TITLE) {
                title = toTextBase(e)->plainText();
                break;
            }
        }
    }
    if (title.empty()) {
        title = ms->metaTag(u"workTitle");
    }

    return "{\"title\":" + jsonStr(title.toStdString())
           + ",\"composer\":" + jsonStr(ms->metaTag(u"composer").toStdString())
           + ",\"mscVersion\":" + std::to_string(ms->mscVersion())
           + ",\"createdWith\":" + jsonStr(ms->mscoreVersion().toStdString())
           + ",\"duration\":" + num(m_totalPlayTime)
           + ",\"spatium\":" + num(ms->style().spatium())
           + ",\"pages\":" + pages
           + ",\"hasAudioSettings\":" + (m_hasAudioSettings ? "true" : "false")
           + ",\"tracks\":" + tracksJson()
           + "}";
}

std::string Session::setViewMode(const std::string& mode)
{
    if (!m_project) {
        return "null";
    }
    MasterScore* ms = m_project->masterScore();
    LayoutMode lm = LayoutMode::PAGE;
    if (mode == "continuous_h") {
        lm = LayoutMode::SYSTEM;
    } else if (mode == "continuous_v") {
        lm = LayoutMode::LINE;
    }
    if (ms->layoutMode() != lm) {
        ms->setLayoutMode(lm);
        ms->doLayout();
    }
    return scoreInfoJson();
}

std::string Session::renderPage(int pageIndex)
{
    if (!m_project) {
        return "[]";
    }
    MasterScore* ms = m_project->masterScore();
    if (pageIndex < 0 || pageIndex >= int(ms->pages().size())) {
        return "[]";
    }

    auto provider = std::make_shared<RecordingPaintProvider>(resolveFontFile);
    {
        Painter painter(provider, "page");
        rendering::IScoreRenderer::ScorePaintOptions opt;
        opt.isSetViewport = false;
        opt.isMultiPage = false;
        opt.isPrinting = true; // as when exporting: no invisible items, frames or page borders
        opt.printPageBackground = false;
        opt.fromPage = pageIndex;
        opt.toPage = pageIndex;
        auto renderer = modularity::globalIoc()->resolve<rendering::IScoreRenderer>(MODULE);
        renderer->paintScore(&painter, ms, opt);
    }
    return provider->takeJson();
}

// ---------------------------------------------------------------------------
// Playback setup: as in PlaybackController::setupPlayback / setupTracks / doAddTrack

void Session::removeAllTracks()
{
    if (m_audio && m_playbackSetUp) {
        m_audio->stop();
        m_audio->removeAllTracks();
    }
    m_auxTracks.clear();
    m_playbackSetUp = false;
}

void Session::setupPlayback()
{
    if (!m_audio || !m_audioReady || !m_playbackModel) {
        return;
    }
    m_playbackSetUp = true;

    m_master = m_hasAudioSettings ? m_audioSettings.masterOutputParams() : OutputParams();
    m_audio->setMasterOutput(m_master);

    m_pendingTracks = int(m_tracks.size()) + int(AUX_CHANNEL_NUM);
    emit("loading", "{\"done\":0,\"total\":" + std::to_string(m_pendingTracks) + "}");

    for (Track& t : m_tracks) {
        addTrack(t);
    }
    for (aux_channel_idx_t idx = 0; idx < AUX_CHANNEL_NUM; ++idx) {
        addAuxTrack(idx);
    }

    m_audio->setDuration(m_totalPlayTime);
}

AudioInputParams Session::resolveSource(Track& t, const mpe::PlaybackData& data)
{
    AudioInputParams in = m_hasAudioSettings ? m_audioSettings.trackInputParams(t.id) : AudioInputParams();

    // This player only has MuseScore's built-in sound font. A score set up for
    // something else (Muse Sounds, a VST instrument, another sound font) is
    // played with MS Basic instead, and the mixer says so.
    if (in.isValid()) {
        const AudioSourceType type = in.type();
        if (type == AudioSourceType::MuseSampler) {
            t.substitutionNote = "Muse Sounds (" + in.resourceMeta.id + ") is not available on this device";
            in = AudioInputParams();
        } else if (type == AudioSourceType::Vsti) {
            t.substitutionNote = "VST instrument " + in.resourceMeta.id + " is not available on this device";
            in = AudioInputParams();
        } else if (type == AudioSourceType::Fluid) {
            const String& sf = in.resourceMeta.attributeVal(synth::SOUNDFONT_NAME_ATTRIBUTE);
            if (!sf.empty() && sf != u"MS Basic") {
                t.substitutionNote = "Sound font \"" + sf.toStdString() + "\" is not available on this device";
                in = AudioInputParams();
            }
        }
    }

    if (!in.isValid()) {
        // as in PlaybackController::doAddTrack: the basic profile's resource for this instrument
        auto it = m_basicProfile.find(data.setupData);
        if (it != m_basicProfile.end()) {
            in = { it->second, {} };
        }
    }

    return in;
}

void Session::addTrack(Track& t)
{
    mpe::PlaybackData playbackData = m_playbackModel->resolveTrackPlaybackData(t.id);
    if (!playbackData.isValid()) {
        --m_pendingTracks;
        maybeReady();
        return;
    }

    t.source = resolveSource(t, playbackData);
    t.out = m_hasAudioSettings ? m_audioSettings.trackOutputParams(t.id) : OutputParams();

    if (t.isMetronome) {
        // as in PlaybackController::trackOutputParams: muted unless the metronome is on
        t.out.muted = !m_metronome;
    }

    if (!t.isMetronome && t.out.auxSends.empty()) {
        // PlaybackConfiguration::defaultAuxSendValue for Fluid sources: 30%
        for (aux_channel_idx_t idx = 0; idx < AUX_CHANNEL_NUM; ++idx) {
            t.out.auxSends.emplace_back(AuxSendParams { 0.30f, true });
        }
    }

    const uint64_t loadKey = m_loadKey;
    const int key = t.key;

    m_audio->addTrack(t.title, playbackData, t.source, t.out,
                      [this, loadKey, key](AudioBackend::TrackId trackId, const AudioInputParams& applied) {
        if (loadKey != m_loadKey) {
            return;
        }
        if (Track* tr = findTrack(key)) {
            tr->audioTrackId = trackId;
            tr->added = true;
            tr->source = applied;
            const String& preset = applied.resourceMeta.attributeVal(synth::PRESET_NAME_ATTRIBUTE);
            tr->soundName = applied.resourceMeta.id;
            if (!preset.empty()) {
                tr->soundName += " · " + preset.toStdString();
            }
        }
        updateSoloMuteStates();
        --m_pendingTracks;
        maybeReady();
    },
                      [this, loadKey](const std::string& msg) {
        LOGE() << "can't add a new track: " << msg;
        if (loadKey != m_loadKey) {
            return;
        }
        --m_pendingTracks;
        maybeReady();
    });
}

void Session::addAuxTrack(aux_channel_idx_t index)
{
    OutputParams originParams;
    if (m_hasAudioSettings && m_audioSettings.containsAuxOutputParams(index)) {
        originParams = m_audioSettings.auxOutputParams(index);
        originParams.muted = m_audioSettings.auxSoloMuteState(index).mute;
    } else if (index == REVERB_CHANNEL_IDX) {
        // as in makeReverbOutputParams
        AudioFxParams reverbParams;
        reverbParams.resourceMeta = makeReverbMeta();
        reverbParams.categories.insert(AudioFxCategory::FxReverb);
        reverbParams.chainOrder = 0;
        reverbParams.active = true;
        originParams.fxChain.emplace(reverbParams.chainOrder, std::move(reverbParams));
    }
    m_auxOut[index] = originParams;

    const uint64_t loadKey = m_loadKey;
    m_audio->addAuxTrack(index == REVERB_CHANNEL_IDX ? "Reverb" : "Aux " + std::to_string(index + 1), originParams,
                         [this, loadKey, index](AudioBackend::TrackId trackId) {
        if (loadKey != m_loadKey) {
            return;
        }
        m_auxTracks[index] = trackId;
        --m_pendingTracks;
        maybeReady();
    },
                         [this, loadKey](const std::string& msg) {
        LOGE() << "can't add aux track: " << msg;
        if (loadKey != m_loadKey) {
            return;
        }
        --m_pendingTracks;
        maybeReady();
    });
}

void Session::maybeReady()
{
    if (m_pendingTracks == 0) {
        emit("playbackReady", tracksJson());
    } else {
        emit("loading", "{\"remaining\":" + std::to_string(m_pendingTracks) + "}");
    }
}

Session::Track* Session::findTrack(int key)
{
    for (Track& t : m_tracks) {
        if (t.key == key) {
            return &t;
        }
    }
    return nullptr;
}

void Session::sendControl(const Track& t)
{
    if (t.added && m_audio) {
        m_audio->setTrackOutput(t.audioTrackId, t.out);
    }
}

// as in PlaybackController::updateSoloMuteStates (no range-selection mode in a viewer)
void Session::updateSoloMuteStates()
{
    bool hasSolo = false;
    for (const Track& t : m_tracks) {
        if (!t.isMetronome && t.soloMute.solo) {
            hasSolo = true;
            break;
        }
    }

    for (Track& t : m_tracks) {
        if (t.isMetronome) {
            continue;
        }
        bool shouldForceMute = hasSolo && !t.soloMute.solo;
        t.out.solo = t.soloMute.solo;
        t.out.muted = t.soloMute.mute || shouldForceMute;
        t.out.forceMute = shouldForceMute;
        sendControl(t);
    }
}

// ---------------------------------------------------------------------------
// Transport: as in PlaybackController::play / doPlay / doPause / doStop / doResume

void Session::play()
{
    if (!m_audio || !m_playbackSetUp) {
        return;
    }
    const PlaybackStatus st = m_audio->status();
    if (st == PlaybackStatus::Running) {
        return;
    }

    if (st == PlaybackStatus::Paused) {
        if (m_audio->position() + 0.001 >= m_totalPlayTime) {
            m_audio->seek(0, true);
        }
        m_audio->prepareToPlay([this]() { m_audio->resume(); });
    } else {
        m_audio->prepareToPlay([this]() { m_audio->play(); });
    }
}

void Session::pause()
{
    if (m_audio && m_audio->status() == PlaybackStatus::Running) {
        m_audio->pause();
    }
}

void Session::stop()
{
    if (m_audio) {
        m_audio->stop();
    }
}

void Session::seek(double secs)
{
    if (!m_audio || !m_audioReady) {
        return;
    }
    secs = std::clamp(secs, 0.0, m_totalPlayTime);
    m_audio->seek(secs, /*flushSound*/ true);
    emit("position", cursorJson(secs));
}

// Like clicking the score during playback on desktop: the chord or rest under
// the finger becomes the play position (PlaybackController::seekElement, with
// NotationPlayback::playPositionTickByRawTick for repeats).
std::string Session::seekAt(int pageIndex, double x, double y)
{
    const Score* score = m_project ? m_project->masterScore() : nullptr;
    if (!score || pageIndex < 0 || pageIndex >= int(score->pages().size())) {
        return "null";
    }
    const Page* page = score->pages()[pageIndex];
    const PointF p = PointF(x, y) + page->pos();

    const Measure* m = score->searchMeasure(p);
    if (!m) {
        return "null";
    }

    const Segment* chosen = m->first(SegmentType::ChordRest);
    for (const Segment* s = chosen; s; s = s->next(SegmentType::ChordRest)) {
        if (s->canvasPos().x() <= p.x()) {
            chosen = s;
        } else {
            break;
        }
    }
    const int rawTick = chosen ? chosen->tick().ticks() : m->tick().ticks();
    const int utick = score->repeatList(true).tick2utick(rawTick);
    const double secs = uticksToSecs(score, utick);
    seek(secs);
    return cursorJson(secs);
}

// ---------------------------------------------------------------------------
// Mixer

void Session::setTrackVolume(int trackKey, double db)
{
    if (Track* t = findTrack(trackKey)) {
        t->out.volume = static_cast<float>(std::clamp(db, -60.0, 12.0));
        sendControl(*t);
    }
}

void Session::setTrackBalance(int trackKey, double balance)
{
    if (Track* t = findTrack(trackKey)) {
        t->out.balance = static_cast<float>(std::clamp(balance, -1.0, 1.0));
        sendControl(*t);
    }
}

void Session::setTrackMute(int trackKey, bool mute)
{
    if (Track* t = findTrack(trackKey)) {
        t->soloMute.mute = mute;
        if (t->isMetronome) {
            t->out.muted = mute;
            sendControl(*t);
            return;
        }
        updateSoloMuteStates();
    }
}

void Session::setTrackSolo(int trackKey, bool solo)
{
    if (Track* t = findTrack(trackKey)) {
        t->soloMute.solo = solo;
        updateSoloMuteStates();
    }
}

void Session::setReverbSend(int trackKey, double amount)
{
    Track* t = findTrack(trackKey);
    if (!t || !t->added || t->out.auxSends.empty()) {
        return;
    }
    t->out.auxSends[REVERB_CHANNEL_IDX].signalAmount = static_cast<float>(std::clamp(amount, 0.0, 1.0));
    sendControl(*t);
}

void Session::setMetronome(bool on)
{
    m_metronome = on;
    if (m_playbackModel) {
        m_playbackModel->setIsMetronomeEnabled(on);
    }
    for (Track& t : m_tracks) {
        if (t.isMetronome) {
            t.out.muted = !on || t.soloMute.mute;
            sendControl(t);
        }
    }
}

void Session::setMasterVolume(double db)
{
    m_master.volume = static_cast<float>(std::clamp(db, -60.0, 12.0));
    if (m_audio && m_audioReady) {
        m_audio->setMasterOutput(m_master);
    }
}

std::string Session::tracksJson() const
{
    std::string s = "[";
    bool first = true;
    for (const Track& t : m_tracks) {
        if (!first) {
            s += ",";
        }
        first = false;
        s += "{\"key\":" + std::to_string(t.key)
             + ",\"title\":" + jsonStr(t.title)
             + ",\"metronome\":" + (t.isMetronome ? "true" : "false")
             + ",\"chords\":" + (t.isChordSymbols ? "true" : "false")
             + ",\"hidden\":" + (t.hidden ? "true" : "false")
             + ",\"ready\":" + (t.added ? "true" : "false")
             + ",\"volume\":" + num(rawValue(t.out.volume))
             + ",\"balance\":" + num(rawValue(t.out.balance))
             + ",\"reverb\":" + num(t.out.auxSends.empty() ? 0.0 : t.out.auxSends[REVERB_CHANNEL_IDX].signalAmount)
             + ",\"mute\":" + (t.soloMute.mute ? "true" : "false")
             + ",\"solo\":" + (t.soloMute.solo ? "true" : "false")
             + ",\"forceMute\":" + (t.out.forceMute ? "true" : "false")
             + ",\"sound\":" + jsonStr(t.soundName)
             + ",\"note\":" + jsonStr(t.substitutionNote)
             + "}";
    }
    s += "]";
    return s;
}

// ---------------------------------------------------------------------------
// Position: as in NotationPlayback::secToTick and PlaybackCursor::resolveCursorRectByTick

double Session::totalPlayTime() const
{
    return m_totalPlayTime;
}

int Session::secToTick(double secs) const
{
    const Score* sc = m_project ? m_project->masterScore() : nullptr;
    if (!sc) {
        return 0;
    }
    return playedRepeats(sc).utick2tick(secsToUticks(sc, secs));
}

std::string Session::cursorJson(double secs) const
{
    std::string head = "{\"secs\":" + num(secs) + ",\"duration\":" + num(m_totalPlayTime);
    const Score* score = m_project ? m_project->masterScore() : nullptr;
    if (!score) {
        return head + "}";
    }

    const int rawTick = secToTick(secs);
    const Fraction tick = Fraction::fromTicks(rawTick);
    head += ",\"tick\":" + std::to_string(rawTick);

    const Measure* measure = score->tick2measureMM(tick);
    if (!measure) {
        return head + "}";
    }
    const System* system = measure->system();
    if (!system || !system->page() || system->staves().empty()) {
        return head + "}";
    }

    head += ",\"measure\":" + std::to_string(measure->measureIndex() + 1);

    for (const Segment* s = measure->first(SegmentType::ChordRest); s;) {
        const Fraction segmentStartTick = s->tick();
        const double segmentStartX = s->canvasPos().x();

        const Segment* nextSegment = s->next(SegmentType::ChordRest);
        while (nextSegment && !nextSegment->visible()) {
            nextSegment = nextSegment->next(SegmentType::ChordRest);
        }

        Fraction segmentEndTick;
        double segmentEndX = 0.0;
        if (nextSegment) {
            segmentEndTick = nextSegment->tick();
            segmentEndX = nextSegment->canvasPos().x();
        } else {
            segmentEndTick = measure->endTick();
            const Segment* endBar = measure->findSegment(SegmentType::EndBarLine, segmentEndTick);
            segmentEndX = endBar ? endBar->canvasPos().x() : measure->canvasPos().x() + measure->width();
        }

        if (tick < segmentStartTick || tick >= segmentEndTick) {
            s = nextSegment;
            continue;
        }

        const int duration = segmentEndTick.ticks() - segmentStartTick.ticks();
        const double x = duration > 0
                         ? segmentStartX + (segmentEndX - segmentStartX) * double(rawTick - segmentStartTick.ticks()) / double(duration)
                         : segmentStartX;

        double bottomY = 0.0;
        for (size_t i = 0; i < score->nstaves(); ++i) {
            const SysStaff* ss = system->staff(i);
            if (!ss->show() || !score->staff(i)->show()) {
                continue;
            }
            bottomY = ss->bbox().bottom();
        }

        const double spatium = score->style().spatium();
        const Page* page = system->page();
        const PointF pagePos = page->pos();
        const std::vector<Page*>& pages = score->pages();
        int pageIdx = int(std::find(pages.begin(), pages.end(), page) - pages.begin());

        // canvas -> page coordinates (pages are drawn individually)
        const double rx = x - spatium - pagePos.x();
        const double ry = system->staffCanvasYpage(0) - 3.0 * spatium;

        return head + ",\"page\":" + std::to_string(pageIdx)
               + ",\"x\":" + num(rx) + ",\"y\":" + num(ry)
               + ",\"w\":" + num(0.4 * spatium) + ",\"h\":" + num(bottomY + 6.0 * spatium) + "}";
    }

    return head + "}";
}
