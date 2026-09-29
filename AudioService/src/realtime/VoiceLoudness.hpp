#pragma once

#include "dsp/KWeighting.hpp"

#include <algorithm>
#include <atomic>
#include <cmath>
#include <cstdint>
#include <span>

/**
 * How loud a voice sounds while it sounds: K-weighted power of blocks above a gate (room noise and
 * silence are ignored), averaged over roughly the last ten seconds of voiced audio, and the level
 * of its quiet phrases (the power only a tenth of the voiced blocks fall below). The render thread
 * notes blocks; any thread may read the levels.
 */
class VoiceLoudness {
  public:
    // Below about -45 dB a microphone carries room noise, not a voice.
    static constexpr double GatePower = 3.2e-5;
    static constexpr double AveragingSeconds = 10.0;
    // A level is reported once two seconds of voice were heard.
    static constexpr double MinimumVoicedSeconds = 2.0;
    // The quiet-phrase level is the power a tenth of the voiced blocks fall below.
    static constexpr double QuietFraction = 0.1;
    // How far one block moves the quiet-phrase estimate, in decibels (about 1 dB/s upwards).
    static constexpr double QuietStepDb = 0.1;

    void prepare(std::uint32_t sampleRateHz) noexcept {
        sampleRateHz_ = std::max(1U, sampleRateHz);
        weighting_.prepare(sampleRateHz_);
        power_.store(0.0F, std::memory_order_relaxed);
        quietDb_.store(0.0F, std::memory_order_relaxed);
        voicedSeconds_.store(0.0F, std::memory_order_relaxed);
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
        if (power < GatePower)
            return;
        const auto seconds = static_cast<double>(frames) / sampleRateHz_;
        const double voiced = voicedSeconds_.load(std::memory_order_relaxed);
        const double previous = power_.load(std::memory_order_relaxed);
        const auto weight = std::min(1.0, seconds / std::min(AveragingSeconds, voiced + seconds));
        power_.store(static_cast<float>(previous + (power - previous) * weight),
                     std::memory_order_relaxed);
        // Running quantile: below the estimate it steps down by 1 - QuietFraction, above it up by
        // QuietFraction, so it settles where a QuietFraction of the blocks lie below it.
        const auto powerDb = 10.0 * std::log10(power);
        const double quiet = voiced == 0.0 ? powerDb : quietDb_.load(std::memory_order_relaxed);
        quietDb_.store(static_cast<float>(quiet + QuietStepDb * (powerDb < quiet ? QuietFraction - 1.0
                                                                                : QuietFraction)),
                       std::memory_order_relaxed);
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
 * Gain that brings a remote voice up to the loudest voice this listener hears (their own included),
 * so a microphone without automatic gain is not buried under one with it. Voices are only raised,
 * never lowered (a limiter after the gain keeps the raised peaks from clipping); 1 while a level is
 * still unknown.
 */
[[nodiscard]] inline float voiceAutoGain(float loudestVoiceRms, float voiceRms) noexcept {
    if (loudestVoiceRms <= 0.0F || voiceRms <= 0.0F)
        return 1.0F;
    return std::max(1.0F, loudestVoiceRms / voiceRms);
}
