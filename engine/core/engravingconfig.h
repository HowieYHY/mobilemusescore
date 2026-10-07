/*
 * SPDX-License-Identifier: GPL-3.0-only
 *
 * mu::engraving::IEngravingConfiguration without Qt settings storage.
 * Values are the defaults of MuseScore's EngravingConfiguration
 * (src/engraving/internal/engravingconfiguration.cpp, GPL-3.0-only), i.e.
 * what a fresh desktop install uses. A viewer never edits them.
 */
#pragma once

#include "engraving/iengravingconfiguration.h"

namespace mss {
class EngravingConfig : public mu::engraving::IEngravingConfiguration
{
public:
    // A4 unless told otherwise; only affects scores that do not store a page size.
    void setDefaultPageSizeLetter(bool letter) { m_letter = letter; }

    muse::io::path_t appDataPath() const override { return "/appdata"; }

    muse::io::path_t defaultStyleFilePath() const override { return {}; }
    void setDefaultStyleFilePath(const muse::io::path_t&) override {}
    muse::async::Channel<muse::io::path_t> defaultStyleFilePathChanged() const override { return m_pathChanged; }

    muse::io::path_t partStyleFilePath() const override { return {}; }
    void setPartStyleFilePath(const muse::io::path_t&) override {}
    muse::async::Channel<muse::io::path_t> partStyleFilePathChanged() const override { return m_pathChanged; }

    mu::engraving::SizeF defaultPageSize() const override
    {
        // QPageSize::size(Letter/A4, Inch)
        return m_letter ? mu::engraving::SizeF(8.5, 11.0) : mu::engraving::SizeF(8.26771653543307, 11.6929133858268);
    }

    bool canLayoutIcons() const override { return false; }
    muse::String iconsFontFamily() const override { return {}; }

    mu::engraving::Color defaultColor() const override { return mu::engraving::Color::BLACK; }
#ifdef MSS_MUSESCORE_4_7
    // EngravingConfiguration 4.7 defaults
    mu::engraving::Color scoreInversionColor() const override { return mu::engraving::Color(220, 220, 220); }
    double guiScaling() const override { return 1.0; }
    bool isAccessibleEnabled() const override { return false; }
    bool doNotSaveEIDsForBackCompat() const override { return false; }
    void setDoNotSaveEIDsForBackCompat(bool) override {}
    int maxScaledImageDim() const override { return m_maxScaledImageDim; }
    void setMaxScaledImageDim(int maxDim) override { m_maxScaledImageDim = maxDim; }
#else
    mu::engraving::Color displayedDefaultColor(bool inverted) const override
    {
        return inverted ? mu::engraving::Color("#CBCBCD") : mu::engraving::Color::BLACK;
    }

    void setDisplayedDefaultColor(mu::engraving::Color, bool) override {}
    muse::async::Channel<bool, mu::engraving::Color> displayedDefaultColorChanged() const override { return m_boolColorChanged; }
    void resetDisplayedDefaultColors() override {}

    mu::engraving::Color indicatorIconInvertedSelectionColor() const override { return voiceColor(0); }
#endif
    mu::engraving::Color lassoColor() const override { return "#00323200"; }
    mu::engraving::Color warningColor() const override { return "#808000"; }
    mu::engraving::Color warningSelectedColor() const override { return "#565600"; }
    mu::engraving::Color criticalColor() const override { return mu::engraving::Color::RED; }
    mu::engraving::Color criticalBackgroundColor() const override { return mu::engraving::Color::RED; }
    mu::engraving::Color criticalSelectedColor() const override { return "#8B0000"; }
    mu::engraving::Color thumbnailBackgroundColor() const override { return mu::engraving::Color::WHITE; }
    mu::engraving::Color noteBackgroundColor() const override { return mu::engraving::Color::WHITE; }
    mu::engraving::Color fontPrimaryColor() const override { return mu::engraving::Color::BLACK; }

    mu::engraving::Color voiceColor(mu::engraving::voice_idx_t voiceIdx) const override
    {
        static const mu::engraving::Color COLORS[] = { "#0065BF", "#007F00", "#C53F00", "#C31989", "#6038FC" };
        return COLORS[voiceIdx < 5 ? voiceIdx : 0];
    }

    mu::engraving::Color selectionColor(mu::engraving::voice_idx_t voice = 0, bool = true, bool = false) const override
    {
        return voiceColor(voice);
    }

    void setSelectionColor(mu::engraving::voice_idx_t, mu::engraving::Color) override {}
    muse::async::Channel<mu::engraving::voice_idx_t, mu::engraving::Color> selectionColorChanged() const override
    {
        return m_voiceColorChanged;
    }

    bool dynamicsApplyToAllVoices() const override { return true; }
    void setDynamicsApplyToAllVoices(bool) override {}
    muse::async::Channel<bool> dynamicsApplyToAllVoicesChanged() const override { return m_boolChanged; }

    bool autoUpdateFretboardDiagrams() const override { return true; }
    void setAutoUpdateFretboardDiagrams(bool) override {}
    muse::async::Channel<bool> autoUpdateFretboardDiagramsChanged() const override { return m_boolChanged; }

    mu::engraving::Color formattingColor() const override { return "#C31989"; }
    muse::async::Channel<mu::engraving::Color> formattingColorChanged() const override { return m_colorChanged; }
    mu::engraving::Color invisibleColor() const override { return "#808080"; }
    muse::async::Channel<mu::engraving::Color> invisibleColorChanged() const override { return m_colorChanged; }
    mu::engraving::Color unlinkedColor() const override { return "#FF9300"; }
    muse::async::Channel<mu::engraving::Color> unlinkedColorChanged() const override { return m_colorChanged; }
    mu::engraving::Color frameColor() const override { return "#A0A0A4"; }
    muse::async::Channel<mu::engraving::Color> frameColorChanged() const override { return m_colorChanged; }
    mu::engraving::Color scoreGreyColor() const override { return "#A0A0A4"; }
    mu::engraving::Color highlightSelectionColor(mu::engraving::voice_idx_t voice = 0) const override { return voiceColor(voice); }

    const DebuggingOptions& debuggingOptions() const override { return m_debug; }
    void setDebuggingOptions(const DebuggingOptions& options) override { m_debug = options; }
    muse::async::Notification debuggingOptionsChanged() const override { return m_notification; }

    bool allowReadingImagesFromOutsideMscz() const override { return false; }
    bool guitarProImportExperimental() const override { return false; }
    bool negativeFretsAllowed() const override { return false; }
    void setGuitarProMultivoiceEnabled(bool v) override { m_multiVoice = v; }
    bool guitarProMultivoiceEnabled() const override { return m_multiVoice; }
    bool minDistanceForPartialSkylineCalculated() const override { return false; }
    bool specificSlursLayoutWorkaround() const override { return false; }
    bool preferSameStringForTranspose() const override { return false; }
    void setPreferSameStringForTranspose(bool) override {}
#ifndef MSS_MUSESCORE_4_7
    bool keepDeadNotesUnchangedOnTranspose() const override { return false; }
#endif

private:
    bool m_letter = false;
    int m_maxScaledImageDim = 4096;
    bool m_multiVoice = false;
    DebuggingOptions m_debug;
    muse::async::Channel<muse::io::path_t> m_pathChanged;
    muse::async::Channel<bool, mu::engraving::Color> m_boolColorChanged;
    muse::async::Channel<mu::engraving::voice_idx_t, mu::engraving::Color> m_voiceColorChanged;
    muse::async::Channel<bool> m_boolChanged;
    muse::async::Channel<mu::engraving::Color> m_colorChanged;
    muse::async::Notification m_notification;
};
}
