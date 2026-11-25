#pragma once

#include "dsp/BasicProcessors.hpp"

#include <atomic>
#include <cstdint>
#include <span>
#include <optional>
#include <string_view>

class DspChain {
  public:
    void prepare(std::uint32_t sampleRateHz, std::uint32_t maxFrames, std::uint32_t channels,
                 bool minimizePitchDelay = false);
    void reset() noexcept;
    void process(std::span<float> interleaved, std::uint32_t frames) noexcept;
    void setEnabled(bool enabled) noexcept {
        if (enabled_.load(std::memory_order_acquire) != enabled)
            resetRequested_.store(true, std::memory_order_release);
        enabled_.store(enabled, std::memory_order_release);
    }
    [[nodiscard]] bool setParameter(std::string_view name, float value) noexcept;
    [[nodiscard]] std::optional<float> setVoiceEffect(std::string_view name, float value) noexcept;
    [[nodiscard]] std::uint32_t latencyFrames() const noexcept;

  private:
    std::atomic<bool> enabled_{false};
    std::atomic<bool> resetRequested_{false};
    HighPassProcessor highPass_;
    EqualizerProcessor equalizer_;
    CompressorProcessor compressor_;
    GateProcessor gate_;
    NoiseProcessor noise_;
    ReverbProcessor reverb_;
    DelayProcessor echo_;
    DelayProcessor delay_;
    PitchShiftProcessor pitch_;
};
