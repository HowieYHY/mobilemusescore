/*
 * SPDX-License-Identifier: GPL-3.0-only
 *
 * C entry points for JavaScript. Strings returned by mss_* functions are
 * owned by the module and stay valid until the next call that returns one.
 */
#include <emscripten.h>

#include <string>

#include "global/async/processevents.h"
#include "global/runtime.h"
#include "global/log.h"

#include "session.h"

using namespace mss;

static std::string s_result;

static const char* ret(std::string s)
{
    s_result = std::move(s);
    return s_result.c_str();
}

int main()
{
    return 0;
}

extern "C" {
EMSCRIPTEN_KEEPALIVE void mss_init(int verbose)
{
    muse::runtime::mainThreadId();
    muse::runtime::setThreadName("main");

    muse::logger::Logger* logger = muse::logger::Logger::instance();
    logger->clearDests();
    logger->addDest(new muse::logger::ConsoleLogDest(muse::logger::LogLayout("${type|5} | ${tag|15} | ${message}")));
    logger->setLevel(verbose ? muse::logger::Level::Debug : muse::logger::Level::Normal);

    Session::instance()->init();
}

// Runs MuseScore's queued async callbacks (promises, channels). Call after
// delivering RPC messages and periodically (e.g. each animation frame).
EMSCRIPTEN_KEEPALIVE void mss_process()
{
    muse::async::processMessages();
}

EMSCRIPTEN_KEEPALIVE void mss_start_audio(int sampleRate, int blockSize, const char* soundFontUri)
{
    Session::instance()->startAudio(static_cast<unsigned>(sampleRate), static_cast<unsigned>(blockSize), soundFontUri);
}

EMSCRIPTEN_KEEPALIVE const char* mss_load(const char* path)
{
    return ret(Session::instance()->load(path));
}

EMSCRIPTEN_KEEPALIVE const char* mss_score_info()
{
    return ret(Session::instance()->scoreInfoJson());
}

EMSCRIPTEN_KEEPALIVE const char* mss_set_view_mode(const char* mode)
{
    return ret(Session::instance()->setViewMode(mode));
}

EMSCRIPTEN_KEEPALIVE const char* mss_render_page(int page)
{
    return ret(Session::instance()->renderPage(page));
}

EMSCRIPTEN_KEEPALIVE const char* mss_tracks()
{
    return ret(Session::instance()->tracksJson());
}

EMSCRIPTEN_KEEPALIVE const char* mss_timeline()
{
    return ret(Session::instance()->timelineJson());
}

EMSCRIPTEN_KEEPALIVE const char* mss_cursor(double secs)
{
    return ret(Session::instance()->cursorJson(secs));
}

EMSCRIPTEN_KEEPALIVE void mss_play() { Session::instance()->play(); }
EMSCRIPTEN_KEEPALIVE void mss_pause() { Session::instance()->pause(); }
EMSCRIPTEN_KEEPALIVE void mss_stop() { Session::instance()->stop(); }
EMSCRIPTEN_KEEPALIVE void mss_seek(double secs) { Session::instance()->seek(secs); }

EMSCRIPTEN_KEEPALIVE const char* mss_seek_at(int page, double x, double y)
{
    return ret(Session::instance()->seekAt(page, x, y));
}


EMSCRIPTEN_KEEPALIVE void mss_set_track_volume(int key, double db) { Session::instance()->setTrackVolume(key, db); }
EMSCRIPTEN_KEEPALIVE void mss_set_track_balance(int key, double b) { Session::instance()->setTrackBalance(key, b); }
EMSCRIPTEN_KEEPALIVE void mss_set_track_mute(int key, int mute) { Session::instance()->setTrackMute(key, mute != 0); }
EMSCRIPTEN_KEEPALIVE void mss_set_track_solo(int key, int solo) { Session::instance()->setTrackSolo(key, solo != 0); }
EMSCRIPTEN_KEEPALIVE void mss_set_track_reverb(int key, double amount) { Session::instance()->setReverbSend(key, amount); }
EMSCRIPTEN_KEEPALIVE void mss_set_master_volume(double db) { Session::instance()->setMasterVolume(db); }
EMSCRIPTEN_KEEPALIVE void mss_set_metronome(int on) { Session::instance()->setMetronome(on != 0); }
EMSCRIPTEN_KEEPALIVE void mss_set_output_latency(double secs) { Session::instance()->setOutputLatency(secs); }
}
