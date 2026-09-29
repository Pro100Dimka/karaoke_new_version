#pragma once

#include "dsp/KWeighting.hpp"

#include <algorithm>
#include <array>
#include <atomic>
#include <cmath>
#include <cstdint>
#include <span>

/**
 * Levels in decibels over the recent past, older ones fading out: a quantile of it is steady where
 * a running estimate would swing with every phrase. Fixed storage; safe on the render thread.
 */
class LevelHistogram {
  public:
    // 0.5 dB bins from -120 dB (below any converter's noise) to 0 dB (full scale).
    static constexpr double LowestDb = -120.0;
    static constexpr double BinDb = 0.5;
    static constexpr std::size_t Bins = 240;

    void clear() noexcept {
        weights_.fill(0.0F);
        total_ = 0.0;
    }
    /** Adds one level; everything older fades by `forget` (0..1). */
    void add(double levelDb, double forget) noexcept {
        const auto keep = static_cast<float>(1.0 - forget);
        for (auto& weight : weights_)
            weight *= keep;
        total_ = total_ * keep + 1.0;
        const auto bin = std::clamp((levelDb - LowestDb) / BinDb, 0.0, static_cast<double>(Bins - 1));
        weights_[static_cast<std::size_t>(bin)] += 1.0F;
    }
    /** The level that `fraction` of the weighted history lies below. */
    [[nodiscard]] double quantile(double fraction) const noexcept {
        const auto target = fraction * total_;
        double below = 0.0;
        for (std::size_t bin = 0; bin < Bins; ++bin) {
            below += weights_[bin];
            if (below >= target)
                return LowestDb + (static_cast<double>(bin) + 0.5) * BinDb;
        }
        return 0.0;
    }

  private:
    std::array<float, Bins> weights_{};
    double total_{0.0};
};

/**
 * How loud a voice sounds while it sounds: K-weighted power of the blocks that stand clearly above
 * this microphone's own noise (room noise and silence are ignored), averaged over roughly the last
 * ten seconds of voiced audio, and the level of its quiet phrases. It only measures; it never
 * changes the voice. The render thread notes blocks; any thread may read the levels.
 */
class VoiceLoudness {
  public:
    // A block is voice when it is this much louder than the microphone's noise floor: a quiet
    // interface microphone and a loud laptop microphone are judged by their own noise, not by one
    // absolute level. The noise floor is the level a tenth of all recent blocks fall below.
    static constexpr double VoiceAboveNoiseDb = 10.0;
    static constexpr double NoiseFraction = 0.1;
    static constexpr double AveragingSeconds = 10.0;
    // A level is reported once two seconds of voice were heard.
    static constexpr double MinimumVoicedSeconds = 2.0;
    // The quiet-phrase level is the momentary loudness (the 400 ms window of ITU-R BS.1770) a tenth
    // of the voiced time falls below. Momentary, not per block, so the fading ends of phrases do
    // not count as quiet phrases of their own.
    static constexpr double QuietFraction = 0.1;
    static constexpr double MomentarySeconds = 0.4;

    void prepare(std::uint32_t sampleRateHz) noexcept {
        sampleRateHz_ = std::max(1U, sampleRateHz);
        weighting_.prepare(sampleRateHz_);
        power_.store(0.0F, std::memory_order_relaxed);
        quietDb_.store(0.0F, std::memory_order_relaxed);
        voicedSeconds_.store(0.0F, std::memory_order_relaxed);
        momentaryPower_ = 0.0;
        inPhrase_ = false;
        noise_.clear();
        phrases_.clear();
    }
    void reset() noexcept { prepare(sampleRateHz_); }

    /** Notes the first channel of an interleaved block (render thread). */
    void note(std::span<const float> interleaved, std::uint32_t channels,
              std::uint32_t frames) noexcept {
        if (channels == 0 || frames == 0 ||
            interleaved.size() < static_cast<std::size_t>(frames) * channels)
            return;
        double sum = 0.0;
        for (std::uint32_t frame = 0; frame < frames; ++frame) {
            const auto weighted =
                weighting_.process(interleaved[static_cast<std::size_t>(frame) * channels]);
            sum += weighted * weighted;
        }
        const auto power = sum / frames;
        // Digital silence (a muted or absent stream) is neither noise nor voice.
        if (!(power > 0.0))
            return;
        const auto seconds = static_cast<double>(frames) / sampleRateHz_;
        const auto forget = std::min(1.0, seconds / AveragingSeconds);
        const auto powerDb = 10.0 * std::log10(power);
        noise_.add(powerDb, forget);
        if (powerDb < noise_.quantile(NoiseFraction) + VoiceAboveNoiseDb) {
            inPhrase_ = false; // a pause ends the phrase; the next one is measured on its own
            return;
        }
        const double voiced = voicedSeconds_.load(std::memory_order_relaxed);
        const double previous = power_.load(std::memory_order_relaxed);
        const auto weight = std::min(1.0, seconds / std::min(AveragingSeconds, voiced + seconds));
        power_.store(static_cast<float>(previous + (power - previous) * weight),
                     std::memory_order_relaxed);
        momentaryPower_ = !inPhrase_ ? power
            : momentaryPower_ + (power - momentaryPower_) * std::min(1.0, seconds / MomentarySeconds);
        inPhrase_ = true;
        phrases_.add(10.0 * std::log10(momentaryPower_), forget);
        quietDb_.store(static_cast<float>(phrases_.quantile(QuietFraction)), std::memory_order_relaxed);
        voicedSeconds_.store(static_cast<float>(voiced + seconds), std::memory_order_relaxed);
    }

    /** K-weighted RMS of the voice, or 0 until enough voice was heard. */
    [[nodiscard]] float rms() const noexcept {
        return voicedSeconds_.load(std::memory_order_relaxed) < MinimumVoicedSeconds
                   ? 0.0F
                   : std::sqrt(power_.load(std::memory_order_relaxed));
    }

    /** K-weighted RMS of the voice's quiet phrases, or 0 until enough voice was heard. */
    [[nodiscard]] float quietRms() const noexcept {
        return rms() == 0.0F
                   ? 0.0F
                   : std::pow(10.0F, quietDb_.load(std::memory_order_relaxed) / 20.0F);
    }

  private:
    KWeighting weighting_;
    std::uint32_t sampleRateHz_{48'000};
    std::atomic<float> power_{0.0F};
    std::atomic<float> quietDb_{0.0F};
    std::atomic<float> voicedSeconds_{0.0F};
    double momentaryPower_{0.0}; // render thread only
    bool inPhrase_{false};       // render thread only
    LevelHistogram noise_;       // render thread only: every block
    LevelHistogram phrases_;     // render thread only: momentary loudness of voiced blocks
};

/**
 * Extra gain for the accompaniment so it sits no louder (K-weighted) than the quiet phrases of the
 * quietest voice in the mix: voices lead, the song supports them. Never a boost. It stops at -20 dB
 * so a nearly silent microphone cannot mute the song; 1 while a level is still unknown.
 */
[[nodiscard]] inline float musicAutoTrim(float quietestVoiceRms, float musicRms,
                                         float musicGain) noexcept {
    constexpr float MinimumTrim = 0.1F;
    const auto music = musicRms * musicGain;
    if (quietestVoiceRms <= 0.0F || music <= 0.0F)
        return 1.0F;
    return std::clamp(quietestVoiceRms / music, MinimumTrim, 1.0F);
}

/**
 * Gain that brings a song to the loudness streaming services and browsers play at (-14 LUFS, the
 * level YouTube, Spotify and the AES streaming recommendation normalise to), so this app is no
 * louder than everything else on the computer. Backing tracks are usually mastered far louder.
 * Never a boost; 1 while the song's loudness is unknown. `songRms` is its K-weighted RMS.
 */
[[nodiscard]] inline float streamingLoudnessGain(float songRms) noexcept {
    // BS.1770: loudness = -0.691 + 10 log10(mean K-weighted power).
    constexpr double StreamingLufs = -14.0;
    constexpr double LufsOffsetDb = -0.691;
    const auto targetRms = static_cast<float>(std::pow(10.0, (StreamingLufs - LufsOffsetDb) / 20.0));
    return songRms > 0.0F ? std::min(1.0F, targetRms / songRms) : 1.0F;
}
