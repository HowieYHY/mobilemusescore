/*
 * SPDX-License-Identifier: GPL-3.0-only
 *
 * See session.h. Code marked "as in X" follows the named MuseScore Studio
 * function closely; see docs/MUSESCORE_REUSE.md.
 */
#include "session.h"

#include <emscripten.h>

#include <cmath>
#include <functional>
#include <map>
#include <set>
#include <sstream>
#include <type_traits>

#include "global/modularity/ioc.h"
#include "global/async/processevents.h"
#include "global/io/ifilesystem.h"
#include "global/iapplication.h"
#include "global/defer.h"

#include "draw/painter.h"
#include "draw/types/fontstypes.h"

#include "audio/common/audioutils.h"

#include "engraving/compat/engravingcompat.h"
#include "engraving/dom/box.h"
#include "engraving/dom/chord.h"
#include "engraving/dom/drumset.h"
#include "engraving/dom/figuredbass.h"
#include "engraving/dom/instrument.h"
#include "engraving/dom/masterscore.h"
#include "engraving/dom/measure.h"
#include "engraving/dom/mscore.h"
#include "engraving/dom/note.h"
#include "engraving/dom/noteval.h"
#include "global/io/buffer.h"
#include "engraving/editing/undo.h"
#include "engraving/dom/pitchspelling.h"
#include "engraving/infrastructure/mscwriter.h"
#include "playback/qml/MuseScore/Playback/msbasicpresetscategories.h"
#include "engraving/dom/page.h"
#include "engraving/dom/part.h"
#include "engraving/dom/rehearsalmark.h"
#include "engraving/dom/repeatlist.h"
#include "engraving/dom/rest.h"
#include "engraving/dom/dynamic.h"
#include "engraving/dom/factory.h"
#include "engraving/dom/keysig.h"
#include "engraving/dom/lyrics.h"
#include "engraving/dom/stafftext.h"
#include "engraving/dom/timesig.h"
#include "engraving/dom/tuplet.h"
#include "engraving/editing/editpart.h"
#include "engraving/dom/segment.h"
#include "engraving/dom/staff.h"
#include "engraving/dom/stafftype.h"
#include "engraving/dom/system.h"
#include "engraving/dom/select.h"
#include "engraving/dom/navigate.h"
#include "engraving/editing/editdata.h"
#include "engraving/dom/articulation.h"
#include "engraving/dom/hairpin.h"
#include "engraving/dom/slur.h"
#include "engraving/dom/breath.h"
#include "engraving/dom/fermata.h"
#include "engraving/infrastructure/imimedata.h"
#include "engraving/dom/utils.h"
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

// A sound's name in the mixer, as audio::audioSourceName: the preset, else the
// sound font ("MS Basic" when it chooses automatically)
static std::string soundLabel(const AudioResourceMeta& meta)
{
    const String& preset = meta.attributeVal(synth::PRESET_NAME_ATTRIBUTE);
    if (!preset.empty()) {
        return preset.toStdString();
    }
    const String& soundFont = meta.attributeVal(synth::SOUNDFONT_NAME_ATTRIBUTE);
    return soundFont.empty() ? meta.id : soundFont.toStdString();
}

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

// The score writer stamps the file with the application's version (Writer::writeScore), so something
// has to answer for IApplication. Only the version is real: the rest is never called here.
namespace {
class AppInfo : public muse::IApplication
{
public:
    String name() const override { return u"PocketScore"; }
    String title() const override { return u"PocketScore"; }
    bool unstable() const override { return false; }
    Version version() const override { return Version(4, 7, 5); }
    Version fullVersion() const override { return Version(4, 7, 5); }
    String build() const override { return String(); }
    String revision() const override { return u"0"; }
    RunMode runMode() const override { return RunMode::GuiApp; }
    bool noGui() const override { return true; }
    void setup() override {}
    void finish() override {}
    void restart() override {}
    muse::modularity::ContextPtr setupNewContext() override { return nullptr; }
    int contextCount() const override { return 1; }
    std::vector<muse::modularity::ContextPtr> contexts() const override { return {}; }
    const muse::modularity::ContextPtr iocContext() const override { return nullptr; }
    muse::modularity::ModulesIoC* ioc() const override { return nullptr; }
    void processEvents() override {}
};
}

void Session::init()
{
    using namespace muse::modularity;

    m_ctx = std::make_shared<Context>(1);

    auto ioc = globalIoc();
    ioc->registerExport<io::IFileSystem>(MODULE, std::make_shared<PosixFileSystem>());
    ioc->registerExport<ICryptographicHash>(MODULE, std::make_shared<Md4Hash>());
    ioc->registerExport<muse::IApplication>(MODULE, std::make_shared<AppInfo>());
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
                if (AudioInputParams { r, {} }.type() == AudioSourceType::Fluid) {
                    m_fluidResources.emplace(r.id, r);
                }
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
        // the engine renders ahead; show where the listener is
        const double heard = m_audio->status() == PlaybackStatus::Running ? std::max(0.0, pos - m_outputLatency) : pos;
        emit("position", cursorJson(heard));
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
    m_anchorIds.clear(); // addresses of the last score's bars mean nothing now
    m_shownPart = nullptr;
    m_partShow.clear();
    m_enteredTick = -1;
    m_hasAudioSettings = false;
    m_audioSettings = AudioSettings();
    ++m_loadKey;
    // practice settings belong to a score: the new one plays at 100%, no loop
    m_loopOn = false;
    m_loopIn = m_loopOut = -1;
    if (m_audio && m_audioReady) {
        m_audio->resetLoop();
    }

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
    // The staves' swing maps come from the score's Swing texts; without this
    // only the style's swing played, and "Swing" markings did nothing (issue
    // #10). Desktop does it in MasterNotation::setMasterScore.
    ms->updateSwing();
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
    // Every score opens with the metronome off (muted in the mixer), whatever
    // the previous score did, as desktop's metronome button is off by default
    m_metronome = false;

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
    buildTracks();

    m_master = m_hasAudioSettings ? m_audioSettings.masterOutputParams() : OutputParams();
    updateSoloMuteStates(); // nothing is sent yet: no track is added

    m_playbackSetUp = false;
    if (m_audioReady) {
        setupPlayback();
    }

    return "{\"ok\":true,\"score\":" + scoreInfoJson() + "}";
}

// Whether the score itself shows a part (Edit's one line at a time hides the others for a while)
bool Session::partShown(const Part* part) const
{
    auto it = m_partShow.find(part);
    return it != m_partShow.end() ? it->second : part->show();
}

// A track's name as PlaybackController::addTrack gives it; false when its part or instrument is missing
bool Session::nameTrack(MasterScore* ms, Track& t)
{
    // as in PlaybackController::addTrack: a track is dropped only when its
    // part or instrument is missing (an empty name is fine)
    bool known = t.isMetronome;
    if (t.isMetronome) {
        t.title = "Metronome";
    } else if (const Part* part = ms->partById(t.id.partId)) {
        t.hidden = !partShown(part);
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
        } else if (t.id.instrumentId == part->instrument()->id()) {
            known = true;
            t.title = partName.toStdString();
        } else if (const Instrument* instr = part->instrumentById(t.id.instrumentId)) {
            known = true;
            t.title = "(" + instr->trackName().toStdString() + ")";
        }
    }

    if (!known) {
        return false;
    }
    if (t.title.empty()) {
        t.title = "Part " + std::to_string(t.key);
    }
    return true;
}

// The tracks of the playback model, named, with the mixer values the score holds
void Session::buildTracks()
{
    MasterScore* ms = m_project->masterScore();
    // Tracks, named as in PlaybackController::addTrack
    int key = 0;
    for (const InstrumentTrackId& id : m_playbackModel->existingTrackIdSet()) {
        Track t;
        t.key = ++key;
        t.id = id;
        t.isMetronome = id == m_playbackModel->metronomeTrackId();
        t.isChordSymbols = m_playbackModel->isChordSymbolsTrack(id);

        if (!nameTrack(ms, t)) {
            continue;
        }

        // Mixer values are known from the score itself, so the mixer works
        // before the sounds have loaded; changes made meanwhile are kept
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

        if (m_audioSettings.hasTrackSoloMuteState(id)) {
            t.soloMute = m_audioSettings.trackSoloMuteState(id);
        }
        // as in PlaybackController::onPartChanged with muteHiddenInstruments (default on)
        if (t.hidden) {
            t.soloMute.mute = true;
        }
        // the metronome is off (muted) until the reader unmutes it, as desktop's
        // metronome button is off by default (NotationConfiguration)
        if (t.isMetronome) {
            t.soloMute.mute = !m_metronome;
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
    m_partCount = ms->parts().size();
}

// A line was added (or taken away again by undo): the playback is built again from the score, keeping the
// volumes, mutes and solos the reader set for the lines that remain
void Session::rebuildPlayback()
{
    MasterScore* ms = m_project->masterScore();
    std::vector<Track> old = std::move(m_tracks);
    m_tracks.clear();
    removeAllTracks();
    ++m_loadKey;
    m_playbackModel = std::make_unique<PlaybackModel>(m_ctx);
    m_playbackModel->setPlayRepeats(true);
    m_playbackModel->setPlayChordSymbols(true);
    m_playbackModel->setUseScoreDynamicsForOffstreamPlayback(true);
    m_playbackModel->setIsMetronomeEnabled(m_metronome);
    m_playbackModel->load(ms);
    buildTracks();
    for (Track& t : m_tracks) {
        for (const Track& o : old) {
            if (o.id == t.id) {
                t.out = o.out;
                t.soloMute = o.soloMute;
                break;
            }
        }
    }
    updateSoloMuteStates();
    if (m_audioReady) {
        setupPlayback();
    }
}

// After an edit that may have added, removed or renamed a line
void Session::syncTracks()
{
    MasterScore* ms = m_project ? m_project->masterScore() : nullptr;
    if (!ms) {
        return;
    }
    if (ms->parts().size() != m_partCount) {
        rebuildPlayback();
        return;
    }
    for (Track& t : m_tracks) {
        if (!t.isMetronome) {
            nameTrack(ms, t);
        }
    }
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

    m_audio->setMasterOutput(m_master); // as read from the score (see load), or as changed since

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
    // t.out was set when the score loaded (and may have been changed since)

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
            tr->soundName = soundLabel(applied.resourceMeta);
            tr->scoreSoundId = applied.resourceMeta.id;
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

    // as PlaybackController::play: outside the loop, start at its beginning
    const Score* score = m_project ? m_project->masterScore() : nullptr;
    if (m_loopOn && m_loopIn >= 0 && score) {
        const double from = uticksToSecs(score, m_loopIn);
        const double to = uticksToSecs(score, m_loopOut);
        const double pos = m_audio->position();
        if (pos < from - 0.001 || pos >= to - 0.001) {
            m_audio->seek(from, true);
            emit("position", cursorJson(from));
        }
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
        // stop where the listener is, not where the engine has rendered to: the
        // audio queued ahead is dropped, and resuming continues from here
        const double heard = std::max(0.0, m_audio->position() - m_outputLatency);
        m_audio->pause();
        if (m_outputLatency > 0.0) {
            m_audio->seek(heard, true);
            emit("position", cursorJson(heard));
        }
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
bool Session::locate(int pageIndex, double x, double y, double radius, double& secs, const Note*& note) const
{
    const Score* score = m_project ? m_project->masterScore() : nullptr;
    if (!score || pageIndex < 0 || pageIndex >= int(score->pages().size())) {
        return false;
    }
    Page* page = score->pages()[pageIndex];
    const PointF p = PointF(x, y) + page->pos();

    // The note nearest the tap, within `radius` (a fingertip is bigger than a notehead)
    note = nullptr;
    double best = radius;
    const PointF onPage(x, y);
    for (EngravingItem* item : page->items(RectF(x - radius, y - radius, 2 * radius, 2 * radius))) {
        if (!item->isNote() || !item->visible() || !item->isPlayable()) {
            continue;
        }
        const RectF r = item->pageBoundingRect();
        const double dx = std::max({ r.left() - onPage.x(), 0.0, onPage.x() - r.right() });
        const double dy = std::max({ r.top() - onPage.y(), 0.0, onPage.y() - r.bottom() });
        const double d = std::hypot(dx, dy);
        if (d < best) {
            best = d;
            note = toNote(item);
        }
    }

    const Segment* chosen = nullptr;
    if (note) {
        chosen = note->chord()->segment();
    } else {
        const Measure* m = score->searchMeasure(p);
        if (!m) {
            return false;
        }
        chosen = m->first(SegmentType::ChordRest);
        for (const Segment* s = chosen; s; s = s->next(SegmentType::ChordRest)) {
            if (s->canvasPos().x() <= p.x()) {
                chosen = s;
            } else {
                break;
            }
        }
        if (!chosen) {
            chosen = m->first();
        }
    }
    const int rawTick = chosen->tick().ticks();
    const int utick = score->repeatList(true).tick2utick(rawTick);
    secs = uticksToSecs(score, utick);
    return true;
}

std::string Session::locateJson(int pageIndex, double x, double y, double radius) const
{
    double secs = 0.0;
    const Note* note = nullptr;
    if (!locate(pageIndex, x, y, radius, secs, note)) {
        return "null";
    }
    std::string json = cursorJson(secs);
    if (note && json.size() > 1 && json.back() == '}') {
        json.pop_back();
        json += ",\"note\":true}";
    }
    return json;
}

std::string Session::seekAt(int pageIndex, double x, double y, double radius, bool playNote)
{
    double secs = 0.0;
    const Note* note = nullptr;
    if (!locate(pageIndex, x, y, radius, secs, note)) {
        return "null";
    }

    // As desktop MuseScore does when a note is selected: sound it, for the
    // default 500 ms. Only while stopped; during playback a tap just moves.
    const bool playing = m_audio && m_audio->status() == PlaybackStatus::Running;
    if (note && playNote && !playing && m_playbackModel) {
        m_playbackModel->triggerEventsForItems({ note }, 500000, true);
    }

    seek(secs);
    std::string json = cursorJson(secs);
    if (note && json.size() > 1 && json.back() == '}') {
        json.pop_back();
        json += ",\"note\":true}";
    }
    return json;
}

// ---------------------------------------------------------------------------
// Editing: one undo step per call; then the playback model and play time follow the score

// The first staff a system shows (staff 0 may be hidden: an instrument switched off, or Edit's one line)
static staff_idx_t topStaff(const Score* score, const System* system)
{
    for (size_t i = 0; i < score->nstaves() && i < system->staves().size(); ++i) {
        if (system->staff(i)->show() && score->staff(i)->show()) {
            return i;
        }
    }
    return 0;
}

static std::string editResult(bool ok, const std::string& error = "")
{
    return ok ? "{\"ok\":true}" : "{\"ok\":false,\"error\":" + jsonStr(error) + "}";
}

// Called after an edit: the score was laid out by endCmd; the sound follows
static void afterEdit(MasterScore* ms, PlaybackModel* model, std::function<void()> updatePlayTime)
{
    ms->setPlaylistDirty();
    if (model) {
        model->reload();
    }
    updatePlayTime();
}

std::string Session::editAddNote(int measureIndex, int offsetNum, int offsetDen, int staffIdx, int midiPitch, int durNum, int durDen)
{
    MasterScore* ms = m_project ? m_project->masterScore() : nullptr;
    if (!ms) {
        return editResult(false, "No score is open.");
    }
    Measure* m = ms->crMeasure(measureIndex);
    if (!m || staffIdx < 0 || staffIdx >= static_cast<int>(ms->nstaves())) {
        return editResult(false, "No such bar or staff.");
    }
    Segment* seg = m->tick2segment(m->tick() + Fraction(offsetNum, offsetDen), SegmentType::ChordRest);
    if (!seg) {
        return editResult(false, "No place for a note there.");
    }
    InputState& is = ms->inputState();
    is.setTrack(static_cast<track_idx_t>(staffIdx) * VOICES);
    is.setSegment(seg);
    is.setDuration(TDuration(Fraction(durNum, durDen)));
    is.setRest(false);
    is.setNoteEntryMode(true);

    NoteVal nv(midiPitch);
    nv.tpc1 = nv.tpc2 = pitch2tpc(midiPitch, ms->staff(staffIdx)->key(seg->tick()), Prefer::NEAREST);

    ms->startCmd(TranslatableString::untranslatable("Enter note"));
    Note* note = ms->addPitch(nv, false);
    ms->endCmd();
    is.setNoteEntryMode(false);
    if (!note) {
        return editResult(false, "The note could not be added.");
    }
    afterEdit(ms, m_playbackModel.get(), [this, ms]() {
        m_totalPlayTime = uticksToSecs(ms, ms->repeatList(true).ticks()) + PLAYBACK_TAIL_SECS;
        if (m_audio && m_audioReady) {
            m_audio->setDuration(m_totalPlayTime);
        }
    });
    return editResult(true);
}

// ---- selection: one note or rest at a time

static ChordRest* selectedChordRest(const MasterScore* ms, Note** noteOut = nullptr)
{
    EngravingItem* el = ms->selection().element();
    if (noteOut) {
        *noteOut = nullptr;
    }
    if (!el) {
        return nullptr;
    }
    if (el->isNote()) {
        if (noteOut) {
            *noteOut = toNote(el);
        }
        return toNote(el)->chord();
    }
    return el->isChordRest() ? toChordRest(el) : nullptr;
}

static int durationDenominator(DurationType t)
{
    switch (t) {
    case DurationType::V_WHOLE: return 1;
    case DurationType::V_HALF: return 2;
    case DurationType::V_QUARTER: return 4;
    case DurationType::V_EIGHTH: return 8;
    case DurationType::V_16TH: return 16;
    case DurationType::V_32ND: return 32;
    case DurationType::V_64TH: return 64;
    case DurationType::V_128TH: return 128;
    default: return 0; // breve, longer, measure rests
    }
}

// A range: its outline, one box per system it covers (pages are drawn system by system), from the first
// selected place to the last, over the selected staves
static std::string rangeJson(const MasterScore* ms)
{
    const Selection& sel = ms->selection();
    Segment* s1 = sel.startSegment();
    if (!s1) {
        return "null";
    }
    Segment* s2 = sel.endSegment(); // exclusive; null at the end of the score
    const staff_idx_t st1 = sel.staffStart(), st2 = sel.staffEnd();
    struct Box { const System* sys; double x0, x1; };
    std::vector<Box> boxes;
    for (Measure* m = s1->measure(); m; m = m->nextMeasure()) {
        if (s2 && m->tick() >= s2->tick()) {
            break;
        }
        const System* sys = m->system();
        if (!sys || !sys->page()) {
            continue;
        }
        double x0 = m->pageX(), x1 = m->pageX() + m->width();
        if (m == s1->measure()) {
            x0 = s1->pageX();
        }
        if (s2 && s2->measure() == m) {
            x1 = s2->pageX();
        }
        if (!boxes.empty() && boxes.back().sys == sys) {
            boxes.back().x1 = x1;
        } else {
            boxes.push_back({ sys, x0, x1 });
        }
    }
    if (boxes.empty() || st2 <= st1) {
        return "null";
    }
    auto top = [&](const System* sys) { return sys->staffYpage(st1); };
    auto height = [&](const System* sys) { return sys->staffYpage(st2 - 1) + sys->staff(st2 - 1)->bbox().height() - sys->staffYpage(st1); };
    std::string list;
    for (const Box& b : boxes) {
        list += std::string(list.empty() ? "" : ",") + "{\"page\":" + std::to_string(b.sys->page()->pageNumber())
                + ",\"x\":" + num(b.x0) + ",\"y\":" + num(top(b.sys)) + ",\"w\":" + num(std::max(b.x1 - b.x0, 1.0)) + ",\"h\":" + num(height(b.sys)) + "}";
    }
    const Measure* first = s1->measure();
    const Measure* last = first;
    for (Measure* m = s1->measure(); m && !(s2 && m->tick() >= s2->tick()); m = m->nextMeasure()) {
        last = m;
    }
    const Box& f = boxes.front();
    return std::string("{\"kind\":\"range\",\"page\":") + std::to_string(f.sys->page()->pageNumber())
           + ",\"x\":" + num(f.x0) + ",\"y\":" + num(top(f.sys)) + ",\"w\":" + num(std::max(f.x1 - f.x0, 1.0)) + ",\"h\":" + num(height(f.sys))
           + ",\"bar\":" + std::to_string(first->no() + 1) + ",\"barEnd\":" + std::to_string(last->no() + 1)
           + ",\"staff\":" + std::to_string(st1) + ",\"staves\":" + std::to_string(st2 - st1)
           + ",\"den\":0,\"dots\":0,\"voice\":1,\"tuplet\":false,\"mid\":0,\"boxes\":[" + list + "]}";
}

std::string Session::editSelectionJson() const
{
    const MasterScore* ms = m_project ? m_project->masterScore() : nullptr;
    if (ms && ms->selection().isRange()) {
        return rangeJson(ms);
    }
    Note* note = nullptr;
    ChordRest* cr = ms ? selectedChordRest(ms, &note) : nullptr;
    if (!cr || !cr->measure() || !cr->measure()->system() || !cr->measure()->system()->page()) {
        return "null";
    }
    const EngravingItem* el = note ? static_cast<const EngravingItem*>(note) : static_cast<const EngravingItem*>(cr);
    const RectF r = el->pageBoundingRect();
    std::string json = std::string("{\"kind\":\"") + (note ? "note" : "rest") + "\""
                       + ",\"page\":" + std::to_string(cr->measure()->system()->page()->pageNumber())
                       + ",\"x\":" + num(r.x()) + ",\"y\":" + num(r.y()) + ",\"w\":" + num(r.width()) + ",\"h\":" + num(r.height())
                       + ",\"bar\":" + std::to_string(cr->measure()->no() + 1)
                       + ",\"staff\":" + std::to_string(cr->staffIdx())
                       + ",\"part\":" + jsonStr(cr->staff()->part()->partName().toStdString())
                       + ",\"voice\":" + std::to_string(cr->voice() + 1)
                       + ",\"den\":" + std::to_string(durationDenominator(cr->durationType().type()))
                       + ",\"dots\":" + std::to_string(cr->dots())
                       // the pitch of the staff's middle line, for choosing an octave that fits
                       + ",\"mid\":" + std::to_string(line2pitch(4, ms->staff(cr->staffIdx())->clef(cr->tick()), Key::C));
    if (note) {
        json += ",\"pitch\":" + std::to_string(note->epitch())
                + ",\"name\":" + jsonStr(note->tpcUserName(false, false).toStdString())
                + ",\"tie\":" + (note->tieFor() ? "true" : "false");
        // every note of its chord, as written (desktop's piano lights the picked note and its chord mates)
        std::string pitches;
        for (const Note* n : note->chord()->notes()) {
            pitches += std::string(pitches.empty() ? "" : ",") + std::to_string(n->epitch());
        }
        json += ",\"pitches\":[" + pitches + "]";
    }
    json += std::string(",\"tuplet\":") + (cr->tuplet() ? "true" : "false");
    return json + "}";
}

// the note or rest nearest a tap, within `radius`; a note wins a tie with a rest
static EngravingItem* nearestNoteOrRest(Page* page, double x, double y, double radius)
{
    EngravingItem* best = nullptr;
    double bestD = radius;
    for (EngravingItem* item : page->items(RectF(x - radius, y - radius, 2 * radius, 2 * radius))) {
        if (!(item->isNote() || item->isRest()) || !item->visible()) {
            continue;
        }
        if (const Staff* st = item->staff(); st && !st->show()) {
            continue;
        }
        const RectF r = item->pageBoundingRect();
        const double dx = std::max({ r.left() - x, 0.0, x - r.right() });
        const double dy = std::max({ r.top() - y, 0.0, y - r.bottom() });
        const double d = std::hypot(dx, dy) + (item->isRest() ? 0.001 : 0.0);
        if (d < bestD) {
            bestD = d;
            best = item;
        }
    }
    return best;
}

std::string Session::editSelect(int pageIndex, double x, double y, double radius)
{
    MasterScore* ms = m_project ? m_project->masterScore() : nullptr;
    if (!ms || pageIndex < 0 || pageIndex >= int(ms->pages().size())) {
        return "null";
    }
    EngravingItem* best = nearestNoteOrRest(ms->pages()[pageIndex], x, y, radius);
    if (!best) {
        ms->deselectAll();
        return "null";
    }
    ms->select(best);
    const bool playing = m_audio && m_audio->status() == PlaybackStatus::Running;
    if (best->isNote() && !playing && m_playbackModel) {
        m_playbackModel->triggerEventsForItems({ best }, 500000, true);
    }
    return editSelectionJson();
}

std::string Session::editClearSelection()
{
    if (m_project) {
        m_project->masterScore()->deselectAll();
    }
    return "null";
}

// Selection moves as the arrow keys do on desktop: "next-chord", "prev-chord", "next-measure", "prev-measure"
std::string Session::editMove(const std::string& cmd)
{
    MasterScore* ms = m_project ? m_project->masterScore() : nullptr;
    if (!ms || !ms->selection().element()) {
        return "null";
    }
    // "extend-next-chord": Shift+arrow, the range grows as on desktop (selectMove leaves a range)
    if (cmd.rfind("extend-", 0) == 0) {
        ms->selectMove(String(u"select-") + String::fromStdString(cmd.substr(7)));
        return editSelectionJson();
    }
    // selectMove wants desktop's command names ("select-next-chord") and leaves a range: pick the note itself
    if (EngravingItem* moved = ms->selectMove(String(u"select-") + String::fromStdString(cmd))) {
        EngravingItem* pick = moved->isChord() ? static_cast<EngravingItem*>(toChord(moved)->upNote()) : moved;
        ms->select(pick, SelectType::SINGLE, 0);
    }
    const bool playing = m_audio && m_audio->status() == PlaybackStatus::Running;
    if (EngravingItem* el = ms->selection().element(); el && el->isNote() && !playing && m_playbackModel) {
        m_playbackModel->triggerEventsForItems({ el }, 500000, true);
    }
    return editSelectionJson();
}

// One undo step for the selected note: mode 0 up a semitone, 1 down, 2 octave up, 3 octave down
std::string Session::editPitch(int mode)
{
    MasterScore* ms = m_project ? m_project->masterScore() : nullptr;
    Note* note = nullptr;
    // a range moves as a whole, as desktop's arrow keys do
    if (!ms || ((!selectedChordRest(ms, &note) || !note) && !ms->selection().isRange())) {
        return editResult(false, "Select a note first.");
    }
    ms->startCmd(TranslatableString::untranslatable("Change pitch"));
    ms->upDown(mode == 0 || mode == 2, mode >= 2 ? UpDownMode::OCTAVE : UpDownMode::CHROMATIC);
    ms->endCmd();
    afterEdit(ms, m_playbackModel.get(), []() {});
    const bool playing = m_audio && m_audio->status() == PlaybackStatus::Running;
    if (EngravingItem* el = ms->selection().element(); el && el->isNote() && !playing && m_playbackModel) {
        m_playbackModel->triggerEventsForItems({ el }, 500000, true);
    }
    return editResult(true);
}

static Pad padForDenominator(int den)
{
    switch (den) {
    case 1: return Pad::NOTE1;
    case 2: return Pad::NOTE2;
    case 4: return Pad::NOTE4;
    case 8: return Pad::NOTE8;
    case 16: return Pad::NOTE16;
    case 32: return Pad::NOTE32;
    case 64: return Pad::NOTE64;
    default: return Pad::NOTE4;
    }
}

// Sets the selected note or rest to a whole, half, quarter... (denominator 1, 2, 4...), as desktop's duration keys
std::string Session::editDuration(int denominator)
{
    MasterScore* ms = m_project ? m_project->masterScore() : nullptr;
    if (!ms || !selectedChordRest(ms)) {
        return editResult(false, "Select a note or rest first.");
    }
    ms->startCmd(TranslatableString::untranslatable("Change duration"));
    ms->padToggle(padForDenominator(denominator));
    ms->endCmd();
    afterEdit(ms, m_playbackModel.get(), [this, ms]() {
        m_totalPlayTime = uticksToSecs(ms, ms->repeatList(true).ticks()) + PLAYBACK_TAIL_SECS;
        if (m_audio && m_audioReady) {
            m_audio->setDuration(m_totalPlayTime);
        }
    });
    return editResult(true);
}

std::string Session::editDot()
{
    MasterScore* ms = m_project ? m_project->masterScore() : nullptr;
    if (!ms || !selectedChordRest(ms)) {
        return editResult(false, "Select a note or rest first.");
    }
    ms->startCmd(TranslatableString::untranslatable("Dot"));
    ms->padToggle(Pad::DOT);
    ms->endCmd();
    afterEdit(ms, m_playbackModel.get(), [this, ms]() {
        m_totalPlayTime = uticksToSecs(ms, ms->repeatList(true).ticks()) + PLAYBACK_TAIL_SECS;
        if (m_audio && m_audioReady) {
            m_audio->setDuration(m_totalPlayTime);
        }
    });
    return editResult(true);
}

// Notes become rests, as Delete does on desktop
std::string Session::editDelete()
{
    MasterScore* ms = m_project ? m_project->masterScore() : nullptr;
    if (!ms || (!selectedChordRest(ms) && !ms->selection().isRange())) {
        return editResult(false, "Select a note first.");
    }
    ms->startCmd(TranslatableString::untranslatable("Delete"));
    ms->cmdDeleteSelection();
    ms->endCmd();
    afterEdit(ms, m_playbackModel.get(), []() {});
    return editResult(true);
}

static DurationType durationTypeFor(int den)
{
    switch (den) {
    case 1: return DurationType::V_WHOLE;
    case 2: return DurationType::V_HALF;
    case 8: return DurationType::V_EIGHTH;
    case 16: return DurationType::V_16TH;
    case 32: return DurationType::V_32ND;
    case 64: return DurationType::V_64TH;
    default: return DurationType::V_QUARTER;
    }
}

// Desktop's note input, one step: the input position is the selected note or rest, the length the one
// chosen (den, dots). Afterwards the input position has moved on (InputState::moveToNextInputPos), and that
// place is selected, so the next step goes after this one; at the end of the score the new item stays picked.
static bool startStep(MasterScore* ms, int den, int dots, track_idx_t& track)
{
    ChordRest* cr = selectedChordRest(ms);
    if (!cr) {
        return false;
    }
    track = cr->track();
    InputState& is = ms->inputState();
    is.setTrack(track);
    is.setSegment(cr->segment());
    TDuration d(durationTypeFor(den));
    d.setDots(std::clamp(dots, 0, 2));
    is.setDuration(d);
    is.setRest(false);
    is.setNoteEntryMode(true);
    return true;
}
static void selectNextStep(MasterScore* ms, track_idx_t track, const Fraction& enteredAt)
{
    const InputState& is = ms->inputState();
    EngravingItem* next = is.segment() && is.segment()->tick() > enteredAt ? is.segment()->element(track) : nullptr;
    if (!next) {
        Segment* seg = ms->tick2segment(enteredAt, false, SegmentType::ChordRest);
        next = seg ? seg->element(track) : nullptr; // the end of the score: what was just entered
    }
    if (next) {
        ms->select(next->isChord() ? static_cast<EngravingItem*>(toChord(next)->upNote()) : next);
    }
}

// Puts a note at the selected place, as typing C D E F G A B does in desktop's note input: the letter is
// in the key signature, in the octave nearest the note before it (Score::resolveNoteInputParams), as long
// as the chosen length, replacing what is there; then the next place is selected.
std::string Session::editEnterNote(int letter, int den, int dots)
{
    MasterScore* ms = m_project ? m_project->masterScore() : nullptr;
    track_idx_t track = 0;
    if (!ms || letter < 0 || letter > 6 || !startStep(ms, den, dots, track)) {
        return editResult(false, "Select a note or rest first.");
    }
    InputState& is = ms->inputState();
    const Fraction tick = is.segment()->tick();
    NoteInputParams params;
    if (!ms->resolveNoteInputParams(letter, false, params)) {
        is.setNoteEntryMode(false);
        return editResult(false, "A note can't go here.");
    }
    ms->startCmd(TranslatableString::untranslatable("Enter note"));
    ms->cmdAddPitch(params, false, false);
    ms->endCmd();
    is.setNoteEntryMode(false);
    // the new note, by where the input position was
    Note* note = nullptr;
    if (Segment* seg = ms->tick2segment(tick, false, SegmentType::ChordRest)) {
        if (EngravingItem* e = seg->element(track); e && e->isChord()) {
            note = toChord(e)->upNote();
        }
    }
    if (!note) {
        return editResult(false, "The note could not be added.");
    }
    selectNextStep(ms, track, tick);
    afterEdit(ms, m_playbackModel.get(), [this, ms]() {
        m_totalPlayTime = uticksToSecs(ms, ms->repeatList(true).ticks()) + PLAYBACK_TAIL_SECS;
        if (m_audio && m_audioReady) {
            m_audio->setDuration(m_totalPlayTime);
        }
    });
    const bool playing = m_audio && m_audio->status() == PlaybackStatus::Running;
    if (!playing && m_playbackModel) {
        m_playbackModel->triggerEventsForItems({ note }, 500000, true);
    }
    return editResult(true);
}

// A rest of the chosen length at the selected place, as desktop's 0 key in note input; then the next place
std::string Session::editEnterRest(int den, int dots)
{
    MasterScore* ms = m_project ? m_project->masterScore() : nullptr;
    track_idx_t track = 0;
    if (!ms || !startStep(ms, den, dots, track)) {
        return editResult(false, "Select a note or rest first.");
    }
    InputState& is = ms->inputState();
    const Fraction tick = is.segment()->tick();
    ms->startCmd(TranslatableString::untranslatable("Enter rest"));
    ms->enterRest(is.duration());
    ms->endCmd();
    is.setNoteEntryMode(false);
    selectNextStep(ms, track, tick);
    afterEdit(ms, m_playbackModel.get(), [this, ms]() {
        m_totalPlayTime = uticksToSecs(ms, ms->repeatList(true).ticks()) + PLAYBACK_TAIL_SECS;
        if (m_audio && m_audioReady) {
            m_audio->setDuration(m_totalPlayTime);
        }
    });
    return editResult(true);
}

// A piano key. As desktop's piano keyboard panel with a note or rest selected (NotationMidiInput: note input
// starts at the selection, then Score::addMidiPitch with the written pitch): the note goes in at the selected
// place with the chosen length, replacing what is there, tied over the barline when it is longer than the
// bar's room (setNoteRest), and the next place is selected. `chord` 1 adds the pitch to the selected note's
// chord; 2 adds it to the chord the last key entered (desktop: Shift, or a second key held), and the
// selection stays on the next place.
std::string Session::editEnterPitch(int midi, int chord, int den, int dots)
{
    MasterScore* ms = m_project ? m_project->masterScore() : nullptr;
    if (!ms || midi < 0 || midi > 127) {
        return editResult(false, "Select a note or rest first.");
    }
    InputState& is = ms->inputState();
    const bool playing = m_audio && m_audio->status() == PlaybackStatus::Running;

    if (chord) {
        Note* picked = nullptr;
        ChordRest* sel = selectedChordRest(ms, &picked);
        Chord* target = nullptr;
        if (chord == 2 && m_enteredTick >= 0) {
            Segment* seg = ms->tick2segment(Fraction::fromTicks(m_enteredTick), false, SegmentType::ChordRest);
            EngravingItem* e = seg ? seg->element(m_enteredTrack) : nullptr;
            target = e && e->isChord() ? toChord(e) : nullptr;
        } else if (chord == 1 && picked) {
            target = picked->chord();
        }
        if (!target) {
            return editResult(false, chord == 2 ? "Put a note in first, then add to it." : "Select a note first.");
        }
        for (const Note* n : target->notes()) {
            if (n->epitch() == midi) {
                return editResult(false, "That note is already in the chord.");
            }
        }
        const Fraction selTick = sel ? sel->tick() : Fraction(-1, 1);
        const track_idx_t selTrack = sel ? sel->track() : 0;
        const int selPitch = picked ? picked->epitch() : -1;
        is.setTrack(target->track());
        is.setSegment(target->segment());
        is.setLastSegment(target->segment());
        is.setDuration(target->durationType());
        is.setRest(false);
        is.setNoteEntryMode(true);
        ms->startCmd(TranslatableString::untranslatable("Add note to chord"));
        Note* note = ms->addMidiPitch(midi, true, true);
        ms->endCmd();
        is.setNoteEntryMode(false);
        if (!note) {
            return editResult(false, "A note can't be added here.");
        }
        if (chord == 1) {
            ms->select(note); // the note just added: its key is lit with its chord mates
        } else if (ChordRest* again = selTick >= Fraction(0, 1) ? ms->findCR(selTick, selTrack) : nullptr) {
            // the place the next key goes to stays picked
            EngravingItem* pick = again;
            if (again->isChord()) {
                pick = toChord(again)->upNote();
                for (Note* n : toChord(again)->notes()) {
                    if (n->epitch() == selPitch) {
                        pick = n;
                    }
                }
            }
            ms->select(pick);
        }
        afterEdit(ms, m_playbackModel.get(), []() {});
        if (!playing && m_playbackModel) {
            m_playbackModel->triggerEventsForItems({ note }, 500000, true);
        }
        return editResult(true);
    }

    track_idx_t track = 0;
    if (!startStep(ms, den, dots, track)) {
        return editResult(false, "Select a note or rest first.");
    }
    const Fraction tick = is.segment()->tick();
    ms->startCmd(TranslatableString::untranslatable("Enter note"));
    Note* note = ms->addMidiPitch(midi, false, true);
    ms->endCmd();
    is.setNoteEntryMode(false);
    if (!note) {
        return editResult(false, "A note can't go here.");
    }
    m_enteredTick = tick.ticks();
    m_enteredTrack = track;
    selectNextStep(ms, track, tick);
    afterEdit(ms, m_playbackModel.get(), [this, ms]() {
        m_totalPlayTime = uticksToSecs(ms, ms->repeatList(true).ticks()) + PLAYBACK_TAIL_SECS;
        if (m_audio && m_audioReady) {
            m_audio->setDuration(m_totalPlayTime);
        }
    });
    if (!playing && m_playbackModel) {
        m_playbackModel->triggerEventsForItems({ note }, 500000, true);
    }
    return editResult(true);
}

// ---- one line at a time

// Sets every part's visibility: the one shown alone (`filtered`), or as the score has it. Part::setShow
// itself, as desktop's Instruments panel reaches through Pid::VISIBLE, but outside the undo stack.
void Session::applyShownPart(MasterScore* ms, bool filtered)
{
    for (Part* part : ms->parts()) {
        auto it = m_partShow.find(part);
        if (it == m_partShow.end()) {
            continue; // a line added meanwhile: shown
        }
        part->setShow(filtered ? part == m_shownPart : it->second);
    }
}

std::string Session::editPartsJson() const
{
    const MasterScore* ms = m_project ? m_project->masterScore() : nullptr;
    if (!ms) {
        return "{\"shown\":-1,\"parts\":[]}";
    }
    int shown = -1;
    std::string parts;
    for (size_t i = 0; i < ms->parts().size(); ++i) {
        const Part* part = ms->parts()[i];
        if (part == m_shownPart) {
            shown = int(i);
        }
        String name = part->instrument()->nameAsPlainText();
        if (name.empty()) {
            name = part->partName();
        }
        parts += std::string(parts.empty() ? "" : ",") + "{\"name\":" + jsonStr(name.toStdString())
                 + ",\"show\":" + (partShown(part) ? "true" : "false")
                 + ",\"staff\":" + std::to_string(part->startTrack() / VOICES)
                 + ",\"staves\":" + std::to_string(part->nstaves()) + "}";
    }
    return "{\"shown\":" + std::to_string(shown) + ",\"parts\":[" + parts + "]}";
}

std::string Session::editShowPart(int index)
{
    MasterScore* ms = m_project ? m_project->masterScore() : nullptr;
    if (!ms) {
        return editPartsJson();
    }
    const Part* want = index >= 0 && index < int(ms->parts().size()) ? ms->parts()[index] : nullptr;
    if (want == m_shownPart) {
        return editPartsJson();
    }
    // the place picked, to pick the same moment in the line now shown
    ChordRest* cr = ms->selection().isRange() ? nullptr : selectedChordRest(ms);
    const Fraction tick = cr ? cr->tick() : Fraction(-1, 1);
    const track_idx_t crTrack = cr ? cr->track() : 0;
    ms->deselectAll();

    if (m_shownPart) {
        applyShownPart(ms, false);
        m_partShow.clear();
        m_shownPart = nullptr;
    }
    if (want) {
        for (const Part* part : ms->parts()) {
            m_partShow[part] = part->show();
        }
        m_shownPart = want;
        applyShownPart(ms, true);
    }
    ms->setLayoutAll();
    ms->doLayout();

    if (cr) {
        ChordRest* now = ms->findCR(tick, want ? want->startTrack() : crTrack);
        if (now) {
            ms->select(now->isChord() ? static_cast<EngravingItem*>(toChord(now)->upNote()) : now);
        }
    }
    m_enteredTick = -1;
    return editPartsJson();
}

// ---- ranges, copy and paste

std::string Session::editExtend(int pageIndex, double x, double y, double radius)
{
    MasterScore* ms = m_project ? m_project->masterScore() : nullptr;
    if (!ms || pageIndex < 0 || pageIndex >= int(ms->pages().size())) {
        return "null";
    }
    EngravingItem* to = nearestNoteOrRest(ms->pages()[pageIndex], x, y, radius);
    if (!to) {
        return editSelectionJson();
    }
    if (ms->selection().isNone()) {
        ms->select(to);
    } else {
        // as Shift+click on desktop: Score::select(RANGE) spans from what is selected to here
        ms->select(to, SelectType::RANGE, to->staffIdx());
    }
    return editSelectionJson();
}

namespace {
// the clipboard as Score::cmdPaste reads it
class ClipData : public IMimeData
{
public:
    ClipData(const std::string& type, const muse::ByteArray& data)
        : m_type(type), m_data(data) {}
    std::vector<std::string> formats() const override { return { m_type }; }
    bool hasFormat(const std::string& t) const override { return t == m_type; }
    muse::ByteArray data(const std::string& t) const override { return t == m_type ? m_data : muse::ByteArray(); }
    bool hasImage() const override { return false; }
    std::shared_ptr<muse::draw::Pixmap> imageData() const override { return nullptr; }
private:
    std::string m_type;
    muse::ByteArray m_data;
};
}

// Copy (and Cut: copy, then delete as desktop does) the selected range, or the single note or rest
std::string Session::editCopy(bool cut)
{
    MasterScore* ms = m_project ? m_project->masterScore() : nullptr;
    if (!ms || ms->selection().isNone() || !ms->selection().canCopy()) {
        return editResult(false, "Select the notes to copy first.");
    }
    m_clip = ms->selection().mimeData();
    m_clipType = ms->selection().mimeType().toStdString();
    if (m_clip.empty()) {
        return editResult(false, "Nothing to copy there.");
    }
    if (cut) {
        ms->startCmd(TranslatableString::untranslatable("Cut"));
        ms->cmdDeleteSelection();
        ms->endCmd();
        afterEdit(ms, m_playbackModel.get(), []() {});
    }
    return editResult(true);
}

// Paste at the selected note or rest (a range: at its start), replacing what is there, as desktop's Paste
std::string Session::editPaste()
{
    MasterScore* ms = m_project ? m_project->masterScore() : nullptr;
    if (!ms || ms->selection().isNone()) {
        return editResult(false, "Select where to paste first.");
    }
    if (m_clip.empty()) {
        return editResult(false, "Copy something first.");
    }
    ClipData clip(m_clipType, m_clip);
    ms->startCmd(TranslatableString::untranslatable("Paste"));
    const bool ok = ms->cmdPaste(&clip, nullptr, Fraction(1, 1));
    if (!ok) {
        ms->endCmd(true); // rolled back
        return editResult(false, "It can't be pasted there (not enough room, or a different kind of line).");
    }
    ms->endCmd();
    afterEdit(ms, m_playbackModel.get(), [this, ms]() {
        m_totalPlayTime = uticksToSecs(ms, ms->repeatList(true).ticks()) + PLAYBACK_TAIL_SECS;
        if (m_audio && m_audioReady) {
            m_audio->setDuration(m_totalPlayTime);
        }
    });
    return editResult(true);
}

// Editing that rebuilds bars or lines drops the selection: pick the same place again
struct SelectedPlace {
    Fraction tick;
    track_idx_t track = muse::nidx;
    bool valid = false;
};
static SelectedPlace placeOf(const MasterScore* ms)
{
    SelectedPlace p;
    if (ChordRest* cr = selectedChordRest(ms)) {
        p.tick = cr->tick();
        p.track = cr->track();
        p.valid = true;
    }
    return p;
}
static void reselect(MasterScore* ms, const SelectedPlace& p)
{
    if (!p.valid) {
        return;
    }
    Segment* seg = ms->tick2segment(p.tick, false, SegmentType::ChordRest);
    EngravingItem* e = seg ? seg->element(p.track) : nullptr;
    if (e) {
        ms->select(e->isChord() ? static_cast<EngravingItem*>(toChord(e)->upNote()) : e);
    }
}

// ---- voices, bars anywhere, marks, slurs and hairpins (composer #3-#6)

static std::string afterBigEdit(Session* s, MasterScore* ms, PlaybackModel* model, std::function<void()> updatePlayTime)
{
    afterEdit(ms, model, updatePlayTime);
    (void)s;
    return editResult(true);
}

std::string Session::editVoice(int voice, bool input)
{
    MasterScore* ms = m_project ? m_project->masterScore() : nullptr;
    if (!ms || voice < 1 || voice > int(VOICES) || ms->selection().isNone()) {
        return editResult(false, "Select a note or rest first.");
    }
    if (!input) {
        // move the selected notes to that voice, as desktop's voice buttons do outside note input
        ms->startCmd(TranslatableString::untranslatable("Change voice"));
        ms->changeSelectedElementsVoice(voice_idx_t(voice - 1));
        ms->endCmd();
        afterEdit(ms, m_playbackModel.get(), []() {});
        return editResult(true);
    }
    ChordRest* cr = selectedChordRest(ms);
    if (!cr) {
        return editResult(false, "Select a note or rest first.");
    }
    const track_idx_t track = cr->staffIdx() * VOICES + track_idx_t(voice - 1);
    Segment* seg = cr->segment();
    if (!seg->element(track) && !ms->findCR(seg->tick(), track)) {
        // nothing in that voice here yet: rests to enter over, as desktop makes when note input switches voice
        ms->startCmd(TranslatableString::untranslatable("Voice"));
        ms->expandVoice(seg, track);
        ms->endCmd();
        afterEdit(ms, m_playbackModel.get(), []() {});
    }
    EngravingItem* e = seg->element(track);
    if (!e) {
        e = ms->findCR(seg->tick(), track); // a note in that voice already covers this place
    }
    if (!e) {
        return editResult(false, "That voice can't start here.");
    }
    ms->select(e->isChord() ? static_cast<EngravingItem*>(toChord(e)->upNote()) : e);
    return editResult(true);
}

std::string Session::editInsertBars(int count)
{
    MasterScore* ms = m_project ? m_project->masterScore() : nullptr;
    ChordRest* cr = ms ? selectedChordRest(ms) : nullptr;
    if (!cr && ms && ms->selection().isRange() && ms->selection().startSegment()) {
        cr = toChordRest(ms->selection().startSegment()->element(staff2track(ms->selection().staffStart())));
    }
    if (!ms || !cr || count < 1 || count > 100) {
        return editResult(false, "Select a note or rest in the bar to put new bars before.");
    }
    const SelectedPlace place = placeOf(ms);
    MeasureBase* before = cr->measure();
    Score::InsertMeasureOptions options;
    options.createEmptyMeasures = false;
    options.moveSignaturesClef = true;
    options.needDeselectAll = false;
    ms->startCmd(TranslatableString::untranslatable("Insert bars"));
    for (int i = 0; i < count; ++i) {
        ms->insertMeasure(before, options); // MasterScore's: in the parts too
    }
    ms->endCmd();
    reselect(ms, place); // the same tick: now the first of the new bars
    return afterBigEdit(this, ms, m_playbackModel.get(), [this, ms]() {
        m_totalPlayTime = uticksToSecs(ms, ms->repeatList(true).ticks()) + PLAYBACK_TAIL_SECS;
        if (m_audio && m_audioReady) {
            m_audio->setDuration(m_totalPlayTime);
        }
    });
}

std::string Session::editDeleteBars()
{
    MasterScore* ms = m_project ? m_project->masterScore() : nullptr;
    if (!ms || ms->selection().isNone()) {
        return editResult(false, "Select a note, a rest or bars first.");
    }
    MeasureBase* first = nullptr;
    MeasureBase* last = nullptr;
    if (ms->selection().isRange() && ms->selection().startSegment()) {
        first = ms->selection().startSegment()->measure();
        Segment* end = ms->selection().endSegment();
        last = end ? (end->prev1() ? end->prev1()->measure() : first) : ms->lastMeasure();
    } else if (ChordRest* cr = selectedChordRest(ms)) {
        first = last = cr->measure();
    }
    if (!first || !last) {
        return editResult(false, "Select a note, a rest or bars first.");
    }
    if (first == ms->firstMeasure() && last == ms->lastMeasure()) {
        return editResult(false, "A score needs at least one bar.");
    }
    const Fraction at = first->tick();
    ms->deselectAll();
    ms->startCmd(TranslatableString::untranslatable("Delete bars"));
    ms->deleteMeasures(first, last);
    ms->endCmd();
    // the bar after the deleted ones (or the new last one), first line
    Measure* m = ms->tick2measure(std::min(at, ms->lastMeasure()->tick()));
    if (Segment* seg = m ? m->first(SegmentType::ChordRest) : nullptr) {
        if (EngravingItem* e = seg->element(0)) {
            ms->select(e->isChord() ? static_cast<EngravingItem*>(toChord(e)->upNote()) : e);
        }
    }
    return afterBigEdit(this, ms, m_playbackModel.get(), [this, ms]() {
        m_totalPlayTime = uticksToSecs(ms, ms->repeatList(true).ticks()) + PLAYBACK_TAIL_SECS;
        if (m_audio && m_audioReady) {
            m_audio->setDuration(m_totalPlayTime);
        }
    });
}

std::string Session::editMark(int kind)
{
    MasterScore* ms = m_project ? m_project->masterScore() : nullptr;
    if (!ms || ms->selection().isNone()) {
        return editResult(false, "Select a note first.");
    }
    static const SymId articulations[] = { SymId::articStaccatoAbove, SymId::articAccentAbove, SymId::articTenutoAbove, SymId::articMarcatoAbove };
    if (kind >= 0 && kind < 4) {
        // as the palette and desktop's shortcuts: on every selected note, a second time takes it off
        ms->startCmd(TranslatableString::untranslatable("Toggle articulation"));
        ms->toggleArticulation(articulations[kind]);
        ms->endCmd();
        afterEdit(ms, m_playbackModel.get(), []() {});
        return editResult(true);
    }
    if (kind < 4 || kind > 6) {
        return editResult(false, "No such mark.");
    }
    // fermata, breath mark and caesura are dropped on the note, as from the palette
    std::vector<ChordRest*> targets;
    if (ms->selection().isRange()) {
        for (EngravingItem* e : ms->selection().elements()) {
            ChordRest* cr = e->isNote() ? toNote(e)->chord() : (e->isChordRest() ? toChordRest(e) : nullptr);
            if (cr && std::find(targets.begin(), targets.end(), cr) == targets.end()) {
                targets.push_back(cr);
            }
        }
        if (kind == 4 && !targets.empty()) {
            targets = { targets.back() }; // a fermata over a passage goes on its last note
        }
    } else if (ChordRest* cr = selectedChordRest(ms)) {
        targets.push_back(cr);
    }
    if (targets.empty()) {
        return editResult(false, "Select a note first.");
    }
    const SelectedPlace place = placeOf(ms);
    ms->startCmd(TranslatableString::untranslatable("Add mark"));
    for (ChordRest* cr : targets) {
        EditData ed(nullptr);
        if (kind == 4) {
            Fermata* f = Factory::createFermata(ms->dummy()->segment());
            f->setSymIdAndTimeStretch(SymId::fermataAbove);
            ed.dropElement = f;
        } else {
            Breath* b = Factory::createBreath(ms->dummy()->segment());
            b->setSymId(kind == 5 ? SymId::breathMarkComma : SymId::caesura);
            ed.dropElement = b;
        }
        if (cr->acceptDrop(ed)) {
            cr->drop(ed);
        } else {
            delete ed.dropElement;
        }
    }
    ms->endCmd();
    reselect(ms, place);
    afterEdit(ms, m_playbackModel.get(), [this, ms]() {
        m_totalPlayTime = uticksToSecs(ms, ms->repeatList(true).ticks()) + PLAYBACK_TAIL_SECS;
        if (m_audio && m_audioReady) {
            m_audio->setDuration(m_totalPlayTime);
        }
    });
    return editResult(true);
}

std::string Session::editSlur()
{
    MasterScore* ms = m_project ? m_project->masterScore() : nullptr;
    if (!ms || ms->selection().isNone()) {
        return editResult(false, "Select the notes to slur first.");
    }
    std::vector<std::pair<ChordRest*, ChordRest*> > spans;
    const Selection& sel = ms->selection();
    if (sel.isRange()) {
        // one slur per line, from its first chord to its last (desktop's doAddSlur)
        for (track_idx_t track = staff2track(sel.staffStart()); track < staff2track(sel.staffEnd()); ++track) {
            ChordRest* a = nullptr;
            ChordRest* b = nullptr;
            for (EngravingItem* e : sel.uniqueElements()) {
                if (e->track() != track) {
                    continue;
                }
                EngravingItem* c = e->isNote() ? toNote(e)->chord() : e;
                if (!c->isChord()) {
                    continue;
                }
                ChordRest* cr = toChordRest(c);
                if (!a || a->tick() > cr->tick()) {
                    a = cr;
                }
                if (!b || b->tick() < cr->tick()) {
                    b = cr;
                }
            }
            if (a && b && a != b) {
                spans.emplace_back(a, b);
            }
        }
    } else if (ChordRest* cr = selectedChordRest(ms); cr && cr->isChord()) {
        ChordRest* next = nextChordRest(cr);
        while (next && !next->isChord()) {
            next = nextChordRest(next);
        }
        if (next) {
            spans.emplace_back(cr, next);
        }
    }
    if (spans.empty()) {
        return editResult(false, "A slur needs two notes: select a passage, or a note with one after it.");
    }
    const SelectedPlace place = placeOf(ms);
    ms->startCmd(TranslatableString::untranslatable("Add slur"));
    for (auto& [a, b] : spans) {
        ms->addSlur(a, b, nullptr);
    }
    ms->endCmd();
    if (place.valid) {
        reselect(ms, place);
    }
    afterEdit(ms, m_playbackModel.get(), []() {});
    return editResult(true);
}

std::string Session::editHairpin(int kind)
{
    MasterScore* ms = m_project ? m_project->masterScore() : nullptr;
    if (!ms || ms->selection().isNone()) {
        return editResult(false, "Select the notes first.");
    }
    const SelectedPlace place = placeOf(ms);
    ms->startCmd(TranslatableString::untranslatable("Add hairpin"));
    std::vector<Hairpin*> made = ms->addHairpins(kind == 1 ? HairpinType::DIM_HAIRPIN : HairpinType::CRESC_HAIRPIN);
    ms->endCmd();
    if (made.empty()) {
        return editResult(false, "A hairpin needs notes to go under: select a passage or a note.");
    }
    if (place.valid) {
        reselect(ms, place);
    }
    afterEdit(ms, m_playbackModel.get(), []() {});
    return editResult(true);
}

// A tune, from the selected note or rest on: "midi:sixteenths,midi:sixteenths,..." (midi -1 is a rest).
// One undo step. Notes that cross a bar line are tied and split as in desktop's note input
// (Score::setNoteRest, rhythmic); what was there is replaced. Stops where the score ends.
std::string Session::editInsertNotes(const std::string& spec)
{
    MasterScore* ms = m_project ? m_project->masterScore() : nullptr;
    ChordRest* start = ms ? selectedChordRest(ms) : nullptr;
    if (!ms || !start) {
        return editResult(false, "Select the note or rest where the tune should start.");
    }
    std::vector<std::pair<int, int> > events;
    for (size_t pos = 0; pos < spec.size();) {
        size_t colon = spec.find(':', pos);
        size_t comma = spec.find(',', pos);
        if (comma == std::string::npos) {
            comma = spec.size();
        }
        if (colon == std::string::npos || colon > comma) {
            break;
        }
        const int midi = std::atoi(spec.substr(pos, colon - pos).c_str());
        const int units = std::atoi(spec.substr(colon + 1, comma - colon - 1).c_str());
        if (units > 0 && midi >= -1 && midi < 128) {
            events.emplace_back(midi, units);
        }
        pos = comma + 1;
    }
    if (events.empty()) {
        return editResult(false, "There are no notes to put in.");
    }
    const Fraction firstTick = start->tick();
    const track_idx_t track = start->track();
    Fraction tick = firstTick;
    size_t done = 0;
    ms->startCmd(TranslatableString::untranslatable("Enter notes"));
    for (const auto& [midi, units] : events) {
        Segment* seg = ms->tick2segment(tick, false, SegmentType::ChordRest);
        if (!seg) {
            break; // the score ends
        }
        NoteVal nv(midi); // -1: a rest
        if (midi >= 0) {
            nv.tpc1 = nv.tpc2 = pitch2tpc(midi, ms->staff(track / VOICES)->key(tick), Prefer::NEAREST);
        }
        const Fraction len(units, 16);
        if (!ms->setNoteRest(seg, track, nv, len, DirectionV::AUTO, false, {}, true)) {
            break;
        }
        tick += len;
        ++done;
    }
    ms->endCmd();
    // the first note of the tune stays selected
    Note* first = nullptr;
    if (Segment* seg = ms->tick2segment(firstTick, false, SegmentType::ChordRest)) {
        if (EngravingItem* e = seg->element(track); e && e->isChord()) {
            first = toChord(e)->upNote();
        }
    }
    if (first) {
        ms->select(first);
    }
    afterEdit(ms, m_playbackModel.get(), [this, ms]() {
        m_totalPlayTime = uticksToSecs(ms, ms->repeatList(true).ticks()) + PLAYBACK_TAIL_SECS;
        if (m_audio && m_audioReady) {
            m_audio->setDuration(m_totalPlayTime);
        }
    });
    return std::string("{\"ok\":") + (done ? "true" : "false") + ",\"done\":" + std::to_string(done) + ",\"total\":" + std::to_string(events.size())
           + (done ? "" : ",\"error\":\"The tune could not be put in there.\"") + "}";
}

// The first note or rest of the first staff, for a score that was just made
std::string Session::editSelectStart()
{
    MasterScore* ms = m_project ? m_project->masterScore() : nullptr;
    Measure* m = ms ? ms->firstMeasure() : nullptr;
    Segment* seg = m ? m->first(SegmentType::ChordRest) : nullptr;
    track_idx_t track = 0;
    for (size_t i = 0; ms && i < ms->nstaves(); ++i) {
        if (ms->staff(i)->show()) {
            track = i * VOICES;
            break;
        }
    }
    EngravingItem* el = seg ? seg->element(track) : nullptr;
    if (!el) {
        return "null";
    }
    ms->select(el->isChord() ? static_cast<EngravingItem*>(toChord(el)->upNote()) : el);
    return editSelectionJson();
}

// ---- more of what a composer needs: bars, key, time, ties, accidentals, triplets, chords, words, lines

// Bars on the end of the score
std::string Session::editAddBars(int count)
{
    MasterScore* ms = m_project ? m_project->masterScore() : nullptr;
    if (!ms || count < 1 || count > 200) {
        return editResult(false, "Choose how many bars to add.");
    }
    const SelectedPlace place = ms ? placeOf(ms) : SelectedPlace();
    ms->startCmd(TranslatableString::untranslatable("Add bars"));
    ms->appendMeasures(count);
    ms->endCmd();
    reselect(ms, place);
    afterEdit(ms, m_playbackModel.get(), [this, ms]() {
        m_totalPlayTime = uticksToSecs(ms, ms->repeatList(true).ticks()) + PLAYBACK_TAIL_SECS;
        if (m_audio && m_audioReady) {
            m_audio->setDuration(m_totalPlayTime);
        }
    });
    return editResult(true);
}

// Key signature (sharps positive, flats negative) from the selected bar on, on every line
std::string Session::editSetKey(int key)
{
    MasterScore* ms = m_project ? m_project->masterScore() : nullptr;
    ChordRest* cr = ms ? selectedChordRest(ms) : nullptr;
    if (!cr || key < -7 || key > 7) {
        return editResult(false, "Select a note or rest in the bar where the key starts.");
    }
    const Fraction tick = cr->measure()->tick();
    const SelectedPlace place = ms ? placeOf(ms) : SelectedPlace();
    ms->startCmd(TranslatableString::untranslatable("Change key signature"));
    for (staff_idx_t i = 0; i < ms->nstaves(); ++i) {
        KeySigEvent ke;
        ke.setConcertKey(Key(key));
        ms->undoChangeKeySig(ms->staff(i), tick, ke);
    }
    ms->endCmd();
    reselect(ms, place);
    afterEdit(ms, m_playbackModel.get(), []() {});
    return editResult(true);
}

// Time signature from the selected bar on, on every line
std::string Session::editSetTime(int num, int den)
{
    MasterScore* ms = m_project ? m_project->masterScore() : nullptr;
    ChordRest* cr = ms ? selectedChordRest(ms) : nullptr;
    if (!cr || num < 1 || num > 32 || (den != 2 && den != 4 && den != 8 && den != 16)) {
        return editResult(false, "Select a note or rest in the bar where the time signature starts.");
    }
    const SelectedPlace place = ms ? placeOf(ms) : SelectedPlace();
    ms->startCmd(TranslatableString::untranslatable("Change time signature"));
    TimeSig* ts = Factory::createTimeSig(ms->dummy()->segment());
    ts->setSig(Fraction(num, den), TimeSigType::NORMAL);
    ms->cmdAddTimeSig(cr->measure(), 0, ts, false);
    ms->endCmd();
    reselect(ms, place);
    afterEdit(ms, m_playbackModel.get(), [this, ms]() {
        m_totalPlayTime = uticksToSecs(ms, ms->repeatList(true).ticks()) + PLAYBACK_TAIL_SECS;
        if (m_audio && m_audioReady) {
            m_audio->setDuration(m_totalPlayTime);
        }
    });
    return editResult(true);
}

// Ties the selected note to the next one of the same pitch, or takes the tie away again
std::string Session::editTie()
{
    MasterScore* ms = m_project ? m_project->masterScore() : nullptr;
    Note* note = nullptr;
    if (!ms || !selectedChordRest(ms, &note) || !note) {
        return editResult(false, "Select a note first.");
    }
    ms->cmdToggleTie(); // starts and ends its own command
    afterEdit(ms, m_playbackModel.get(), []() {});
    return editResult(true);
}

// kind 0 sharp, 1 flat, 2 natural: as desktop's accidental buttons
std::string Session::editAccidental(int kind)
{
    MasterScore* ms = m_project ? m_project->masterScore() : nullptr;
    Note* note = nullptr;
    if (!ms || !selectedChordRest(ms, &note) || !note) {
        return editResult(false, "Select a note first.");
    }
    const AccidentalType types[] = { AccidentalType::SHARP, AccidentalType::FLAT, AccidentalType::NATURAL };
    ms->startCmd(TranslatableString::untranslatable("Accidental"));
    ms->toggleAccidental(types[std::max(0, std::min(2, kind))]);
    ms->endCmd();
    afterEdit(ms, m_playbackModel.get(), []() {});
    return editResult(true);
}

// The selected note or rest becomes three in the time of two (a triplet)
std::string Session::editTriplet()
{
    MasterScore* ms = m_project ? m_project->masterScore() : nullptr;
    ChordRest* cr = ms ? selectedChordRest(ms) : nullptr;
    if (!cr) {
        return editResult(false, "Select a note or rest first.");
    }
    if (cr->tuplet()) {
        return editResult(false, "That is already in a tuplet.");
    }
    const track_idx_t track = cr->track();
    const Fraction tick = cr->tick();
    ms->startCmd(TranslatableString::untranslatable("Triplet"));
    ms->addTuplet(cr, Fraction(3, 2), TupletNumberType::SHOW_NUMBER, TupletBracketType::AUTO_BRACKET);
    ms->endCmd();
    if (Segment* seg = ms->tick2segment(tick, false, SegmentType::ChordRest)) {
        if (EngravingItem* e = seg->element(track)) {
            ms->select(e->isChord() ? static_cast<EngravingItem*>(toChord(e)->upNote()) : e);
        }
    }
    afterEdit(ms, m_playbackModel.get(), []() {});
    return editResult(true);
}

// Another note on the selected note's chord, by letter (nearest above it, as desktop's Shift+letter)
std::string Session::editAddToChord(int letter)
{
    MasterScore* ms = m_project ? m_project->masterScore() : nullptr;
    Note* note = nullptr;
    if (!ms || !selectedChordRest(ms, &note) || !note || letter < 0 || letter > 6) {
        return editResult(false, "Select a note first.");
    }
    Chord* chord = note->chord();
    InputState& is = ms->inputState();
    is.setTrack(chord->track());
    is.setSegment(chord->segment());
    is.setDuration(chord->durationType());
    is.setRest(false);
    is.setNoteEntryMode(true);
    NoteInputParams params;
    if (!ms->resolveNoteInputParams(letter, true, params)) {
        is.setNoteEntryMode(false);
        return editResult(false, "A note can't be added here.");
    }
    ms->startCmd(TranslatableString::untranslatable("Add note to chord"));
    ms->cmdAddPitch(params, true, false);
    ms->endCmd();
    is.setNoteEntryMode(false);
    afterEdit(ms, m_playbackModel.get(), []() {});
    return editResult(true);
}

// Words above the selected note or rest (staff text)
std::string Session::editStaffText(const std::string& text)
{
    MasterScore* ms = m_project ? m_project->masterScore() : nullptr;
    ChordRest* cr = ms ? selectedChordRest(ms) : nullptr;
    if (!cr || text.empty()) {
        return editResult(false, "Select a note or rest, and type the words.");
    }
    ms->startCmd(TranslatableString::untranslatable("Add text"));
    StaffText* t = Factory::createStaffText(cr->segment());
    t->setParent(cr->segment());
    t->setTrack(cr->track());
    t->setPlainText(String::fromStdString(text));
    ms->undoAddElement(t);
    ms->endCmd();
    afterEdit(ms, m_playbackModel.get(), []() {});
    return editResult(true);
}

// A dynamic mark under the selected note or rest: 0 ppp, 1 pp, 2 p, 3 mp, 4 mf, 5 f, 6 ff, 7 fff
std::string Session::editDynamic(int which)
{
    MasterScore* ms = m_project ? m_project->masterScore() : nullptr;
    ChordRest* cr = ms ? selectedChordRest(ms) : nullptr;
    if (!cr || which < 0 || which > 7) {
        return editResult(false, "Select a note or rest first.");
    }
    const char* names[] = { "ppp", "pp", "p", "mp", "mf", "f", "ff", "fff" };
    ms->startCmd(TranslatableString::untranslatable("Add dynamic"));
    Dynamic* d = Factory::createDynamic(cr->segment());
    d->setDynamicType(String::fromAscii(names[which])); // sets the type and its text
    d->setParent(cr->segment());
    d->setTrack(cr->track());
    ms->undoAddElement(d);
    ms->endCmd();
    afterEdit(ms, m_playbackModel.get(), []() {});
    return editResult(true);
}

// A lyric syllable under the selected note. A trailing "-" begins or continues a word, as typing a hyphen does.
std::string Session::editLyric(const std::string& text)
{
    MasterScore* ms = m_project ? m_project->masterScore() : nullptr;
    Note* note = nullptr;
    if (!ms || !selectedChordRest(ms, &note) || !note || text.empty()) {
        return editResult(false, "Select a note, and type its syllable.");
    }
    Chord* chord = note->chord();
    std::string word = text;
    bool hyphen = false;
    if (word.size() > 1 && word.back() == '-') {
        hyphen = true;
        word.pop_back();
    }
    // is the syllable before this one in the same line the start of a word?
    bool inWord = false;
    for (Segment* s = chord->segment()->prev1(SegmentType::ChordRest); s; s = s->prev1(SegmentType::ChordRest)) {
        EngravingItem* e = s->element(chord->track());
        if (!e || !e->isChordRest()) {
            continue;
        }
        const auto& ly = toChordRest(e)->lyrics();
        if (!ly.empty()) {
            inWord = ly.front()->syllabic() == LyricsSyllabic::BEGIN || ly.front()->syllabic() == LyricsSyllabic::MIDDLE;
        }
        break;
    }
    ms->startCmd(TranslatableString::untranslatable("Add lyric"));
    for (Lyrics* old : std::vector<Lyrics*>(chord->lyrics())) {
        if (old->verse() == 0) {
            ms->undoRemoveElement(old);
        }
    }
    Lyrics* l = Factory::createLyrics(chord);
    l->setParent(chord);
    l->setTrack(chord->track());
    l->setPlainText(String::fromStdString(word));
    l->setVerse(0);
    l->setSyllabic(hyphen ? (inWord ? LyricsSyllabic::MIDDLE : LyricsSyllabic::BEGIN) : (inWord ? LyricsSyllabic::END : LyricsSyllabic::SINGLE));
    ms->undoAddElement(l);
    ms->endCmd();
    afterEdit(ms, m_playbackModel.get(), []() {});
    return editResult(true);
}

// A new line at the bottom, with the sound of the last one (clef 0 treble, 1 treble an octave lower, 2 bass)
std::string Session::editAddLine(const std::string& name, int clef)
{
    MasterScore* ms = m_project ? m_project->masterScore() : nullptr;
    if (!ms || ms->parts().empty() || name.empty()) {
        return editResult(false, "Name the new line.");
    }
    const ClefType clefs[] = { ClefType::G, ClefType::G8_VB, ClefType::F };
    Part* src = ms->parts().back();
    const SelectedPlace place = ms ? placeOf(ms) : SelectedPlace();
    ms->startCmd(TranslatableString::untranslatable("Add line"));
    Part* part = new Part(ms);
    Instrument* instr = new Instrument(*src->instrument(Fraction(0, 1)));
    instr->setTrackName(String::fromStdString(name));
    instr->setLongName(String::fromStdString(name));
    instr->setShortName(String::fromStdString(name.size() <= 4 ? name : name.substr(0, 3) + "."));
    part->setInstrument(instr, Fraction(-1, 1)); // the first instrument, as appendPart does
    part->setPartName(String::fromStdString(name));
    Staff* staff = Factory::createStaff(part);
    staff->setScore(ms);
    staff->init(src->staff(0));
    staff->setDefaultClefType(ClefTypeList(clefs[std::max(0, std::min(2, clef))]));
    ms->undoInsertStaff(staff, 0);
    ms->undoInsertPart(part, ms->parts().size());
    ms->setUpTempoMapLater();
    ms->masterScore()->rebuildMidiMapping();
    ms->endCmd();
    reselect(ms, place);
    afterEdit(ms, m_playbackModel.get(), []() {});
    syncTracks();
    return editResult(true);
}

// The name of the selected line
std::string Session::editRenameLine(const std::string& name)
{
    MasterScore* ms = m_project ? m_project->masterScore() : nullptr;
    ChordRest* cr = ms ? selectedChordRest(ms) : nullptr;
    if (!cr || name.empty()) {
        return editResult(false, "Select a note or rest on the line, and type its name.");
    }
    Part* part = cr->staff()->part();
    const SelectedPlace place = ms ? placeOf(ms) : SelectedPlace();
    ms->startCmd(TranslatableString::untranslatable("Rename line"));
    part->setPartName(String::fromStdString(name));
    EditPart::setInstrumentName(ms, part, Fraction(-1, 1), String::fromStdString(name));
    EditPart::setInstrumentAbbreviature(ms, part, Fraction(-1, 1), String::fromStdString(name.size() <= 4 ? name : name.substr(0, 3) + "."));
    ms->endCmd();
    reselect(ms, place);
    afterEdit(ms, m_playbackModel.get(), []() {});
    syncTracks();
    return editResult(true);
}

std::string Session::editUndoRedo(bool undo)
{
    MasterScore* ms = m_project ? m_project->masterScore() : nullptr;
    if (!ms) {
        return editResult(false, "No score is open.");
    }
    if (undo ? !ms->undoStack()->canUndo() : !ms->undoStack()->canRedo()) {
        return editResult(false, "Nothing to " + std::string(undo ? "undo." : "redo."));
    }
    ms->undoRedo(undo, nullptr);
    m_enteredTick = -1;
    if (m_shownPart && std::find(ms->parts().begin(), ms->parts().end(), m_shownPart) == ms->parts().end()) {
        applyShownPart(ms, false);
        m_partShow.clear();
        m_shownPart = nullptr;
        ms->setLayoutAll();
        ms->doLayout();
    }
    afterEdit(ms, m_playbackModel.get(), [this, ms]() {
        m_totalPlayTime = uticksToSecs(ms, ms->repeatList(true).ticks()) + PLAYBACK_TAIL_SECS;
    });
    syncTracks();
    return editResult(true);
}

// As NotationProject::writeProject, into a file of the engine's own file system
std::string Session::saveTo(const std::string& path)
{
    if (!m_project) {
        return editResult(false, "No score is open.");
    }
    // into memory first (the engine's file classes need a real file system), then to the file
    io::Buffer buf;
    buf.open(io::IODevice::WriteOnly);
    MscWriter::Params params;
    params.device = &buf;
    params.filePath = io::path_t(path);
    params.mainFileName = String::fromStdString(io::filename(io::path_t(path), false).toStdString()) + u".mscx";
    params.mode = MscIoMode::Zip;
    bool ok = false;
    {
        MscWriter writer(params);
        Ret ret = writer.open();
        if (!ret) {
            return editResult(false, "Could not write the file: " + ret.toString());
        }
        // The file gets each line's own visibility, never Edit's one line at a time. Multi-bar rests are
        // written as laid out, so with those on the page is laid out as the file should have it too.
        MasterScore* ms = m_project->masterScore();
        const bool filtered = m_shownPart != nullptr;
        const bool relayout = filtered && ms->style().styleB(Sid::createMultiMeasureRests);
        if (filtered) {
            applyShownPart(ms, false);
            if (relayout) {
                ms->setLayoutAll();
                ms->doLayout();
            }
        }
        ok = m_project->writeMscz(writer, /*createThumbnail*/ false) && !writer.hasError();
        if (filtered) {
            applyShownPart(ms, true);
            if (relayout) {
                ms->setLayoutAll();
                ms->doLayout();
            }
        }
        writer.close();
    }
    if (!ok) {
        return editResult(false, "MuseScore could not write the score.");
    }
    const ByteArray data = buf.data();
    FILE* f = fopen(path.c_str(), "wb");
    if (!f) {
        return editResult(false, "Could not create " + path);
    }
    const bool wrote = fwrite(data.constData(), 1, data.size(), f) == data.size();
    fclose(f);
    return editResult(wrote, "Could not write " + path);
}

// ---------------------------------------------------------------------------
// Practice: speed and loop

// As PlaybackController::setTempoMultiplier and NotationPlayback::setTempoMultiplier
std::string Session::setTempoMultiplier(double multiplier, double at)
{
    MasterScore* score = m_project ? m_project->masterScore() : nullptr;
    if (!score || !m_playbackModel) {
        return "null";
    }
    multiplier = std::clamp(multiplier, 0.1, 3.0);
    const bool playing = m_audio && m_audio->status() == PlaybackStatus::Running;
    const int utick = secsToUticks(score, std::max(0.0, at));
    if (playing) {
        m_audio->pause();
    }
    if (score->tempomap()->setTempoMultiplier(multiplier)) {
        score->updateRepeatListTempo();
        m_playbackModel->reload();
        // as in NotationPlayback::updateTotalPlayTime
        m_totalPlayTime = uticksToSecs(score, score->repeatList(true).ticks()) + PLAYBACK_TAIL_SECS;
        if (m_audio && m_audioReady) {
            m_audio->setDuration(m_totalPlayTime);
        }
    }
    if (m_audio && m_audioReady) {
        const double secs = uticksToSecs(score, utick);
        m_audio->seek(secs, true);
        applyLoop();
        emit("position", cursorJson(secs));
        if (playing) {
            m_audio->prepareToPlay([this]() { m_audio->resume(); });
        }
    }
    return practiceJson();
}

// The note or rest at a played tick: where it starts and ends (played ticks)
static std::pair<int, int> chordRestAt(const Score* score, int utick)
{
    for (const RepeatSegment* rs : playedRepeats(score)) {
        if (utick < rs->utick || utick >= rs->utick + rs->len()) {
            continue;
        }
        const int offset = rs->utick - rs->tick;
        const int raw = utick - offset;
        const Measure* m = score->tick2measure(Fraction::fromTicks(raw));
        if (!m) {
            break;
        }
        int start = m->tick().ticks();
        int end = m->endTick().ticks();
        for (const Segment* s = m->first(SegmentType::ChordRest); s; s = s->next(SegmentType::ChordRest)) {
            if (s->tick().ticks() <= raw) {
                start = s->tick().ticks();
            } else {
                end = s->tick().ticks();
                break;
            }
        }
        return { start + offset, end + offset };
    }
    return { utick, utick };
}

// As NotationPlayback::addLoopIn / addLoopOut, at the play position
std::string Session::setLoopMarker(bool right, double at)
{
    const Score* score = m_project ? m_project->masterScore() : nullptr;
    if (!score || !m_audio) {
        return "null";
    }
    const int last = score->repeatList(true).ticks();
    const std::pair<int, int> cr = chordRestAt(score, secsToUticks(score, std::max(0.0, at)));
    if (!right) {
        m_loopIn = cr.first;
        if (m_loopOut < 0 || m_loopIn >= m_loopOut) { // In past Out: Out goes to the end
            m_loopOut = last;
        }
    } else {
        m_loopOut = std::min(cr.second, last);
        if (m_loopIn < 0 || m_loopOut <= m_loopIn) { // Out before In: In goes to the start
            m_loopIn = 0;
        }
    }
    m_loopOn = true; // as addLoopBoundaryToTick
    applyLoop();
    return practiceJson();
}

// As PlaybackController::toggleLoopPlayback: with no markers, the whole score
std::string Session::setLoopEnabled(bool on)
{
    const Score* score = m_project ? m_project->masterScore() : nullptr;
    if (!score) {
        return "null";
    }
    if (on && m_loopIn < 0) {
        m_loopIn = 0;
        m_loopOut = score->repeatList(true).ticks();
    }
    m_loopOn = on;
    applyLoop();
    return practiceJson();
}

std::string Session::temposJson() const
{
    const Score* score = m_project ? m_project->masterScore() : nullptr;
    if (!score) {
        return "[]";
    }
    const TempoMap* tm = score->tempomap();
    std::string s = "[";
    auto add = [&](int utick, double bpm) {
        if (s.size() > 1) {
            s += ",";
        }
        s += "[" + std::to_string(uticksToSecs(score, utick)) + "," + std::to_string(bpm) + "]";
    };
    for (const RepeatSegment* rs : playedRepeats(score)) {
        const int offset = rs->utick - rs->tick;
        const int end = rs->tick + rs->len();
        add(rs->utick, tm->tempo(rs->tick).toBPM().val); // the tempo in force where this pass starts
        for (auto it = tm->upper_bound(rs->tick); it != tm->end() && it->first < end; ++it) {
            add(it->first + offset, it->second.tempo.toBPM().val);
        }
    }
    return s + "]";
}

std::string Session::clearLoop()
{
    m_loopOn = false;
    m_loopIn = m_loopOut = -1;
    applyLoop();
    return practiceJson();
}

void Session::applyLoop()
{
    const Score* score = m_project ? m_project->masterScore() : nullptr;
    if (!m_audio || !m_audioReady || !score) {
        return;
    }
    if (!m_loopOn || m_loopIn < 0 || m_loopOut <= m_loopIn) {
        m_audio->resetLoop();
        return;
    }
    m_audio->setLoop(uticksToSecs(score, m_loopIn), uticksToSecs(score, m_loopOut));
}

std::string Session::barsJson() const
{
    const Score* score = m_project ? m_project->masterScore() : nullptr;
    if (!score) {
        return "{\"bars\":[],\"sections\":[]}";
    }
    // a raw tick's first play, in played seconds (with repeats, the first pass through it)
    auto firstPlay = [&](int tick, double& secs) {
        for (const RepeatSegment* rs : playedRepeats(score)) {
            if (tick >= rs->tick && tick < rs->tick + rs->len()) {
                secs = uticksToSecs(score, tick + rs->utick - rs->tick);
                return true;
            }
        }
        return false;
    };
    struct Bar { double secs; bool counted; };
    std::map<int, Bar> bars; // printed number -> where it starts
    std::string sections;
    std::set<std::pair<int, std::string>> seen; // a mark shown on several staves is one section
    for (const Measure* m = score->firstMeasure(); m; m = m->nextMeasure()) {
        double secs = 0;
        if (!firstPlay(m->tick().ticks(), secs)) {
            continue;
        }
        const int no = m->no() + 1;
        auto it = bars.find(no);
        if (it == bars.end()) {
            bars[no] = { secs, !m->irregular() };
        } else if (!it->second.counted && !m->irregular()) {
            it->second = { secs, true }; // the bar the number belongs to, not a pickup before it
        }
        for (const Segment* s = m->first(); s; s = s->next()) {
            for (const EngravingItem* e : s->annotations()) {
                if (!e->isRehearsalMark()) {
                    continue;
                }
                std::string text = toRehearsalMark(e)->plainText().simplified().toStdString();
                if (text.empty() || !seen.insert({ s->tick().ticks(), text }).second) {
                    continue;
                }
                double at = 0;
                if (firstPlay(s->tick().ticks(), at)) {
                    sections += std::string(sections.empty() ? "" : ",") + "[" + num(at) + "," + jsonStr(text) + "," + std::to_string(no) + "]";
                }
            }
        }
    }
    std::string s = "{\"bars\":[";
    for (const auto& [no, bar] : bars) {
        s += std::string(s.back() == '[' ? "" : ",") + "[" + std::to_string(no) + "," + num(bar.secs) + "]";
    }
    return s + "],\"sections\":[" + sections + "]}";
}

std::string Session::practiceJson() const
{
    const Score* score = m_project ? m_project->masterScore() : nullptr;
    if (!score) {
        return "null";
    }
    // bars as the reader counts them (the measure numbers printed), 1-based
    auto barAt = [&](int utick, bool end) {
        for (const RepeatSegment* rs : playedRepeats(score)) {
            const int u = end ? utick - 1 : utick;
            if (u >= rs->utick && u < rs->utick + rs->len()) {
                const Measure* m = score->tick2measure(Fraction::fromTicks(u - (rs->utick - rs->tick)));
                return m ? m->no() + 1 : 0;
            }
        }
        return 0;
    };
    std::string s = "{\"speed\":" + std::to_string(score->tempomap()->tempoMultiplier().val)
                    + ",\"duration\":" + std::to_string(m_totalPlayTime)
                    + ",\"loop\":" + (m_loopOn ? "true" : "false");
    if (m_loopIn >= 0) {
        s += ",\"from\":" + std::to_string(uticksToSecs(score, m_loopIn))
             + ",\"to\":" + std::to_string(uticksToSecs(score, m_loopOut))
             + ",\"fromBar\":" + std::to_string(barAt(m_loopIn, false))
             + ",\"toBar\":" + std::to_string(barAt(m_loopOut, true));
    }
    return s + "}";
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
            // unmuting the metronome turns its clicks on, as desktop's metronome button
            setMetronome(!mute);
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
    if (!t || t->out.auxSends.empty()) {
        return;
    }
    t->out.auxSends[REVERB_CHANNEL_IDX].signalAmount = static_cast<float>(std::clamp(amount, 0.0, 1.0));
    sendControl(*t);
}

void Session::setTrackSound(int trackKey, const std::string& resourceId)
{
    Track* t = findTrack(trackKey);
    auto it = m_fluidResources.find(resourceId);
    if (!t || !t->added || t->isMetronome || it == m_fluidResources.end() || !m_audio) {
        return;
    }
    // as choosing a sound in desktop's mixer: the new source replaces the old one
    t->source = AudioInputParams { it->second, {} };
    t->soundName = soundLabel(it->second);
    t->substitutionNote.clear();
    m_audio->setTrackInput(t->audioTrackId, t->source);
}

std::string Session::soundsJson() const
{
    // by bank and program, as InputResourceItem::buildMsBasicMenuItem
    std::map<std::pair<int, int>, const AudioResourceMeta*> byProgram;
    std::string automatic;
    for (const auto& [id, meta] : m_fluidResources) {
        if (meta.attributeVal(synth::SOUNDFONT_NAME_ATTRIBUTE) != u"MS Basic") {
            continue;
        }
        bool bankOk = false, programOk = false;
        const int bank = meta.attributeVal(synth::PRESET_BANK_ATTRIBUTE).toInt(&bankOk);
        const int program = meta.attributeVal(synth::PRESET_PROGRAM_ATTRIBUTE).toInt(&programOk);
        if (bankOk && programOk) {
            byProgram[{ bank, program }] = &meta;
        } else {
            automatic = id;
        }
    }

    std::function<std::string(const mu::playback::MsBasicItem&)> item = [&](const mu::playback::MsBasicItem& it) -> std::string {
        if (it.subItems.empty()) {
            auto found = byProgram.find({ it.preset.bank, it.preset.program });
            if (found == byProgram.end()) {
                return "";
            }
            // as InputResourceItem::buildMsBasicMenuItem
            std::string name = found->second->attributeVal(synth::PRESET_NAME_ATTRIBUTE).toStdString();
            if (name.empty()) {
                name = "Bank " + std::to_string(it.preset.bank) + ", preset " + std::to_string(it.preset.program);
            }
            // desktop hides these (https://github.com/musescore/MuseScore/issues/20142)
            if (name.find("Expr.") != std::string::npos) {
                return "";
            }
            return "{\"id\":" + jsonStr(found->second->id) + ",\"n\":" + jsonStr(name) + "}";
        }
        std::string children;
        for (const mu::playback::MsBasicItem& sub : it.subItems) {
            std::string s = item(sub);
            if (!s.empty()) {
                children += (children.empty() ? "" : ",") + s;
            }
        }
        if (children.empty()) {
            return "";
        }
        return "{\"t\":" + jsonStr(it.title.toStdString()) + ",\"c\":[" + children + "]}";
    };

    std::string tree;
    for (const mu::playback::MsBasicItem& category : mu::playback::MS_BASIC_PRESET_CATEGORIES) {
        std::string s = item(category);
        if (!s.empty()) {
            tree += (tree.empty() ? "" : ",") + s;
        }
    }
    return "{\"auto\":" + jsonStr(automatic) + ",\"tree\":[" + tree + "]}";
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

// The master volume in dB: the score's saved setting until changed
double Session::masterVolume() const
{
    return rawValue(m_master.volume);
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
             + ",\"soundId\":" + jsonStr(t.source.resourceMeta.id)
             + ",\"scoreSoundId\":" + jsonStr(t.scoreSoundId)
             + ",\"note\":" + jsonStr(t.substitutionNote)
             + "}";
    }
    s += "]";
    return s;
}

// ---------------------------------------------------------------------------
// Position: as in NotationPlayback::secToTick and PlaybackCursor::resolveCursorRectByTick

std::string Session::timelineJson() const
{
    const Score* score = m_project ? m_project->masterScore() : nullptr;
    if (!score) {
        return "[]";
    }

    const double spatium = score->style().spatium();
    const std::vector<Page*>& pages = score->pages();

    struct Point {
        double secs;
        int page;
        double x, y, h;
        bool barEnd;
        double secs100; // at 100% speed (see below)
        int bar;        // the bar's place in the score (as anchorsJson lists them)
        double inBar;   // how far through the bar, 0 to 1
    };
    std::map<const Measure*, int> barIndex;
    for (const Measure* m = score->firstMeasure(); m; m = m->nextMeasure()) {
        barIndex[m] = int(barIndex.size());
    }

    // A moment's time at 100% speed, whatever the speed now. The speed divides the music's time
    // but not pauses (fermatas, breath and section-break pauses: TempoMap::normalize adds their
    // seconds as they are), so the time at another speed isn't the time at 100% scaled: up to 3 s
    // off in a test score, which moved notes pinned to the music (issue found 16 Oct 2026).
    const TempoMap* tempos = score->tempomap();
    const double speed = tempos->tempoMultiplier().val;
    auto at100 = [&](int utick, double secs) {
#ifdef MSS_MUSESCORE_4_7
        if (std::abs(speed - 1.0) < 1e-9) {
            return secs;
        }
        double pauses = 0; // the pauses passed on the way to it, repeats unrolled
        for (const RepeatSegment* rs : playedRepeats(score)) {
            if (utick < rs->utick) {
                break;
            }
            const int end = std::min(rs->tick + rs->len() - 1, utick - rs->utick + rs->tick);
            for (auto it = tempos->lower_bound(rs->tick); it != tempos->end() && it->first <= end; ++it) {
                pauses += it->second.pause;
            }
        }
        return (secs - pauses) * speed + pauses;
#else
        return secs * speed;
#endif
    };
    std::vector<Point> points;

    auto point = [&](int utick, const System* system, double canvasX, const Measure* m, int tick, bool barEnd = false) {
        const Page* page = system->page();
        if (!page) {
            return;
        }
        // as in PlaybackCursor::resolveCursorRectByTick / calculateRect
        double bottomY = 0.0;
        for (size_t i = 0; i < score->nstaves(); ++i) {
            const SysStaff* ss = system->staff(i);
            if (!ss->show() || !score->staff(i)->show()) {
                continue;
            }
            bottomY = ss->bbox().bottom();
        }
        const int pageIdx = int(std::find(pages.begin(), pages.end(), page) - pages.begin());
        const double x = canvasX - spatium - page->pos().x();
        const double y = system->staffCanvasYpage(topStaff(score, system)) - 3.0 * spatium;
        const double h = bottomY + 6.0 * spatium;
        const double secs = uticksToSecs(score, utick);
        points.push_back({ std::round(secs * 10000.0) / 10000.0, pageIdx,
                           std::round(x), std::round(y), std::round(h), barEnd,
                           std::round(at100(utick, secs) * 10000.0) / 10000.0,
                           barIndex.count(m) ? barIndex[m] : -1,
                           m->ticks().ticks() > 0 ? std::round(double(tick - m->tick().ticks()) / m->ticks().ticks() * 100000.0) / 100000.0 : 0.0 });
    };

    for (const RepeatSegment* rs : playedRepeats(score)) {
        const int offset = rs->utick - rs->tick;
        for (const Measure* m : rs->measureList()) {
            const System* system = m->system();
            if (!system || system->staves().empty()) {
                continue;
            }
            for (const Segment* s = m->first(SegmentType::ChordRest); s; s = s->next(SegmentType::ChordRest)) {
                if (s->visible()) {
                    point(s->tick().ticks() + offset, system, s->canvasPos().x(), m, s->tick().ticks());
                }
            }
            const Segment* endBar = m->findSegment(SegmentType::EndBarLine, m->endTick());
            point(m->endTick().ticks() + offset, system, endBar ? endBar->canvasPos().x() : m->canvasPos().x() + m->width(), m, m->endTick().ticks(), true);
        }
    }

    // A bar's end point sits on its barline, at the same moment as the next
    // bar's first note, which is further right: the cursor would reach the
    // barline and then jump. When the next bar follows on the same line, the
    // end point is left out, so the cursor glides from the last note of a bar
    // to the first note of the next. (At the end of a line it still goes to
    // the barline, then on to the next line.)
    std::string out = "[";
    bool first = true;
    for (size_t i = 0; i < points.size(); ++i) {
        const Point& p = points[i];
        if (p.barEnd && i + 1 < points.size()) {
            const Point& next = points[i + 1];
            if (next.page == p.page && next.y == p.y && next.x > p.x) {
                continue;
            }
        }
        if (!first) {
            out += ",";
        }
        first = false;
        out += "[" + num(p.secs) + "," + std::to_string(p.page) + "," + num(p.x) + "," + num(p.y) + "," + num(p.h) + "," + num(p.secs100) + "," + std::to_string(p.bar) + "," + num(p.inBar) + "]";
    }
    return out + "]";
}

int Session::anchorId(const void* item) const
{
    auto it = m_anchorIds.find(item);
    if (it == m_anchorIds.end()) {
        it = m_anchorIds.emplace(item, m_nextAnchorId++).first;
    }
    return it->second;
}

std::string Session::anchorsJson() const
{
    const Score* score = m_project ? m_project->masterScore() : nullptr;
    if (!score) {
        return "{\"bars\":[],\"staves\":[]}";
    }
    std::string bars;
    for (const Measure* m = score->firstMeasure(); m; m = m->nextMeasure()) {
        bars += std::string(bars.empty() ? "" : ",") + "[" + std::to_string(anchorId(m)) + "," + std::to_string(m->ticks().ticks()) + "]";
    }
    std::string staves;
    for (size_t i = 0; i < score->nstaves(); ++i) {
        staves += std::string(staves.empty() ? "" : ",") + std::to_string(anchorId(score->staff(i)));
    }
    return "{\"bars\":[" + bars + "],\"staves\":[" + staves + "]}";
}

std::string Session::stavesJson() const
{
    const Score* score = m_project ? m_project->masterScore() : nullptr;
    if (!score) {
        return "[]";
    }
    const double spatium = score->style().spatium();
    const std::vector<Page*>& pages = score->pages();
    std::string out = "[";
    bool firstSystem = true;
    for (size_t pi = 0; pi < pages.size(); ++pi) {
        for (const System* system : pages[pi]->systems()) {
            if (system->staves().empty() || system->vbox()) { // a frame (title box) has no music
                continue;
            }
            // the same top as timelineJson's points, so the two match up
            const double y = std::round(system->staffCanvasYpage(topStaff(score, system)) - 3.0 * spatium);
            std::string staves;
            for (size_t i = 0; i < score->nstaves() && i < system->staves().size(); ++i) {
                const SysStaff* ss = system->staff(i);
                if (!ss->show() || !score->staff(i)->show()) {
                    continue;
                }
                const double top = system->staffCanvasYpage(i);
                const double bottom = top + score->staff(i)->staffHeight();
                if (!staves.empty()) {
                    staves += ",";
                }
                staves += "[" + std::to_string(i) + "," + num(std::round(top)) + "," + num(std::round(bottom)) + "]";
            }
            if (!firstSystem) {
                out += ",";
            }
            firstSystem = false;
            out += "[" + std::to_string(pi) + "," + num(y) + ",[" + staves + "]]";
        }
    }
    return out + "]";
}

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

    head += ",\"measure\":" + std::to_string(measure->no() + 1); // as printed, like the loop's bars and typed bars

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
        const double ry = system->staffCanvasYpage(topStaff(score, system)) - 3.0 * spatium;

        return head + ",\"page\":" + std::to_string(pageIdx)
               + ",\"x\":" + num(rx) + ",\"y\":" + num(ry)
               + ",\"w\":" + num(0.4 * spatium) + ",\"h\":" + num(bottomY + 6.0 * spatium) + "}";
    }

    return head + "}";
}
