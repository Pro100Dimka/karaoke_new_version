#pragma once

#include "dsp/BasicProcessors.hpp"

#include <atomic>
#include <cstdint>
#include <span>
#include <string_view>

class DspChain {
  public:
    void prepare(std::uint32_t sampleRateHz, std::uint32_t maxFrames, std::uint32_t channels);
    void reset() noexcept;
    void process(std::span<float> interleaved, std::uint32_t frames) noexcept;
    void setEnabled(bool enabled) noexcept {
        enabled_.store(enabled, std::memory_order_relaxed);
    }
    [[nodiscard]] bool setParameter(std::string_view name, float value) noexcept;
    [[nodiscard]] std::uint32_t latencyFrames() const noexcept;

  private:
    std::atomic<bool> enabled_{false};
    HighPassProcessor highPass_;
    EqualizerProcessor equalizer_;
    CompressorProcessor compressor_;
    GateProcessor gate_;
    NoiseProcessor noise_;
    ReverbProcessor reverb_;
    DelayProcessor delay_;
    PitchShiftProcessor pitch_;
};
