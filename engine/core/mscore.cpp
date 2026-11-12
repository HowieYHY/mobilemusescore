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

EMSCRIPTEN_KEEPALIVE const char* mss_edit_add_note(int measure, int offNum, int offDen, int staff, int midi, int durNum, int durDen)
{
    return ret(Session::instance()->editAddNote(measure, offNum, offDen, staff, midi, durNum, durDen));
}

EMSCRIPTEN_KEEPALIVE const char* mss_edit_select(int page, double x, double y, double radius) { return ret(Session::instance()->editSelect(page, x, y, radius)); }
EMSCRIPTEN_KEEPALIVE const char* mss_edit_selection() { return ret(Session::instance()->editSelectionJson()); }
EMSCRIPTEN_KEEPALIVE const char* mss_edit_clear_selection() { return ret(Session::instance()->editClearSelection()); }
EMSCRIPTEN_KEEPALIVE const char* mss_edit_move(const char* cmd) { return ret(Session::instance()->editMove(cmd)); }
EMSCRIPTEN_KEEPALIVE const char* mss_edit_pitch(int mode) { return ret(Session::instance()->editPitch(mode)); }
EMSCRIPTEN_KEEPALIVE const char* mss_edit_duration(int den) { return ret(Session::instance()->editDuration(den)); }
EMSCRIPTEN_KEEPALIVE const char* mss_edit_dot() { return ret(Session::instance()->editDot()); }
EMSCRIPTEN_KEEPALIVE const char* mss_edit_enter_note(int letter, int den, int dots) { return ret(Session::instance()->editEnterNote(letter, den, dots)); }
EMSCRIPTEN_KEEPALIVE const char* mss_edit_enter_rest(int den, int dots) { return ret(Session::instance()->editEnterRest(den, dots)); }
EMSCRIPTEN_KEEPALIVE const char* mss_edit_extend(int page, double x, double y, double radius) { return ret(Session::instance()->editExtend(page, x, y, radius)); }
EMSCRIPTEN_KEEPALIVE const char* mss_edit_copy(int cut) { return ret(Session::instance()->editCopy(cut != 0)); }
EMSCRIPTEN_KEEPALIVE const char* mss_edit_paste() { return ret(Session::instance()->editPaste()); }
EMSCRIPTEN_KEEPALIVE int mss_edit_has_clip() { return Session::instance()->editHasClip() ? 1 : 0; }
EMSCRIPTEN_KEEPALIVE const char* mss_edit_voice(int v, int input) { return ret(Session::instance()->editVoice(v, input != 0)); }
EMSCRIPTEN_KEEPALIVE const char* mss_edit_insert_bars(int n) { return ret(Session::instance()->editInsertBars(n)); }
EMSCRIPTEN_KEEPALIVE const char* mss_edit_delete_bars() { return ret(Session::instance()->editDeleteBars()); }
EMSCRIPTEN_KEEPALIVE const char* mss_edit_mark(int k) { return ret(Session::instance()->editMark(k)); }
EMSCRIPTEN_KEEPALIVE const char* mss_edit_slur() { return ret(Session::instance()->editSlur()); }
EMSCRIPTEN_KEEPALIVE const char* mss_edit_hairpin(int k) { return ret(Session::instance()->editHairpin(k)); }
EMSCRIPTEN_KEEPALIVE const char* mss_edit_insert_notes(const char* spec) { return ret(Session::instance()->editInsertNotes(spec)); }
EMSCRIPTEN_KEEPALIVE const char* mss_edit_select_start() { return ret(Session::instance()->editSelectStart()); }
EMSCRIPTEN_KEEPALIVE const char* mss_edit_add_bars(int n) { return ret(Session::instance()->editAddBars(n)); }
EMSCRIPTEN_KEEPALIVE const char* mss_edit_set_key(int k) { return ret(Session::instance()->editSetKey(k)); }
EMSCRIPTEN_KEEPALIVE const char* mss_edit_set_time(int n, int d) { return ret(Session::instance()->editSetTime(n, d)); }
EMSCRIPTEN_KEEPALIVE const char* mss_edit_tie() { return ret(Session::instance()->editTie()); }
EMSCRIPTEN_KEEPALIVE const char* mss_edit_accidental(int k) { return ret(Session::instance()->editAccidental(k)); }
EMSCRIPTEN_KEEPALIVE const char* mss_edit_triplet() { return ret(Session::instance()->editTriplet()); }
EMSCRIPTEN_KEEPALIVE const char* mss_edit_add_to_chord(int l) { return ret(Session::instance()->editAddToChord(l)); }
EMSCRIPTEN_KEEPALIVE const char* mss_edit_staff_text(const char* t) { return ret(Session::instance()->editStaffText(t)); }
EMSCRIPTEN_KEEPALIVE const char* mss_edit_dynamic(int w) { return ret(Session::instance()->editDynamic(w)); }
EMSCRIPTEN_KEEPALIVE const char* mss_edit_lyric(const char* t) { return ret(Session::instance()->editLyric(t)); }
EMSCRIPTEN_KEEPALIVE const char* mss_edit_add_line(const char* n, int c) { return ret(Session::instance()->editAddLine(n, c)); }
EMSCRIPTEN_KEEPALIVE const char* mss_edit_rename_line(const char* n) { return ret(Session::instance()->editRenameLine(n)); }
EMSCRIPTEN_KEEPALIVE const char* mss_edit_delete() { return ret(Session::instance()->editDelete()); }
EMSCRIPTEN_KEEPALIVE const char* mss_edit_undo() { return ret(Session::instance()->editUndoRedo(true)); }
EMSCRIPTEN_KEEPALIVE const char* mss_edit_redo() { return ret(Session::instance()->editUndoRedo(false)); }
EMSCRIPTEN_KEEPALIVE const char* mss_save(const char* path) { return ret(Session::instance()->saveTo(path)); }

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

EMSCRIPTEN_KEEPALIVE const char* mss_staves()
{
    return ret(Session::instance()->stavesJson());
}

EMSCRIPTEN_KEEPALIVE const char* mss_anchors()
{
    return ret(Session::instance()->anchorsJson());
}

EMSCRIPTEN_KEEPALIVE const char* mss_cursor(double secs)
{
    return ret(Session::instance()->cursorJson(secs));
}

EMSCRIPTEN_KEEPALIVE void mss_play() { Session::instance()->play(); }
EMSCRIPTEN_KEEPALIVE void mss_pause() { Session::instance()->pause(); }
EMSCRIPTEN_KEEPALIVE void mss_stop() { Session::instance()->stop(); }
EMSCRIPTEN_KEEPALIVE void mss_seek(double secs) { Session::instance()->seek(secs); }

EMSCRIPTEN_KEEPALIVE const char* mss_seek_at(int page, double x, double y, double radius, int playNote)
{
    return ret(Session::instance()->seekAt(page, x, y, radius, playNote != 0));
}


EMSCRIPTEN_KEEPALIVE void mss_set_track_volume(int key, double db) { Session::instance()->setTrackVolume(key, db); }
EMSCRIPTEN_KEEPALIVE void mss_set_track_balance(int key, double b) { Session::instance()->setTrackBalance(key, b); }
EMSCRIPTEN_KEEPALIVE void mss_set_track_mute(int key, int mute) { Session::instance()->setTrackMute(key, mute != 0); }
EMSCRIPTEN_KEEPALIVE void mss_set_track_solo(int key, int solo) { Session::instance()->setTrackSolo(key, solo != 0); }
EMSCRIPTEN_KEEPALIVE void mss_set_track_reverb(int key, double amount) { Session::instance()->setReverbSend(key, amount); }
EMSCRIPTEN_KEEPALIVE void mss_set_track_sound(int key, const char* id) { Session::instance()->setTrackSound(key, id); }
EMSCRIPTEN_KEEPALIVE const char* mss_sounds() { return ret(Session::instance()->soundsJson()); }
EMSCRIPTEN_KEEPALIVE double mss_master_volume() { return Session::instance()->masterVolume(); }
EMSCRIPTEN_KEEPALIVE void mss_set_master_volume(double db) { Session::instance()->setMasterVolume(db); }
EMSCRIPTEN_KEEPALIVE void mss_set_metronome(int on) { Session::instance()->setMetronome(on != 0); }
EMSCRIPTEN_KEEPALIVE void mss_set_output_latency(double secs) { Session::instance()->setOutputLatency(secs); }
EMSCRIPTEN_KEEPALIVE const char* mss_set_speed(double multiplier, double at) { return ret(Session::instance()->setTempoMultiplier(multiplier, at)); }
EMSCRIPTEN_KEEPALIVE const char* mss_set_loop_marker(int right, double at) { return ret(Session::instance()->setLoopMarker(right != 0, at)); }
EMSCRIPTEN_KEEPALIVE const char* mss_set_loop(int on) { return ret(Session::instance()->setLoopEnabled(on != 0)); }
EMSCRIPTEN_KEEPALIVE const char* mss_clear_loop() { return ret(Session::instance()->clearLoop()); }
EMSCRIPTEN_KEEPALIVE const char* mss_locate(int page, double x, double y, double radius) { return ret(Session::instance()->locateJson(page, x, y, radius)); }
EMSCRIPTEN_KEEPALIVE const char* mss_tempos() { return ret(Session::instance()->temposJson()); }
EMSCRIPTEN_KEEPALIVE const char* mss_bars() { return ret(Session::instance()->barsJson()); }
EMSCRIPTEN_KEEPALIVE const char* mss_practice() { return ret(Session::instance()->practiceJson()); }
}
