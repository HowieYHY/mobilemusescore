/*
 * SPDX-License-Identifier: GPL-3.0-only
 */
#include "posixfilesystem.h"

#include <cstdio>
#include <filesystem>
#include <fstream>
#include <map>

#include "global/io/ioretcodes.h"

using namespace muse;
using namespace muse::io;
using namespace mss;

namespace fs = std::filesystem;

static fs::path P(const path_t& p)
{
    return fs::path(p.toStdString());
}

static Ret ok(bool b)
{
    return b ? make_ok() : make_ret(Ret::Code::UnknownError);
}

Ret PosixFileSystem::exists(const path_t& path) const
{
    std::error_code ec;
    return fs::exists(P(path), ec) ? make_ok() : make_ret(Err::FSNotExist);
}

Ret PosixFileSystem::remove(const path_t& path, bool onlyIfEmpty)
{
    std::error_code ec;
    if (onlyIfEmpty) {
        return ok(fs::remove(P(path), ec));
    }
    fs::remove_all(P(path), ec);
    return ok(!ec);
}

Ret PosixFileSystem::clear(const path_t& path)
{
    std::error_code ec;
    for (const auto& e : fs::directory_iterator(P(path), ec)) {
        fs::remove_all(e.path(), ec);
    }
    return ok(!ec);
}

Ret PosixFileSystem::copy(const path_t& src, const path_t& dst, bool replace)
{
    std::error_code ec;
    fs::copy(P(src), P(dst), replace ? fs::copy_options::overwrite_existing | fs::copy_options::recursive
             : fs::copy_options::recursive, ec);
    return ok(!ec);
}

Ret PosixFileSystem::move(const path_t& src, const path_t& dst, bool replace)
{
    std::error_code ec;
    if (!replace && fs::exists(P(dst), ec)) {
        return make_ret(Err::FSAlreadyExists);
    }
    fs::rename(P(src), P(dst), ec);
    return ok(!ec);
}

Ret PosixFileSystem::makePath(const path_t& path) const
{
    std::error_code ec;
    fs::create_directories(P(path), ec);
    return ok(!ec);
}

Ret PosixFileSystem::makeLink(const path_t&, const path_t&) const
{
    return make_ret(Ret::Code::NotSupported);
}

EntryType PosixFileSystem::entryType(const path_t& path) const
{
    std::error_code ec;
    if (fs::is_directory(P(path), ec)) {
        return EntryType::Dir;
    }
    if (fs::is_regular_file(P(path), ec)) {
        return EntryType::File;
    }
    return EntryType::Undefined;
}

RetVal<uint64_t> PosixFileSystem::fileSize(const path_t& path) const
{
    std::error_code ec;
    uint64_t s = fs::file_size(P(path), ec);
    RetVal<uint64_t> rv;
    rv.ret = ec ? make_ret(Err::FSReadError) : make_ok();
    rv.val = s;
    return rv;
}

#ifndef MSS_MUSESCORE_4_7
RetVal<uint64_t> PosixFileSystem::availableSpace(const path_t&) const
{
    return RetVal<uint64_t>::make_ok(uint64_t(1) << 30);
}
#endif

RetVal<paths_t> PosixFileSystem::scanFiles(const path_t& rootDir, const std::vector<std::string>& filters, ScanMode mode) const
{
    paths_t result;
    std::error_code ec;

    auto matches = [&filters](const fs::path& p) {
        if (filters.empty()) {
            return true;
        }
        const std::string name = p.filename().string();
        for (const std::string& f : filters) {
            // only "*.ext" style filters are used by the code we compile
            if (f.size() > 1 && f[0] == '*') {
                const std::string ext = f.substr(1);
                if (name.size() >= ext.size() && name.compare(name.size() - ext.size(), ext.size(), ext) == 0) {
                    return true;
                }
            } else if (name == f) {
                return true;
            }
        }
        return false;
    };

    auto take = [&](const fs::directory_entry& e) {
        const bool isDir = e.is_directory();
        switch (mode) {
        case ScanMode::FilesInCurrentDir:
        case ScanMode::FilesInCurrentDirAndSubdirs:
            if (!isDir && matches(e.path())) {
                result.push_back(path_t(e.path().string()));
            }
            break;
        case ScanMode::FoldersInCurrentDir:
            if (isDir) {
                result.push_back(path_t(e.path().string()));
            }
            break;
        case ScanMode::FilesAndFoldersInCurrentDir:
            if (isDir || matches(e.path())) {
                result.push_back(path_t(e.path().string()));
            }
            break;
        }
    };

    if (mode == ScanMode::FilesInCurrentDirAndSubdirs) {
        for (const auto& e : fs::recursive_directory_iterator(P(rootDir), ec)) {
            take(e);
        }
    } else {
        for (const auto& e : fs::directory_iterator(P(rootDir), ec)) {
            take(e);
        }
    }

    return RetVal<paths_t>::make_ok(result);
}

void PosixFileSystem::setAttribute(const path_t&, Attribute) const
{
}

bool PosixFileSystem::setPermissionsAllowedForAll(const path_t&) const
{
    return true;
}

RetVal<ByteArray> PosixFileSystem::readFile(const path_t& filePath) const
{
    RetVal<ByteArray> rv;
    rv.ret = readFile(filePath, rv.val);
    return rv;
}

Ret PosixFileSystem::readFile(const path_t& filePath, ByteArray& data) const
{
    std::ifstream in(filePath.toStdString(), std::ios::binary | std::ios::ate);
    if (!in) {
        return make_ret(Err::FSNotExist);
    }
    std::streamsize size = in.tellg();
    in.seekg(0);
    data.resize(static_cast<size_t>(size));
    if (size > 0 && !in.read(reinterpret_cast<char*>(data.data()), size)) {
        return make_ret(Err::FSReadError);
    }
    return make_ok();
}

Ret PosixFileSystem::writeFile(const path_t& filePath, const ByteArray& data)
{
    std::error_code ec;
    fs::path p = P(filePath);
    if (p.has_parent_path()) {
        fs::create_directories(p.parent_path(), ec);
    }
    std::ofstream out(p, std::ios::binary | std::ios::trunc);
    if (!out) {
        return make_ret(Err::FSWriteError);
    }
    out.write(reinterpret_cast<const char*>(data.constData()), static_cast<std::streamsize>(data.size()));
    return ok(bool(out));
}

static std::map<StreamId, std::FILE*> s_streams;
static StreamId s_lastStream = 0;

RetVal<StreamId> PosixFileSystem::openStream(const path_t& filePath, OpenMode mode)
{
    std::FILE* f = std::fopen(filePath.c_str(), mode == OpenMode::Append ? "ab" : "wb");
    if (!f) {
        RetVal<StreamId> rv;
        rv.ret = make_ret(Err::FSWriteError);
        return rv;
    }
    StreamId id = ++s_lastStream;
    s_streams[id] = f;
    return RetVal<StreamId>::make_ok(id);
}

Ret PosixFileSystem::writeToStream(StreamId fileId, const ByteArray& data, uint64_t offset)
{
    auto it = s_streams.find(fileId);
    if (it == s_streams.end()) {
        return make_ret(Err::FSWriteError);
    }
    if (offset != STREAM_POS_CURRENT) {
        std::fseek(it->second, static_cast<long>(offset), SEEK_SET);
    }
    return ok(std::fwrite(data.constData(), 1, data.size(), it->second) == data.size());
}

Ret PosixFileSystem::closeStream(StreamId fileId)
{
    auto it = s_streams.find(fileId);
    if (it == s_streams.end()) {
        return make_ret(Err::FSWriteError);
    }
    std::fclose(it->second);
    s_streams.erase(it);
    return make_ok();
}

#ifndef MSS_MUSESCORE_4_7
path_t PosixFileSystem::temporaryDirectoryPath() const
{
    return path_t("/tmp");
}
#endif

path_t PosixFileSystem::canonicalFilePath(const path_t& filePath) const
{
    std::error_code ec;
    fs::path p = fs::weakly_canonical(P(filePath), ec);
    return ec ? filePath : path_t(p.string());
}

path_t PosixFileSystem::absolutePath(const path_t& filePath) const
{
    std::error_code ec;
    return path_t(fs::absolute(P(filePath), ec).parent_path().string());
}

path_t PosixFileSystem::absoluteFilePath(const path_t& filePath) const
{
    std::error_code ec;
    return path_t(fs::absolute(P(filePath), ec).string());
}

DateTime PosixFileSystem::birthTime(const path_t&) const
{
    return DateTime();
}

DateTime PosixFileSystem::lastModified(const path_t&) const
{
    return DateTime();
}

Ret PosixFileSystem::isWritable(const path_t&) const
{
    return make_ok();
}
