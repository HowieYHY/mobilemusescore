/*
 * SPDX-License-Identifier: GPL-3.0-only
 *
 * The calls the session makes into MuseScore's audio system, independent of
 * the MuseScore version being built:
 *   audiobackend50.cpp - MuseScore 5.0: IPlayback with contexts, separate
 *                        source / control / aux-send parameters
 *   audiobackend47.cpp - MuseScore 4.7: IPlayback with track sequences and
 *                        combined AudioParams { in, out }
 * Both drive MuseScore's own main-thread Playback and Player classes, which
 * talk to the audio engine (msaudio) over MuseScore's RPC channel.
 */
#pragma once

#include <functional>
#include <memory>
#include <string>

#include "global/async/channel.h"
#include "audio/common/audiotypes.h"
#include "mpe/events.h"

#include "audiosettings.h"

namespace mss {
class AudioBackend
{
public:
    static std::unique_ptr<AudioBackend> create();
    virtual ~AudioBackend() = default;

    using TrackId = int32_t;
    using Done = std::function<void (bool ok, const std::string& error)>;

    // Engine handshake (EngineRunning -> LoadSoundFonts -> EngineInit) and the
    // playback session; `done` runs once tracks can be added.
    virtual void start(unsigned sampleRate, unsigned blockSize, const std::string& soundFontUri, Done done) = 0;

    virtual void availableInputResources(std::function<void(const muse::audio::AudioResourceMetaList&)> f) = 0;

    // Resolves with the track id and the source the engine actually applied.
    virtual void addTrack(const std::string& title, const muse::mpe::PlaybackData& data,
                          const muse::audio::AudioInputParams& in, const OutputParams& out,
                          std::function<void(TrackId, const muse::audio::AudioInputParams&)> ok,
                          std::function<void(const std::string&)> fail) = 0;
    virtual void addAuxTrack(const std::string& title, const OutputParams& out,
                             std::function<void(TrackId)> ok, std::function<void(const std::string&)> fail) = 0;
    virtual void removeAllTracks() = 0;

    virtual void setTrackOutput(TrackId id, const OutputParams& out) = 0;
    // Changes the sound a track plays (as choosing a sound in desktop's mixer).
    virtual void setTrackInput(TrackId id, const muse::audio::AudioInputParams& in) = 0;
    virtual void setMasterOutput(const OutputParams& out) = 0;

    // Transport
    virtual void prepareToPlay(std::function<void()> then) = 0;
    virtual void play() = 0;
    virtual void resume() = 0;
    virtual void pause() = 0;
    virtual void stop() = 0;
    virtual void seek(double secs, bool flushSound) = 0;
    virtual void setDuration(double secs) = 0;
    virtual muse::audio::PlaybackStatus status() const = 0;
    virtual double position() const = 0;

    virtual muse::async::Channel<double> positionChanged() const = 0;
    virtual muse::async::Channel<muse::audio::PlaybackStatus> statusChanged() const = 0;
};
}
