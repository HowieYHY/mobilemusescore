/*
 * SPDX-License-Identifier: GPL-3.0-only
 *
 * See audiosettings.h. Mirrors ProjectAudioSettings::read and its *FromJson helpers.
 */
#include "audiosettings.h"

#include "global/serialization/json.h"
#include "global/types/bytearray.h"

#include "log.h"

using namespace muse;
using namespace muse::audio;
using namespace mu::engraving;
using namespace mss;

// muse::JsonValue asserts on a type mismatch, where QJsonValue returns an
// empty value; these keep the Qt behaviour for missing or mistyped keys.
static muse::JsonObject asObject(const muse::JsonValue& v)
{
    return v.isObject() ? v.toObject() : muse::JsonObject();
}

static muse::JsonArray asArray(const muse::JsonValue& v)
{
    return v.isArray() ? v.toArray() : muse::JsonArray();
}

static AudioResourceAttributes attributesFromJson(const JsonObject& object)
{
    AudioResourceAttributes result;
    for (const std::string& key : object.keys()) {
        result.emplace(String::fromStdString(key), object.value(key).toString());
    }
    return result;
}

static AudioResourceMeta resourceMetaFromJson(const JsonObject& object)
{
    AudioResourceMeta result;
    result.id = object.value("id").toStdString();
    result.vendor = object.value("vendor").toStdString();

    // ProjectAudioSettings::resourceTypeFromString: the file stores RESOURCE_TYPE_MAP strings
    const String typeStr = object.value("type").toString();
    for (const auto& pair : RESOURCE_TYPE_MAP) {
        if (pair.second == typeStr) {
#ifdef MSS_MUSESCORE_4_7
            result.type = pair.first;
#else
            result.type = resourceTypeName(pair.first);
#endif
            break;
        }
    }

    result.attributes = attributesFromJson(asObject(object.value("attributes")));

#ifdef MSS_MUSESCORE_4_7
    result.hasNativeEditorSupport = object.value("hasNativeEditorSupport").toBool();
#else
    // migrate legacy top-level hasNativeEditorSupport into attributes
    const std::string nativeEditorKey = HAS_NATIVE_EDITOR_SUPPORT_ATTRIBUTE.toStdString();
    if (object.contains(nativeEditorKey) && !result.attributes.count(HAS_NATIVE_EDITOR_SUPPORT_ATTRIBUTE)) {
        result.attributes.emplace(HAS_NATIVE_EDITOR_SUPPORT_ATTRIBUTE, object.value(nativeEditorKey).toBool() ? u"true" : u"false");
    }
#endif

    return result;
}

static std::string fromBase64(const std::string& in)
{
    static const std::string chars = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
    std::string out;
    int val = 0;
    int bits = -8;
    for (unsigned char c : in) {
        size_t pos = chars.find(static_cast<char>(c));
        if (pos == std::string::npos) {
            continue; // skips '=' padding and whitespace
        }
        val = (val << 6) + static_cast<int>(pos);
        bits += 6;
        if (bits >= 0) {
            out.push_back(static_cast<char>((val >> bits) & 0xFF));
            bits -= 8;
        }
    }
    return out;
}

static AudioUnitConfig unitConfigFromJson(const JsonObject& object)
{
    AudioUnitConfig result;
    for (const std::string& key : object.keys()) {
        result.emplace(key, fromBase64(object.value(key).toStdString()));
    }
    return result;
}

static AudioFxParams fxParamsFromJson(const JsonObject& object)
{
    AudioFxParams result;
    result.active = object.value("active").toBool();
    result.chainOrder = static_cast<AudioFxChainOrder>(object.value("chainOrder").toInt());
    result.resourceMeta = resourceMetaFromJson(asObject(object.value("resourceMeta")));
    result.configuration = unitConfigFromJson(asObject(object.value("unitConfiguration")));
    return result;
}

static AudioFxChain fxChainFromJson(const JsonObject& object)
{
    AudioFxChain result;
    for (const std::string& key : object.keys()) {
        result.emplace(static_cast<AudioFxChainOrder>(std::stoi(key)), fxParamsFromJson(asObject(object.value(key))));
    }
    return result;
}

static AuxSendsParams auxSendsFromJson(const JsonArray& list)
{
    AuxSendsParams result;
    for (size_t i = 0; i < list.size(); ++i) {
        JsonObject o = asObject(list.at(i));
        AuxSendParams p;
        p.signalAmount = static_cast<float>(o.value("signalAmount").toDouble());
        p.active = o.value("active").toBool();
        result.push_back(p);
    }
    return result;
}

static OutputParams outputParamsFromJson(const JsonObject& object)
{
    OutputParams result;
    result.fxChain = fxChainFromJson(asObject(object.value("fxChain")));
    result.balance = static_cast<float>(object.value("balance").toDouble());
    result.volume = static_cast<float>(object.value("volumeDb").toDouble());
    result.auxSends = auxSendsFromJson(asArray(object.value("auxSends")));
    return result;
}

static SoloMuteState soloMuteStateFromJson(const JsonObject& object)
{
    SoloMuteState result;
    result.mute = object.value("mute").toBool();
    result.solo = object.value("solo").toBool();
    return result;
}

bool AudioSettings::read(const ByteArray& json)
{
    if (json.empty()) {
        return false;
    }

    std::string err;
    JsonDocument doc = JsonDocument::fromJson(json, &err);
    if (!err.empty() || !doc.isObject()) {
        LOGE() << "audiosettings.json: " << err;
        return false;
    }

    JsonObject rootObj = doc.rootObject();

    m_master = outputParamsFromJson(asObject(rootObj.value("master")));

    JsonArray auxArray = asArray(rootObj.value("aux"));
    for (size_t i = 0; i < auxArray.size(); ++i) {
        JsonObject auxObject = asObject(auxArray.at(i));
        m_aux.emplace(static_cast<aux_channel_idx_t>(i), outputParamsFromJson(asObject(auxObject.value("out"))));
        m_auxSoloMute.emplace(static_cast<aux_channel_idx_t>(i), soloMuteStateFromJson(asObject(auxObject.value("soloMuteState"))));
    }

    JsonArray tracks = asArray(rootObj.value("tracks"));
    for (size_t i = 0; i < tracks.size(); ++i) {
        JsonObject trackObject = asObject(tracks.at(i));

        InstrumentTrackId id = {
            ID(trackObject.value("partId").toStdString()),
            trackObject.value("instrumentId").toString()
        };

        JsonObject inObj = asObject(trackObject.value("in"));
        AudioInputParams in;
        in.resourceMeta = resourceMetaFromJson(asObject(inObj.value("resourceMeta")));
        in.configuration = unitConfigFromJson(asObject(inObj.value("unitConfiguration")));
        m_trackIn.emplace(id, std::move(in));

        if (trackObject.contains("out")) {
            m_trackOut.emplace(id, outputParamsFromJson(asObject(trackObject.value("out"))));
        }
        if (trackObject.contains("soloMuteState")) {
            m_trackSoloMute.emplace(id, soloMuteStateFromJson(asObject(trackObject.value("soloMuteState"))));
        }
    }

    m_activeSoundProfile = rootObj.value("activeSoundProfile").toString();
    return true;
}

const OutputParams& AudioSettings::auxOutputParams(aux_channel_idx_t index) const
{
    static const OutputParams empty;
    auto it = m_aux.find(index);
    return it != m_aux.end() ? it->second : empty;
}

SoloMuteState AudioSettings::auxSoloMuteState(aux_channel_idx_t index) const
{
    auto it = m_auxSoloMute.find(index);
    return it != m_auxSoloMute.end() ? it->second : SoloMuteState();
}

AudioInputParams AudioSettings::trackInputParams(const InstrumentTrackId& id) const
{
    auto it = m_trackIn.find(id);
    return it != m_trackIn.end() ? it->second : AudioInputParams();
}

OutputParams AudioSettings::trackOutputParams(const InstrumentTrackId& id) const
{
    auto it = m_trackOut.find(id);
    return it != m_trackOut.end() ? it->second : OutputParams();
}

SoloMuteState AudioSettings::trackSoloMuteState(const InstrumentTrackId& id) const
{
    auto it = m_trackSoloMute.find(id);
    return it != m_trackSoloMute.end() ? it->second : SoloMuteState();
}
