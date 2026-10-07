# mscore: MuseScore's .mscz reader, layout engine and playback model.

# FreeType and HarfBuzz from Emscripten ports (muse_deps has no wasm prebuilts)
add_library(mss_freetype INTERFACE)
target_compile_options(mss_freetype INTERFACE "SHELL:-sUSE_FREETYPE=1")
target_link_options(mss_freetype INTERFACE "SHELL:-sUSE_FREETYPE=1")
add_library(freetype::freetype ALIAS mss_freetype)

add_library(mss_harfbuzz INTERFACE)
target_compile_options(mss_harfbuzz INTERFACE "SHELL:-sUSE_HARFBUZZ=1")
target_link_options(mss_harfbuzz INTERFACE "SHELL:-sUSE_HARFBUZZ=1")
add_library(harfbuzz::harfbuzz ALIAS mss_harfbuzz)

# msdfgen only serves FontFaceFT::glyphImage (rasterising glyphs for drawing
# without Qt). We draw text in the browser with the same font files, so that
# path is compiled out for that one file and msdfgen is not needed.
add_library(mss_msdfgen INTERFACE)
add_library(msdfgen::msdfgen ALIAS mss_msdfgen)

if (MSS_MUSESCORE STREQUAL "4.7")
    # 4.7 builds its FreeType font engine only together with Qt's; take the
    # draw module without internals and add the FreeType engine to mscore below.
    set(DRAW_NO_INTERNAL ON)
    add_subdirectory(${MUSE_FRAMEWORK_SRC_PATH}/draw draw)
else()
    add_subdirectory(${MUSE_FRAMEWORK_SRC_PATH}/draw draw)
    set_source_files_properties(${MUSE_FRAMEWORK_SRC_PATH}/draw/internal/fontfaceft.cpp
        TARGET_DIRECTORY muse_draw
        PROPERTIES COMPILE_DEFINITIONS MUSE_MODULE_DRAW_USE_QTTEXTDRAW)
endif()

# muse_create_module adds ${PROJECT_SOURCE_DIR}/src, which is MuseScore's src/ upstream
include_directories(${MU_ROOT}/src ${MU_ROOT})

set(ENGRAVING_NO_INTERNAL ON)
set(ENGRAVING_NO_ACCESSIBILITY ON)
set(MUE_BUILD_ENGRAVING_TESTS OFF)
set(MUE_BUILD_ENGRAVING_PLAYBACK ON)
add_subdirectory(${MU_ROOT}/src/engraving engraving)

add_executable(mscore
    mscore.cpp
    session.cpp
    session.h
    painter.cpp
    painter.h
    audiosettings.cpp
    audiosettings.h
    articulationprofiles.cpp
    articulationprofiles.h
    engravingconfig.h
    md4hash.h
    imageprovider.h
    posixfilesystem.cpp
    posixfilesystem.h
    audiobackend.h
    fonts.h

    # MuseScore engraving services normally built only with Qt (ENGRAVING_NO_INTERNAL)
    ${MU_ROOT}/src/engraving/internal/engravingfontsprovider.cpp
    ${MU_ROOT}/src/engraving/internal/engravingfont.cpp

    # Main-thread side of MuseScore's audio API (muse_framework audio/main)
    ${AUDIO_ROOT}/main/internal/playback.cpp
    ${AUDIO_ROOT}/main/internal/player.cpp
)

if (MSS_MUSESCORE STREQUAL "4.7")
    # upstream WebRpcChannel (in muse_audio_common), JS bridge through embind
    target_sources(mscore PRIVATE audiobackend47.cpp)
    # MuseScore 5.0's FreeType font engine (see fonts.h), compiled with 5.0's
    # draw headers ahead of 4.7's. 4.7's own early engine is not built.
    set(DRAW50 ${REPO_ROOT}/third_party/muse/framework/draw)
    add_library(mss_fonts50 STATIC
        fonts50.cpp
        ${DRAW50}/internal/fontsengine.cpp
        ${DRAW50}/internal/fontsdatabase.cpp
        ${DRAW50}/internal/fontfaceft.cpp
        ${DRAW50}/internal/fontfacedu.cpp
        ${DRAW50}/internal/fontrendercache.cpp
    )
    target_include_directories(mss_fonts50 BEFORE PRIVATE ${DRAW50} ${DRAW50}/internal)
    target_include_directories(mss_fonts50 PRIVATE
        ${PROJECT_BINARY_DIR}
        ${MUSE_FRAMEWORK_SRC_PATH}
        ${MUSE_FRAMEWORK_SRC_PATH}/global
    )
    # glyph rasterising (msdfgen) is not needed: the browser draws the text
    target_compile_definitions(mss_fonts50 PRIVATE MUSE_MODULE_DRAW_USE_QTTEXTDRAW MUSE_MODULE_DRAW_USE_FONTFACE_FT)
    target_link_libraries(mss_fonts50 PRIVATE muse_global mss_freetype mss_harfbuzz)
    target_link_libraries(mscore PRIVATE mss_fonts50)
    target_link_libraries(mscore PRIVATE embind)
else()
    target_sources(mscore PRIVATE audiobackend50.cpp fonts50.cpp ${SHARED_SRC}/jsrpcchannel.cpp)
    target_include_directories(mscore PRIVATE ${MUSE_FRAMEWORK_SRC_PATH}/draw)
endif()

target_include_directories(mscore PRIVATE
    ${PROJECT_BINARY_DIR}
    ${CMAKE_CURRENT_LIST_DIR}
    ${SHARED_SRC}
    ${MU_ROOT}
    ${MU_ROOT}/src
    ${MU_ROOT}/src/engraving
    ${MU_ROOT}/src/engraving/infrastructure
    ${MUSE_FRAMEWORK_PATH}
    ${AUDIO_ROOT}
    ${MUSE_FRAMEWORK_SRC_PATH}
    ${MUSE_FRAMEWORK_SRC_PATH}/global
)

target_compile_definitions(mscore PRIVATE ENGRAVING_NO_INTERNAL ENGRAVING_NO_ACCESSIBILITY)

target_link_libraries(mscore PRIVATE
    engraving
    muse_draw
    muse_audio_common
    muse_global
    mss_freetype
    mss_harfbuzz
)

set_target_properties(mscore PROPERTIES SUFFIX ".mjs")
target_link_options(mscore PRIVATE
    "SHELL:-s MODULARIZE=1"
    "SHELL:-s EXPORT_ES6=1"
    "SHELL:-s EXPORT_NAME=createMsCore"
    "SHELL:-s ENVIRONMENT=web,worker,node"
    "SHELL:-s INITIAL_MEMORY=128MB"
    "SHELL:-s ALLOW_MEMORY_GROWTH=1"
    "SHELL:-s STACK_SIZE=4MB"
    "SHELL:-s FORCE_FILESYSTEM=1"
    "SHELL:-s EXPORTED_RUNTIME_METHODS=FS,HEAPU8,HEAPF64,UTF8ToString,stringToUTF8,lengthBytesUTF8"
    "SHELL:-s EXPORTED_FUNCTIONS=[_main,_malloc,_free${MSS_RPC_EXPORT}]"
)
