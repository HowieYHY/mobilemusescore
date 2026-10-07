# msaudio: MuseScore's audio engine for the AudioWorklet.
# Equivalent of upstream's src/web/audioengine/CMakeLists.txt.

add_subdirectory(${AUDIO_ROOT}/engine audio_engine)

if (MSS_MUSESCORE STREQUAL "4.7")
    # upstream WebRpcChannel (in muse_audio_common), JS bridge through embind
    add_executable(msaudio msaudio.cpp)
    target_link_libraries(msaudio PRIVATE embind)
else()
    add_executable(msaudio
        msaudio.cpp
        ${SHARED_SRC}/jsrpcchannel.cpp
    )
endif()

target_include_directories(msaudio PRIVATE
    ${PROJECT_BINARY_DIR}
    ${SHARED_SRC}
    ${MUSE_FRAMEWORK_PATH}
    ${MUSE_FRAMEWORK_SRC_PATH}
    ${MUSE_FRAMEWORK_SRC_PATH}/global
)

target_link_libraries(msaudio PRIVATE muse_audio_engine muse_audio_common muse_global)

set_target_properties(msaudio PROPERTIES SUFFIX ".mjs")
target_link_options(msaudio PRIVATE
    "SHELL:-s MODULARIZE=1"
    "SHELL:-s EXPORT_ES6=1"
    "SHELL:-s EXPORT_NAME=createMsAudio"
    "SHELL:-s ENVIRONMENT=shell,node"
    "SHELL:-s SINGLE_FILE=1"
    "SHELL:-s WASM_ASYNC_COMPILATION=0"
    "SHELL:-s INITIAL_MEMORY=128MB"
    "SHELL:-s ALLOW_MEMORY_GROWTH=1"
    "SHELL:-s FETCH=1"
    "SHELL:-s FORCE_FILESYSTEM=1"
    "SHELL:-s EXPORTED_RUNTIME_METHODS=HEAPF32,HEAPU8,FS"
    "SHELL:-s EXPORTED_FUNCTIONS=[_main,_malloc,_free,_msaudio_init,_msaudio_process${MSS_RPC_EXPORT}]"
)
