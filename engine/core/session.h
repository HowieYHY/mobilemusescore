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
    std::string seekAt(int pageIndex, double x, double y);

    // Mixer. trackKey identifies an instrument track (see tracksJson()).
    void setTrackVolume(int trackKey, double db);
    void setTrackBalance(int trackKey, double balance);
    void setTrackMute(int trackKey, bool mute);
    void setTrackSolo(int trackKey, bool solo);
    void setMasterVolume(double db);
    void setReverbSend(int trackKey, double amount);

    // Metronome on/off, as desktop's transport button (off by default, as in
    // NotationConfiguration). The metronome track is muted while it is off.
    void setMetronome(bool on);

    std::string tracksJson() const;
    std::string scoreInfoJson() const;

    // Where the playback cursor sits at this position, as JSON.
    std::string cursorJson(double secs) const;

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
};
}
