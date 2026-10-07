/*
 * SPDX-License-Identifier: GPL-3.0-only
 *
 * Reads the audiosettings.json that MuseScore stores inside an .mscz: each
 * part's chosen sound, its mixer settings and its solo/mute state.
 *
 * Qt-free port of the reading half of mu::project::ProjectAudioSettings
 * (src/project/internal/projectaudiosettings.cpp) and of the
 * mu::project::AudioOutputParams model (src/project/iprojectaudiosettings.h),
 * Copyright (C) MuseScore Limited and others, GPL-3.0-only.
 */
#pragma once

#include <map>
#include <unordered_map>

#include "audio/common/audiotypes.h"
#include "engraving/types/types.h"

namespace mss {
struct OutputParams {
    muse::audio::AudioFxChain fxChain;
    muse::audio::volume_db_t volume = 0.f;
    muse::audio::balance_t balance = 0.f;
    muse::audio::AuxSendsParams auxSends;
    bool solo = false;
    bool muted = false;
    bool forceMute = false;

#ifndef MSS_MUSESCORE_4_7
    muse::audio::ControlParams control() const
    {
        muse::audio::ControlParams c;
        c.volume = volume;
        c.balance = balance;
        c.muted = muted;
        return c;
    }
#endif
};

struct SoloMuteState {
    bool mute = false;
    bool solo = false;
};

class AudioSettings
{
public:
    // Returns false when the file is missing or unreadable (MuseScore then uses defaults).
    bool read(const muse::ByteArray& json);

    const OutputParams& masterOutputParams() const { return m_master; }

    bool containsAuxOutputParams(muse::audio::aux_channel_idx_t index) const { return m_aux.count(index) > 0; }
    const OutputParams& auxOutputParams(muse::audio::aux_channel_idx_t index) const;
    SoloMuteState auxSoloMuteState(muse::audio::aux_channel_idx_t index) const;

    muse::audio::AudioInputParams trackInputParams(const mu::engraving::InstrumentTrackId& id) const;
    bool trackHasExistingOutputParams(const mu::engraving::InstrumentTrackId& id) const { return m_trackOut.count(id) > 0; }
    OutputParams trackOutputParams(const mu::engraving::InstrumentTrackId& id) const;
    bool hasTrackSoloMuteState(const mu::engraving::InstrumentTrackId& id) const { return m_trackSoloMute.count(id) > 0; }
    SoloMuteState trackSoloMuteState(const mu::engraving::InstrumentTrackId& id) const;

    const muse::String& activeSoundProfile() const { return m_activeSoundProfile; }

private:
    OutputParams m_master;
    std::map<muse::audio::aux_channel_idx_t, OutputParams> m_aux;
    std::map<muse::audio::aux_channel_idx_t, SoloMuteState> m_auxSoloMute;
    std::unordered_map<mu::engraving::InstrumentTrackId, muse::audio::AudioInputParams> m_trackIn;
    std::unordered_map<mu::engraving::InstrumentTrackId, OutputParams> m_trackOut;
    std::unordered_map<mu::engraving::InstrumentTrackId, SoloMuteState> m_trackSoloMute;
    muse::String m_activeSoundProfile;
};
}
