#pragma once

#include "realtime/PcmRingBuffer.hpp"

#include <cstdint>
#include <span>
#include <vector>

struct ClockBridgeSnapshot {
    std::uint32_t fillFrames{0};
    std::uint32_t targetFrames{0};
    std::uint32_t capacityFrames{0};
    std::uint64_t overruns{0};
    std::uint64_t underruns{0};
};

class ClockBridge {
  public:
    void prepare(std::uint32_t capacityFrames, std::uint32_t targetFrames, std::uint32_t channels);
    void reset() noexcept;
    [[nodiscard]] bool push(std::span<const float> samples, std::uint32_t frames) noexcept;
    [[nodiscard]] std::uint32_t pull(std::span<float> output, std::uint32_t outputFrames,
                                     double correctionRatio) noexcept;
    [[nodiscard]] ClockBridgeSnapshot snapshot() const noexcept;

  private:
    PcmRingBuffer ring_;
    std::vector<float> scratch_;
    std::uint32_t targetFrames_{0};
    std::uint32_t channels_{0};
    double phase_{0.0};
    std::uint64_t overruns_{0};
    std::uint64_t underruns_{0};
};
