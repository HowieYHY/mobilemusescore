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
#include "engraving/dom/chord.h"
#include "engraving/dom/drumset.h"
#include "engraving/dom/figuredbass.h"
#include "engraving/dom/instrument.h"
#include "engraving/dom/masterscore.h"
#include "engraving/dom/measure.h"
#include "engraving/dom/mscore.h"
#include "engraving/dom/note.h"
#include "playback/qml/MuseScore/Playback/msbasicpresetscategories.h"
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

    m_master = m_hasAudioSettings ? m_audioSettings.masterOutputParams() : OutputParams();
    updateSoloMuteStates(); // nothing is sent yet: no track is added

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
std::string Session::seekAt(int pageIndex, double x, double y, double radius, bool playNote)
{
    const Score* score = m_project ? m_project->masterScore() : nullptr;
    if (!score || pageIndex < 0 || pageIndex >= int(score->pages().size())) {
        return "null";
    }
    Page* page = score->pages()[pageIndex];
    const PointF p = PointF(x, y) + page->pos();

    // The note nearest the tap, within `radius` (a fingertip is bigger than a notehead)
    const Note* note = nullptr;
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
            return "null";
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
    const double secs = uticksToSecs(score, utick);

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
    };
    std::vector<Point> points;

    auto point = [&](int utick, const System* system, double canvasX, bool barEnd = false) {
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
        const double y = system->staffCanvasYpage(0) - 3.0 * spatium;
        const double h = bottomY + 6.0 * spatium;
        points.push_back({ std::round(uticksToSecs(score, utick) * 10000.0) / 10000.0, pageIdx,
                           std::round(x), std::round(y), std::round(h), barEnd });
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
                    point(s->tick().ticks() + offset, system, s->canvasPos().x());
                }
            }
            const Segment* endBar = m->findSegment(SegmentType::EndBarLine, m->endTick());
            point(m->endTick().ticks() + offset, system, endBar ? endBar->canvasPos().x() : m->canvasPos().x() + m->width(), true);
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
        out += "[" + num(p.secs) + "," + std::to_string(p.page) + "," + num(p.x) + "," + num(p.y) + "," + num(p.h) + "]";
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
