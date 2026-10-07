/*
 * SPDX-License-Identifier: GPL-3.0-only
 *
 * See articulationprofiles.h. The parsing below mirrors
 * ArticulationProfilesRepository::loadProfile and its *FromJson helpers.
 */
#include "articulationprofiles.h"

#include <fstream>
#include <sstream>

#include "global/serialization/json.h"
#include "mpe/internal/articulationstringutils.h"

#include "log.h"

using namespace muse;
using namespace muse::mpe;
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

static const std::map<ArticulationFamily, std::string> DEFAULT_ARTICULATION_PROFILES = {
    { ArticulationFamily::Keyboards, "general_keyboard_articulations_profile.json" },
    { ArticulationFamily::Strings, "general_strings_articulations_profile.json" },
    { ArticulationFamily::Winds, "general_winds_articulations_profile.json" },
    { ArticulationFamily::Percussions, "general_percussion_articulations_profile.json" },
    { ArticulationFamily::Voices, "general_voice_articulations_profile.json" }
};

static const std::string SUPPORTED_FAMILIES = "supportedFamilies";
static const std::string PATTERNS_KEY = "patterns";
static const std::string PATTERN_POS_KEY = "patternPosition";
static const std::string OFFSET_POS_KEY = "offsetPosition";
static const std::string OFFSET_VAL_KEY = "offsetValue";
static const std::string ARRANGEMENT_PATTERN_KEY = "arrangementPattern";
static const std::string DURATION_FACTOR_KEY = "durationFactor";
static const std::string TIMESTAMP_OFFSET_KEY = "timestampOffset";
static const std::string PITCH_PATTERN_KEY = "pitchPattern";
static const std::string PITCH_OFFSETS_KEY = "pitchOffsets";
static const std::string EXPRESSION_PATTERN = "expressionPattern";
static const std::string DYNAMIC_OFFSETS_KEY = "dynamicOffsets";

static ArrangementPattern arrangementPatternFromJson(const JsonObject& obj)
{
    ArrangementPattern result;
    result.durationFactor = obj.value(DURATION_FACTOR_KEY).toInt();
    result.timestampOffset = obj.value(TIMESTAMP_OFFSET_KEY).toInt();
    return result;
}

static PitchPattern pitchPatternFromJson(const JsonObject& obj)
{
    PitchPattern result;
    JsonArray offsets = asArray(obj.value(PITCH_OFFSETS_KEY));
    for (size_t i = 0; i < offsets.size(); ++i) {
        JsonObject offsetObj = asObject(offsets.at(i));
        result.pitchOffsetMap.emplace(offsetObj.value(OFFSET_POS_KEY).toInt(),
                                      offsetObj.value(OFFSET_VAL_KEY).toInt());
    }
    return result;
}

static ExpressionPattern expressionPatternFromJson(const JsonObject& obj)
{
    ExpressionPattern result;
    JsonArray offsets = asArray(obj.value(DYNAMIC_OFFSETS_KEY));
    for (size_t i = 0; i < offsets.size(); ++i) {
        JsonObject offsetObj = asObject(offsets.at(i));
        result.dynamicOffsetMap.emplace(offsetObj.value(OFFSET_POS_KEY).toInt(),
                                        offsetObj.value(OFFSET_VAL_KEY).toInt());
    }
    return result;
}

static ArticulationPattern patternsScopeFromJson(const JsonArray& array)
{
    ArticulationPattern result;
    for (size_t i = 0; i < array.size(); ++i) {
        JsonObject patternObj = asObject(array.at(i));

        duration_percentage_t position = patternObj.value(PATTERN_POS_KEY).toInt();

        ArticulationPatternSegment articulation;
        articulation.arrangementPattern = arrangementPatternFromJson(asObject(patternObj.value(ARRANGEMENT_PATTERN_KEY)));
        articulation.pitchPattern = pitchPatternFromJson(asObject(patternObj.value(PITCH_PATTERN_KEY)));
        articulation.expressionPattern = expressionPatternFromJson(asObject(patternObj.value(EXPRESSION_PATTERN)));

        result.emplace(position, std::move(articulation));
    }
    return result;
}

ArticulationProfiles::ArticulationProfiles(const std::string& resourceDir)
    : m_dir(resourceDir)
{
}

ArticulationsProfilePtr ArticulationProfiles::createNew() const
{
    return std::make_shared<ArticulationsProfile>();
}

ArticulationsProfilePtr ArticulationProfiles::defaultProfile(const ArticulationFamily family) const
{
    auto search = m_defaultProfiles.find(family);
    if (search != m_defaultProfiles.cend()) {
        return search->second;
    }

    auto pathSearch = DEFAULT_ARTICULATION_PROFILES.find(family);
    if (pathSearch == DEFAULT_ARTICULATION_PROFILES.cend()) {
        LOGE() << "Unable to find path for undefined articulations family";
        return nullptr;
    }

    ArticulationsProfilePtr result = loadProfile(io::path_t(m_dir + "/" + pathSearch->second));
    m_defaultProfiles.emplace(family, result);
    return result;
}

ArticulationsProfilePtr ArticulationProfiles::loadProfile(const io::path_t& path) const
{
    std::ifstream in(path.toStdString(), std::ios::binary);
    if (!in) {
        LOGE() << "Unable to read profile, path: " << path;
        return nullptr;
    }
    std::stringstream ss;
    ss << in.rdbuf();
    const std::string text = ss.str();

    std::string err;
    JsonDocument file = JsonDocument::fromJson(ByteArray(text.data(), text.size()), &err);
    if (!err.empty()) {
        LOGE() << err;
        return nullptr;
    }

    ArticulationsProfilePtr result = std::make_shared<ArticulationsProfile>();
    JsonObject rootObj = file.rootObject();

    JsonArray families = asArray(rootObj.value(SUPPORTED_FAMILIES));
    for (size_t i = 0; i < families.size(); ++i) {
        result->supportedFamilies.push_back(articulationFamilyFromString(families.at(i).toStdString()));
    }

    JsonObject articulationPatterns = asObject(rootObj.value(PATTERNS_KEY));
    for (const std::string& key : articulationPatterns.keys()) {
        result->setPattern(articulationTypeFromString(key),
                           patternsScopeFromJson(asArray(articulationPatterns.value(key))));
    }

    return result;
}

void ArticulationProfiles::saveProfile(const io::path_t&, const ArticulationsProfilePtr)
{
    NOT_SUPPORTED;
}

async::Channel<io::path_t> ArticulationProfiles::profileChanged() const
{
    return m_profileChanged;
}
