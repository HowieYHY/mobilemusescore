/*
 * SPDX-License-Identifier: GPL-3.0-only
 *
 * One open score plus its playback, wired the way MuseScore Studio does it:
 *  - loading follows mu::project::NotationProject::doLoad
 *  - tracks, aux (reverb) sends, solo/mute follow mu::playback::PlaybackController
 *  - the playback cursor follows mu::notation::PlaybackCursor
 * (all MuseScore Studio, GPL-3.0-only). Desktop UI concerns (selection,
 * editing, online sounds, MuseSampler, automation lanes) are left out.
 */
#pragma once

#include <map>
#include <memory>
#include <string>
#include <vector>

#include "global/async/asyncable.h"
#include "global/modularity/ioc.h"
#include "audio/common/audiotypes.h"
#include "engraving/engravingproject.h"
#include "engraving/playback/playbackmodel.h"
#include "engraving/types/types.h"

#include "audiobackend.h"
#include "audiosettings.h"

namespace mss {
class Session : public muse::async::Asyncable
{
public:
    static Session* instance();

    // Registers MuseScore's services. Resources must already be in the file system.
    void init();

    // Starts the conversation with the audio engine (msaudio) at this output spec.
    void startAudio(unsigned sampleRate, unsigned blockSize, const std::string& soundFontUri);

    // Loads an .mscz/.mscx/.mscz from the in-memory file system. Returns JSON.
    std::string load(const std::string& path);

    // "page" (default), "continuous_h" (systems stacked, MuseScore's SYSTEM mode)
    // or "continuous_v" (one long line, MuseScore's LINE mode). Returns score info JSON.
    std::string setViewMode(const std::string& mode);

    // Page drawing commands as JSON (see painter.cpp).
    std::string renderPage(int pageIndex);

    // Transport
    void play();
    void pause();
    void stop();
    void seek(double secs);
    // Moves playback to the note or rest nearest a point on a page (page
    // coordinates). Returns the new cursor JSON, or "null" if nothing is there.
    std::string seekAt(int pageIndex, double x, double y, double radius, bool playNote);

    // Mixer. trackKey identifies an instrument track (see tracksJson()).
    void setTrackVolume(int trackKey, double db);
    void setTrackBalance(int trackKey, double balance);
    void setTrackMute(int trackKey, bool mute);
    void setTrackSolo(int trackKey, bool solo);
    void setMasterVolume(double db);
    double masterVolume() const;
    void setReverbSend(int trackKey, double amount);
    // Plays a track with another MS Basic sound (an id from soundsJson()), as
    // choosing a sound in desktop's mixer.
    void setTrackSound(int trackKey, const std::string& resourceId);

    // The MS Basic sounds, grouped as in desktop's mixer sound menu
    // (InputResourceItem::buildMsBasicMenuItem):
    // {"auto": id, "tree": [{"t": category, "c": [...]} | {"id": id, "n": name}]}
    std::string soundsJson() const;

    // Metronome on/off, as desktop's transport button (off by default, as in
    // NotationConfiguration). The metronome track is muted while it is off.
    void setMetronome(bool on);

    // How far the audio engine runs ahead of what is heard (audio queued for
    // the speaker plus device latency). The cursor and the pause point are
    // shifted back by this much.
    void setOutputLatency(double secs) { m_outputLatency = std::max(0.0, secs); }

    // Practice, as desktop's playback toolbar. Speed: the tempo multiplier
    // (desktop's Speed, 10-300%), keeping the place in the music. Loop: markers
    // at the play position (Set loop marker left / right: the start, or the
    // end, of the note or rest there) and Loop playback on/off; with no
    // markers the whole score loops. Each returns practiceJson(). A new score
    // starts at 100% with no loop.
    // `at`: the play position the reader sees, in seconds (the engine's own
    // position lags a seek)
    std::string setTempoMultiplier(double multiplier, double at);
    std::string setLoopMarker(bool right, double at);
    std::string setLoopEnabled(bool on);
    std::string practiceJson() const;

    std::string tracksJson() const;
    std::string scoreInfoJson() const;

    // Where the playback cursor sits at this position, as JSON.
    std::string cursorJson(double secs) const;

    // The whole played timeline (repeats unrolled) as cursor key points, so the
    // page can animate the cursor from the audio clock without asking:
    // [[secs, page, x, y, h], ...] in page units; x is interpolated between
    // consecutive points on the same system.
    std::string timelineJson() const;

private:
    struct Track {
        int key = 0;
        mu::engraving::InstrumentTrackId id;
        std::string title;
        bool isMetronome = false;
        bool isChordSymbols = false;
        bool hidden = false;
        AudioBackend::TrackId audioTrackId = -1;
        bool added = false;
        muse::audio::AudioInputParams source;
        OutputParams out;
        SoloMuteState soloMute;
        std::string soundName;
        std::string scoreSoundId; // the sound the score asked for, as first applied
        std::string substitutionNote; // set when the score asked for a sound we do not have
    };

    void emit(const std::string& type, const std::string& json) const;

    void onAudioReady();
    void setupPlayback();
    void addTrack(Track& t);
    void addAuxTrack(muse::audio::aux_channel_idx_t index);
    void updateSoloMuteStates();
    void sendControl(const Track& t);
    muse::audio::AudioInputParams resolveSource(Track& t, const muse::mpe::PlaybackData& data);
    void removeAllTracks();
    void maybeReady();

    Track* findTrack(int key);

    double totalPlayTime() const;
    int secToTick(double secs) const;

    muse::modularity::ContextPtr m_ctx;
    std::unique_ptr<AudioBackend> m_audio;
    bool m_audioReady = false;
    std::map<muse::mpe::PlaybackSetupData, muse::audio::AudioResourceMeta> m_basicProfile;
    std::map<std::string, muse::audio::AudioResourceMeta> m_fluidResources; // MS Basic, by id

    std::shared_ptr<mu::engraving::EngravingProject> m_project;
    std::unique_ptr<mu::engraving::PlaybackModel> m_playbackModel;
    AudioSettings m_audioSettings;
    bool m_hasAudioSettings = false;

    std::vector<Track> m_tracks;
    std::map<muse::audio::aux_channel_idx_t, AudioBackend::TrackId> m_auxTracks;
    std::map<muse::audio::aux_channel_idx_t, OutputParams> m_auxOut;
    OutputParams m_master;
    int m_pendingTracks = 0;
    uint64_t m_loadKey = 0;
    bool m_playbackSetUp = false;
    double m_totalPlayTime = 0;
    bool m_metronome = false;
    double m_outputLatency = 0.0;
    // loop markers in played (unrolled) ticks, -1 while not set
    bool m_loopOn = false;
    int m_loopIn = -1;
    int m_loopOut = -1;
    void applyLoop();
};
}
