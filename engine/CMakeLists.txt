# Builds MuseScore's own engraving, playback and audio code to WebAssembly.
#
#   msaudio  - MuseScore's audio engine (FluidSynth + MS Basic, mixer, reverb).
#              Runs inside an AudioWorklet, like upstream's src/web/audioengine.
#   mscore   - MuseScore's .mscz reader, layout engine and playback model.
#              Runs on the page (or a worker) and drives msaudio over
#              MuseScore's RPC channel.
#
# Sources are compiled from the pinned submodules in third_party/, with the
# small changes in patches/ (see README.md).
#
# MSS_MUSESCORE picks the MuseScore source to build from:
#   4.7 (default) - MuseScore Studio 4.7.5, third_party/musescore-4.7: the
#                   version the user's desktop runs, so playback matches it
#   5.0           - MuseScore Studio 5.0 development (the user's fork) with
#                   the separate muse_framework / muse_deps submodules

cmake_minimum_required(VERSION 3.24)
project(MobileMuseScoreEngine LANGUAGES C CXX)

set(MSS_MUSESCORE "4.7" CACHE STRING "MuseScore source to build from: 4.7 or 5.0")
set_property(CACHE MSS_MUSESCORE PROPERTY STRINGS 4.7 5.0)

# 4.7 is a C++17 code base (C++20 aggregate rules break some of its types)
if (MSS_MUSESCORE STREQUAL "4.7")
    set(CMAKE_CXX_STANDARD 17)
else()
    set(CMAKE_CXX_STANDARD 20)
endif()
set(CMAKE_CXX_STANDARD_REQUIRED ON)
set(CMAKE_CXX_SCAN_FOR_MODULES OFF)
set(CMAKE_POSITION_INDEPENDENT_CODE ON)

set(REPO_ROOT ${CMAKE_CURRENT_LIST_DIR}/..)
if (MSS_MUSESCORE STREQUAL "4.7")
    set(MU_ROOT ${REPO_ROOT}/third_party/musescore-4.7)
    set(MUSE_FRAMEWORK_PATH ${MU_ROOT})
    set(MUSE_FRAMEWORK_SRC_PATH ${MU_ROOT}/src/framework)
    set(THIRDPARTY_DIR ${MU_ROOT}/thirdparty)
    add_compile_definitions(MSS_MUSESCORE_4_7)
else()
    set(MU_ROOT ${REPO_ROOT}/third_party/musescore)
    set(MUSE_FRAMEWORK_PATH ${REPO_ROOT}/third_party/muse)
    set(MUSE_FRAMEWORK_SRC_PATH ${MUSE_FRAMEWORK_PATH}/framework)
endif()
message(STATUS "Building from MuseScore ${MSS_MUSESCORE}: ${MU_ROOT}")

set(CMAKE_MODULE_PATH
    ${MU_ROOT}/buildscripts
    ${MU_ROOT}/buildscripts/cmake
    ${MUSE_FRAMEWORK_PATH}/buildscripts/cmake
    ${MUSE_FRAMEWORK_SRC_PATH}/cmake
    ${CMAKE_MODULE_PATH}
)

if (NOT EMSCRIPTEN)
    message(FATAL_ERROR "Configure with emcmake (Emscripten); see README.md")
endif()
# GetPlatformInfo recognises Emscripten by an "em++" compiler path, which
# misses "em++.exe" on Windows hosts, so state the platform up front.
set(OS_IS_WASM 1)
set(ARCH_IS_WASM 1)
set(PLATFORM_DETECTED 1)
include(GetPlatformInfo)

include(${MU_ROOT}/version.cmake)
set(MUSE_APP_NAME_HUMAN_READABLE "PocketScore")
set(MUSE_APP_NAME_MACHINE_READABLE "PocketScore")

# --- Configuration (mirrors upstream's APP-WEB configuration) -------------
set(MUSE_QT_SUPPORT OFF)
set(MUSE_CONFIGURATION_IS_WEB ON)
set(MUSE_THREADS_SUPPORT OFF)
set(MUSE_MODULE_AUDIO ON)
set(MUSE_MODULE_AUDIO_EXPORT OFF)
set(MUSE_MODULE_AUDIO_WORKMODE 2) # driver callback
set(MUSE_MODULE_MPE ON)
set(MUSE_MODULE_DRAW ON)
set(MUSE_MODULE_DRAW_USE_FONTFACE_FT ON)
set(MUSE_MODULE_DRAW_USE_QTFONTMETRICS OFF)
set(MUSE_MODULE_DRAW_USE_QTTEXTDRAW OFF)
set(MUSE_ENABLE_UNIT_TESTS OFF)
set(BUILD_SHARED_LIBS OFF)

include(GetCompilerInfo)
include(SetupCompileWarnings)
include(${MUSE_FRAMEWORK_SRC_PATH}/cmake/MuseSetupConfiguration.cmake)
add_compile_definitions(NO_QT_SUPPORT Q_OS_WASM)

# Emscripten ports used instead of muse_deps prebuilts (which have no wasm builds)
set(EMCC_PORTS "-sUSE_ZLIB=1")
add_compile_options("SHELL:${EMCC_PORTS}")
add_link_options("SHELL:${EMCC_PORTS}")
add_compile_options(-Wno-deprecated-declarations -Wno-nontrivial-memcall)

if (NOT MSS_MUSESCORE STREQUAL "4.7")
    # Header-only/source deps, fetched and SHA-256 verified by MuseScore's muse_deps
    # (4.7 keeps them inside its own source tree)
    set(EXTDEPS_DIR "${REPO_ROOT}/third_party/muse_deps")
    include(${EXTDEPS_DIR}/buildtools/manifest.cmake)
    require_source_dep(picojson)
    require_source_dep(pugixml)
    require_source_dep(utfcpp)
endif()

# Qt-only parts of global (settings, API, process); 5.0 sets this itself
# without Qt, 4.7 expects the caller to (as its tools/check_build_without_qt does)
set(GLOBAL_NO_INTERNAL ON)
add_subdirectory(${MUSE_FRAMEWORK_SRC_PATH}/global global)

set(AUDIO_ROOT ${MUSE_FRAMEWORK_SRC_PATH}/audio)
add_subdirectory(${AUDIO_ROOT}/common audio_common)
if (NOT MSS_MUSESCORE STREQUAL "4.7")
    # In 5.0, upstream's WebRpcChannel predates the context-aware IRpcChannel
    # interface; shared/jsrpcchannel.cpp replaces it. 4.7 uses upstream's as is.
    get_target_property(_ac_src muse_audio_common SOURCES)
    list(FILTER _ac_src EXCLUDE REGEX "rpc/platform/web/webrpcchannel")
    set_target_properties(muse_audio_common PROPERTIES SOURCES "${_ac_src}")
endif()

set(SHARED_SRC ${CMAKE_CURRENT_LIST_DIR}/shared)

# JS -> wasm RPC entry: our C export in 5.0, upstream's embind function in 4.7
if (MSS_MUSESCORE STREQUAL "4.7")
    set(MSS_RPC_EXPORT "")
else()
    set(MSS_RPC_EXPORT ",_mss_rpc_receive")
endif()

option(MSS_FUNCTION_NAMES "Keep function names in the wasm (debugging stack traces)" OFF)
if (MSS_FUNCTION_NAMES)
    add_link_options("--profiling-funcs" "SHELL:-s ASSERTIONS=1")
endif()

option(BUILD_MSAUDIO "Build the audio engine module" ON)
option(BUILD_MSCORE "Build the score module" ON)

if (BUILD_MSAUDIO)
    add_subdirectory(audio)
endif()
if (BUILD_MSCORE)
    add_subdirectory(core)
endif()
