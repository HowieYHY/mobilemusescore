/*
 * SPDX-License-Identifier: GPL-3.0-only
 *
 * muse::io::IFileSystem over the C++ standard library, for builds without Qt.
 * In the browser this is Emscripten's in-memory file system: the app writes
 * fonts, resources and the opened score into it before using them.
 *
 * Qt resource paths (":/fonts/...") resolve as ordinary relative paths, so the
 * app places those files under "/:/..." (the working directory is "/").
 */
#pragma once

#include "global/io/ifilesystem.h"

namespace mss {
class PosixFileSystem : public muse::io::IFileSystem
{
public:
    muse::Ret exists(const muse::io::path_t& path) const override;
    muse::Ret remove(const muse::io::path_t& path, bool onlyIfEmpty = false) override;
    muse::Ret clear(const muse::io::path_t& path) override;
    muse::Ret copy(const muse::io::path_t& src, const muse::io::path_t& dst, bool replace = false) override;
    muse::Ret move(const muse::io::path_t& src, const muse::io::path_t& dst, bool replace = false) override;
    muse::Ret makePath(const muse::io::path_t& path) const override;
    muse::Ret makeLink(const muse::io::path_t& targetPath, const muse::io::path_t& linkPath) const override;
    muse::io::EntryType entryType(const muse::io::path_t& path) const override;
    muse::RetVal<uint64_t> fileSize(const muse::io::path_t& path) const override;
#ifndef MSS_MUSESCORE_4_7
    muse::RetVal<uint64_t> availableSpace(const muse::io::path_t& path) const override;
#endif
    muse::RetVal<muse::io::paths_t> scanFiles(const muse::io::path_t& rootDir, const std::vector<std::string>& filters,
                                              muse::io::ScanMode mode = muse::io::ScanMode::FilesInCurrentDirAndSubdirs) const override;
    void setAttribute(const muse::io::path_t& path, Attribute attribute) const override;
    bool setPermissionsAllowedForAll(const muse::io::path_t& path) const override;
    muse::RetVal<muse::ByteArray> readFile(const muse::io::path_t& filePath) const override;
    muse::Ret readFile(const muse::io::path_t& filePath, muse::ByteArray& data) const override;
    muse::Ret writeFile(const muse::io::path_t& filePath, const muse::ByteArray& data) override;
    muse::RetVal<muse::io::StreamId> openStream(const muse::io::path_t& filePath, muse::io::OpenMode mode) override;
    muse::Ret writeToStream(muse::io::StreamId fileId, const muse::ByteArray& data, uint64_t offset = muse::io::STREAM_POS_CURRENT) override;
    muse::Ret closeStream(muse::io::StreamId fileId) override;
#ifndef MSS_MUSESCORE_4_7
    muse::io::path_t temporaryDirectoryPath() const override;
#endif
    muse::io::path_t canonicalFilePath(const muse::io::path_t& filePath) const override;
    muse::io::path_t absolutePath(const muse::io::path_t& filePath) const override;
    muse::io::path_t absoluteFilePath(const muse::io::path_t& filePath) const override;
    muse::DateTime birthTime(const muse::io::path_t& filePath) const override;
    muse::DateTime lastModified(const muse::io::path_t& filePath) const override;
    muse::Ret isWritable(const muse::io::path_t& filePath) const override;
};
}
