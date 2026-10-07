/*
 * SPDX-License-Identifier: GPL-3.0-only
 *
 * Qt-free port of muse::mpe::ArticulationProfilesRepository
 * (muse_framework/framework/mpe/internal/articulationprofilesrepository.cpp,
 * Copyright (C) MuseScore Limited and others, GPL-3.0-only).
 *
 * Loads the same profile JSON files (general_*_articulations_profile.json)
 * with muse::JsonDocument instead of QJsonDocument. Saving is not needed by a
 * player and is not implemented.
 */
#pragma once

#include <unordered_map>

#include "mpe/iarticulationprofilesrepository.h"

namespace mss {
class ArticulationProfiles : public muse::mpe::IArticulationProfilesRepository
{
public:
    // Directory holding the general_*_articulations_profile.json files.
    explicit ArticulationProfiles(const std::string& resourceDir);

    muse::mpe::ArticulationsProfilePtr createNew() const override;
    muse::mpe::ArticulationsProfilePtr defaultProfile(const muse::mpe::ArticulationFamily family) const override;
    muse::mpe::ArticulationsProfilePtr loadProfile(const muse::io::path_t& path) const override;
    void saveProfile(const muse::io::path_t& path, const muse::mpe::ArticulationsProfilePtr profilePtr) override;
    muse::async::Channel<muse::io::path_t> profileChanged() const override;

private:
    std::string m_dir;
    mutable std::unordered_map<muse::mpe::ArticulationFamily, muse::mpe::ArticulationsProfilePtr> m_defaultProfiles;
    muse::async::Channel<muse::io::path_t> m_profileChanged;
};
}
