#pragma once

#include "realtime/PcmRingBuffer.hpp"

#include <array>
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
    double currentDemandFrames{0.0};
    double largestDemandFrames{0.0};
    double residualBeforePullFrames{0.0};
    std::uint32_t fillBeforePullP50Frames{0};
    std::uint32_t fillBeforePullP95Frames{0};
    std::uint32_t fillBeforePullP99Frames{0};
    std::uint32_t fillBeforePullMaximumFrames{0};
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
    [[nodiscard]] ClockBridgeSnapshot diagnosticSnapshot() const noexcept;

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
    double largestDemandFrames_{0.0}; // largest render pull within the recent response horizon
    double framesSinceLargestDemand_{0.0};
    bool fillControlActive_{false};
    std::atomic<double> fillCorrection_{0.0};
    std::atomic<std::uint64_t> overruns_{0};
    std::atomic<std::uint64_t> underruns_{0};
    std::atomic<std::uint64_t> droppedFrames_{0};
    std::atomic<double> currentDemandPublished_{0.0};
    std::atomic<double> largestDemandPublished_{0.0};
    std::atomic<double> residualPublished_{0.0};
    std::array<std::atomic<std::uint32_t>, 256> fillBeforePull_{};
    std::atomic<std::uint64_t> fillSampleCount_{0};
};
