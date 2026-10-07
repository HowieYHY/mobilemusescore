/*
 * SPDX-License-Identifier: GPL-3.0-only
 *
 * Audio engine entry point for the AudioWorklet.
 *
 * Adapted from MuseScore's src/web/audioengine (engine_export.cpp and
 * webaudioengine.cpp, Copyright (C) 2021 MuseScore Limited and others,
 * GPL-3.0-only). Changes: with MuseScore 5.0 sources, uses EngineGlobalSetup
 * to register the engine services (upstream's web copy predates it); clears
 * the whole output buffer; exported to JS through plain C functions.
 *
 * With MuseScore 4.7 sources (MSS_MUSESCORE_4_7) it is upstream's 4.7
 * WebAudioEngine::init, using upstream's WebRpcChannel.
 */

#include <cstring>
#include <memory>

#include "global/modularity/ioc.h"
#include "global/runtime.h"
#include "global/async/processevents.h"

#ifdef MSS_MUSESCORE_4_7
#include "audio/common/rpc/platform/web/webrpcchannel.h"
#else
#include "jsrpcchannel.h"
#include "audio/engine/enginesetup.h"
#endif
#include "audio/engine/internal/enginecontroller.h"

#include "log.h"

using namespace muse;
using namespace muse::audio;
using namespace muse::audio::engine;
using namespace muse::audio::rpc;

namespace {
struct Engine {
#ifdef MSS_MUSESCORE_4_7
    std::shared_ptr<WebRpcChannel> channel;
#else
    std::shared_ptr<EngineGlobalSetup> setup;
    std::shared_ptr<mss::JsRpcChannel> channel;
#endif
    std::shared_ptr<EngineController> controller;
};

Engine* g_engine = nullptr;
}

int main()
{
    return 0;
}

extern "C" {
void msaudio_init()
{
    if (g_engine) {
        return;
    }

    muse::runtime::mainThreadId(); //! NOTE Needs only call
    muse::runtime::setThreadName("audio_engine");

    muse::logger::Logger* logger = muse::logger::Logger::instance();
    logger->clearDests();
    logger->addDest(new muse::logger::ConsoleLogDest(muse::logger::LogLayout("${type|5} | ${tag|15} | ${message}")));
    logger->setLevel(muse::logger::Level::Normal);

    g_engine = new Engine();
    set_last_stream_id(100000);

#ifdef MSS_MUSESCORE_4_7
    // as in upstream 4.7 src/web/audioengine/webaudioengine.cpp
    g_engine->channel = std::make_shared<WebRpcChannel>();
    g_engine->channel->setupOnEngine();
    modularity::globalIoc()->registerExport<IRpcChannel>("audio_engine", g_engine->channel);

    g_engine->controller = std::make_shared<EngineController>(g_engine->channel, nullptr);
    g_engine->controller->registerExports();
    g_engine->controller->onStartRunning();
#else
    g_engine->setup = std::make_shared<EngineGlobalSetup>();
    g_engine->setup->registerExports();
    g_engine->setup->resolveImports();

    g_engine->channel = std::shared_ptr<mss::JsRpcChannel>(mss::JsRpcChannel::instance(), [](mss::JsRpcChannel*) {});
    modularity::globalIoc()->registerExport<IRpcChannel>("audio_engine", g_engine->channel);

    g_engine->controller = std::make_shared<EngineController>(g_engine->channel);
    g_engine->controller->onStartRunning();
#endif

    LOGI() << "audio engine running";
}

// Fills `ptr` with `samplesPerChannel` interleaved stereo float frames.
void msaudio_process(uintptr_t ptr, unsigned samplesPerChannel)
{
    float* stream = reinterpret_cast<float*>(ptr);
    std::memset(stream, 0, samplesPerChannel * 2 * sizeof(float));
    if (!g_engine) {
        return;
    }
    muse::async::processMessages();
    g_engine->controller->process(stream, samplesPerChannel);
}
}
