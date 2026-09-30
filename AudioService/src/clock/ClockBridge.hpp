#pragma once

#include "realtime/PcmRingBuffer.hpp"

#include <atomic>
#include <cstdint>
#include <span>
#include <vector>

struct ClockBridgeSnapshot {
    std::uint32_t fillFrames{0};
    std::uint32_t targetFrames{0};
    std::uint32_t capacityFrames{0};
    std::uint64_t overruns{0};
    std::uint64_t underruns{0};
    double fillCorrectionRatio{1.0};
    std::uint64_t droppedFrames{0};
};

class ClockBridge {
  public:
    static std::uint32_t recommendedTargetFrames(std::uint32_t capacityFrames,
                                                 std::uint32_t inputSampleRateHz) noexcept;
    // targetFrames is the low-water reserve AFTER a render pull, in input-clock frames.
    void prepare(std::uint32_t capacityFrames, std::uint32_t targetFrames, std::uint32_t channels,
                 std::uint32_t inputSampleRateHz);
    void reset() noexcept;
    [[nodiscard]] bool push(std::span<const float> samples, std::uint32_t frames) noexcept;
    [[nodiscard]] std::uint32_t pull(std::span<float> output, std::uint32_t outputFrames,
                                     double correctionRatio) noexcept;
    [[nodiscard]] ClockBridgeSnapshot snapshot() const noexcept;

  private:
    double regulateFill(std::uint32_t available, std::uint32_t outputFrames,
                        double deviceRatio) noexcept;
    PcmRingBuffer ring_;
    std::vector<float> scratch_;
    std::uint32_t targetFrames_{0};
    std::uint32_t channels_{0};
    double phase_{0.0};
    std::uint32_t sampleRateHz_{0};
    double windowFrames_{0.0}, observedFrames_{0.0}, minimumResidualFrames_{0.0};
    double desiredFillCorrection_{0.0};
    double largestDemandFrames_{0.0}; // the largest single render pull seen since reset
    bool fillControlActive_{false};
    std::atomic<double> fillCorrection_{0.0};
    std::atomic<std::uint64_t> overruns_{0};
    std::atomic<std::uint64_t> underruns_{0};
    std::atomic<std::uint64_t> droppedFrames_{0};
};
