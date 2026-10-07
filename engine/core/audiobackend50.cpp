/*
 * SPDX-License-Identifier: GPL-3.0-only
 *
 * AudioBackend for MuseScore 5.0 sources (see audiobackend.h). Start-up follows
 * muse::audio::StartAudioController::init/startAudioProcessing (web path).
 */
#include "audiobackend.h"

#include "global/modularity/ioc.h"
#include "audio/common/rpc/rpcpacker.h"
#include "audio/common/soundfonttypes.h"
#include "audio/main/istartaudiocontroller.h"
#include "audio/main/internal/playback.h"

#include "jsrpcchannel.h"

#include "log.h"

using namespace muse;
using namespace muse::audio;
using namespace muse::audio::rpc;
using namespace mss;

namespace {
class StartAudio : public IStartAudioController, public async::Asyncable
{
public:
    void begin(const OutputSpec& spec, const AudioEngineConfig& conf, const std::string& soundFontUri, std::function<void(bool)> done)
    {
        auto ch = JsRpcChannel::instance();
        ch->onNotification(GLOBAL_CTX_ID, MsgCode::EngineRunning, [this, ch, spec, conf, soundFontUri, done](const Msg&) {
            std::vector<synth::SoundFontUri> uris = { synth::SoundFontUri(soundFontUri) };
            ch->send(make_request(GLOBAL_CTX_ID, MsgCode::LoadSoundFonts, RpcPacker::pack(uris)), [this, ch, spec, conf, done](const Msg&) {
                ch->send(make_request(GLOBAL_CTX_ID, MsgCode::EngineInit, RpcPacker::pack(spec, conf)), [this, done](const Msg& res) {
                    Ret ret;
                    RpcPacker::unpack(res.data, ret);
                    m_started = true;
                    m_startedChanged.send(true);
                    done(ret.success());
                });
            });
        });
    }

    void startAudioProcessing(const IApplication::RunMode&) override {}
    void stopAudioProcessing() override {}
    bool isAudioStarted() const override { return m_started; }
    async::Channel<bool> isAudioStartedChanged() const override { return m_startedChanged; }

private:
    bool m_started = false;
    async::Channel<bool> m_startedChanged;
};

class AudioBackend50 : public AudioBackend, public async::Asyncable
{
public:
    void start(unsigned sampleRate, unsigned blockSize, const std::string& soundFontUri, Done done) override
    {
        auto ioc = modularity::globalIoc();
        std::shared_ptr<JsRpcChannel> channel(JsRpcChannel::instance(), [](JsRpcChannel*) {});
        ioc->registerExport<IRpcChannel>("mss", channel);
        m_startAudio = std::make_shared<StartAudio>();
        ioc->registerExport<IStartAudioController>("mss", m_startAudio);

        OutputSpec spec;
        spec.sampleRate = sampleRate;
        spec.samplesPerChannel = blockSize;
        spec.audioChannelCount = 2;

        AudioEngineConfig conf; // AudioConfiguration defaults
        conf.useSoundFontLowPassFilter = true;

        m_startAudio->begin(spec, conf, soundFontUri, [this, done](bool ok) {
            if (!ok) {
                done(false, "The audio engine did not start.");
                return;
            }
            auto ctx = std::make_shared<modularity::Context>(1);
            auto playback = std::make_shared<Playback>(ctx);
            m_playback = playback;
            playback->init().onResolve(this, [this, done](const Ret& ret) {
                if (!ret) {
                    done(false, "Audio context failed: " + ret.toString());
                    return;
                }
                m_player = m_playback->player();
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
        TrackParams params;
        params.source = in;
        params.fxChain = out.fxChain;
        params.auxSends = out.auxSends;
        params.control = out.control();
        m_playback->addTrack(title, data, params)
        .onResolve(this, [ok](const audio::TrackId id, const TrackParams& applied) { ok(id, applied.source); })
        .onReject(this, [fail](int code, const std::string& msg) { fail(std::to_string(code) + " " + msg); });
    }

    void addAuxTrack(const std::string& title, const OutputParams& out, std::function<void(TrackId)> ok,
                     std::function<void(const std::string&)> fail) override
    {
        TrackParams params;
        params.fxChain = out.fxChain;
        params.auxSends = out.auxSends;
        params.control = out.control();
        m_playback->addAuxTrack(title, params)
        .onResolve(this, [ok](const audio::TrackId id, const TrackParams&) { ok(id); })
        .onReject(this, [fail](int code, const std::string& msg) { fail(std::to_string(code) + " " + msg); });
    }

    void removeAllTracks() override
    {
        if (m_playback) {
            m_playback->removeAllTracks();
        }
    }

    void setTrackOutput(TrackId id, const OutputParams& out) override
    {
        m_playback->setControlParams(id, out.control());
        m_playback->setAuxSendsParams(id, out.auxSends);
    }

    void setTrackInput(TrackId id, const AudioInputParams& in) override
    {
        m_playback->setSourceParams(id, in);
    }

    void setMasterOutput(const OutputParams& out) override
    {
        m_playback->setMasterFxChainParams(out.fxChain);
        m_playback->setMasterAuxSendsParams(out.auxSends);
        m_playback->setMasterControlParams(out.control());
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
    void setDuration(double secs) override { m_player->setDuration(secs); }
    PlaybackStatus status() const override { return m_player ? m_player->playbackStatus() : PlaybackStatus::Stopped; }
    double position() const override { return m_player ? m_player->playbackPosition().raw() : 0.0; }
    async::Channel<double> positionChanged() const override { return m_position; }
    async::Channel<PlaybackStatus> statusChanged() const override { return m_status; }

private:
    std::shared_ptr<StartAudio> m_startAudio;
    std::shared_ptr<IPlayback> m_playback;
    std::shared_ptr<IPlayer> m_player;
    async::Channel<double> m_position;
    async::Channel<PlaybackStatus> m_status;
};
}

std::unique_ptr<AudioBackend> AudioBackend::create()
{
    return std::make_unique<AudioBackend50>();
}
