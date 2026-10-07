/*
 * SPDX-License-Identifier: GPL-3.0-only
 *
 * AudioBackend for MuseScore 4.7 sources (see audiobackend.h). Start-up follows
 * 4.7's muse::audio::StartAudioController::init/startAudioProcessing (web
 * path), and the session's tracks live in one track sequence, as
 * PlaybackController::setupPlayback does in 4.7.
 */
#include "audiobackend.h"

#include "global/modularity/ioc.h"
#include "audio/common/rpc/rpcpacker.h"
#include "audio/common/soundfonttypes.h"
#include "audio/common/rpc/platform/web/webrpcchannel.h"
#include "audio/main/istartaudiocontroller.h"
#include "audio/main/internal/playback.h"

#include "log.h"

using namespace muse;
using namespace muse::audio;
using namespace muse::audio::rpc;
using namespace mss;

namespace {
class StartAudio : public IStartAudioController, public async::Asyncable
{
public:
    explicit StartAudio(std::shared_ptr<IRpcChannel> ch)
        : m_ch(ch) {}

    void begin(const OutputSpec& spec, const AudioEngineConfig& conf, const std::string& soundFontUri, std::function<void(bool)> done)
    {
        m_ch->onMethod(Method::EngineRunning, [this, spec, conf, soundFontUri, done](const Msg&) {
            // as GeneralSoundFontController::loadSoundFonts: 4.7's engine does not
            // answer LoadSoundFonts, so EngineInit follows straight away
            std::vector<synth::SoundFontUri> uris = { synth::SoundFontUri(soundFontUri) };
            m_ch->send(make_request(Method::LoadSoundFonts, RpcPacker::pack(uris)));
            m_ch->send(make_request(Method::EngineInit, RpcPacker::pack(spec, conf)), [this, done](const Msg&) {
                m_started = true;
                m_startedChanged.send(true);
                done(true);
            });
        });
    }

    void startAudioProcessing(const IApplication::RunMode&) override {}
    void stopAudioProcessing() override {}
    bool isAudioStarted() const override { return m_started; }
    async::Channel<bool> isAudioStartedChanged() const override { return m_startedChanged; }

private:
    std::shared_ptr<IRpcChannel> m_ch;
    bool m_started = false;
    async::Channel<bool> m_startedChanged;
};

AudioOutputParams toAudio(const OutputParams& o)
{
    AudioOutputParams p;
    p.fxChain = o.fxChain;
    p.volume = o.volume;
    p.balance = o.balance;
    p.auxSends = o.auxSends;
    p.solo = o.solo;
    p.muted = o.muted;
    p.forceMute = o.forceMute;
    return p;
}

class AudioBackend47 : public AudioBackend, public async::Asyncable
{
public:
    void start(unsigned sampleRate, unsigned blockSize, const std::string& soundFontUri, Done done) override
    {
        auto ioc = modularity::globalIoc();
        auto channel = std::make_shared<WebRpcChannel>();
        channel->setupOnMain();
        ioc->registerExport<IRpcChannel>("mss", channel);
        m_startAudio = std::make_shared<StartAudio>(channel);
        ioc->registerExport<IStartAudioController>("mss", m_startAudio);

        OutputSpec spec;
        spec.sampleRate = sampleRate;
        spec.samplesPerChannel = blockSize;
        spec.audioChannelCount = 2;

        AudioEngineConfig conf; // AudioConfiguration defaults
        conf.useSoundFontLowPassFilter = true;

        auto playback = std::make_shared<Playback>(nullptr);
        playback->init();
        m_playback = playback;

        m_startAudio->begin(spec, conf, soundFontUri, [this, done](bool ok) {
            if (!ok) {
                done(false, "The audio engine did not start.");
                return;
            }
            m_playback->addSequence().onResolve(this, [this, done](const TrackSequenceId seqId) {
                m_seq = seqId;
                m_player = m_playback->player(seqId);
                m_player->playbackPositionChanged().onReceive(this, [this](const secs_t pos) {
                    m_position.send(pos.raw());
                });
                m_player->playbackStatusChanged().onReceive(this, [this](PlaybackStatus st) {
                    m_status.send(st);
                });
                done(true, "");
            });
        });
    }

    void availableInputResources(std::function<void(const AudioResourceMetaList&)> f) override
    {
        m_playback->availableInputResources().onResolve(this, [f](const AudioResourceMetaList& list) { f(list); });
    }

    void addTrack(const std::string& title, const mpe::PlaybackData& data, const AudioInputParams& in, const OutputParams& out,
                  std::function<void(TrackId, const AudioInputParams&)> ok, std::function<void(const std::string&)> fail) override
    {
        m_playback->addTrack(m_seq, title, data, AudioParams { in, toAudio(out) })
        .onResolve(this, [ok](const audio::TrackId id, const AudioParams& applied) { ok(id, applied.in); })
        .onReject(this, [fail](int code, const std::string& msg) { fail(std::to_string(code) + " " + msg); });
    }

    void addAuxTrack(const std::string& title, const OutputParams& out, std::function<void(TrackId)> ok,
                     std::function<void(const std::string&)> fail) override
    {
        m_playback->addAuxTrack(m_seq, title, toAudio(out))
        .onResolve(this, [ok](const audio::TrackId id, const AudioOutputParams&) { ok(id); })
        .onReject(this, [fail](int code, const std::string& msg) { fail(std::to_string(code) + " " + msg); });
    }

    void removeAllTracks() override
    {
        if (m_playback && m_seq >= 0) {
            m_playback->removeAllTracks(m_seq);
        }
    }

    void setTrackOutput(TrackId id, const OutputParams& out) override
    {
        m_playback->setOutputParams(m_seq, id, toAudio(out));
    }

    void setTrackInput(TrackId id, const AudioInputParams& in) override
    {
        m_playback->setInputParams(m_seq, id, in);
    }

    void setMasterOutput(const OutputParams& out) override
    {
        m_playback->setMasterOutputParams(toAudio(out));
    }

    void prepareToPlay(std::function<void()> then) override
    {
        m_player->prepareToPlay().onResolve(this, [then](const Ret&) { then(); });
    }

    void play() override { m_player->play(0); }
    void resume() override { m_player->resume(0); }
    void pause() override { m_player->pause(); }
    void stop() override { m_player->stop(); }
    void seek(double secs, bool flush) override { m_player->seek(secs, flush); }
    void setDuration(double secs) override { m_player->setDuration(static_cast<msecs_t>(secs * 1000.0)); }
    PlaybackStatus status() const override { return m_player ? m_player->playbackStatus() : PlaybackStatus::Stopped; }
    double position() const override { return m_player ? double(m_player->playbackPosition()) : 0.0; }
    async::Channel<double> positionChanged() const override { return m_position; }
    async::Channel<PlaybackStatus> statusChanged() const override { return m_status; }

private:
    std::shared_ptr<StartAudio> m_startAudio;
    std::shared_ptr<IPlayback> m_playback;
    std::shared_ptr<IPlayer> m_player;
    TrackSequenceId m_seq = -1;
    async::Channel<double> m_position;
    async::Channel<PlaybackStatus> m_status;
};
}

std::unique_ptr<AudioBackend> AudioBackend::create()
{
    return std::make_unique<AudioBackend47>();
}
