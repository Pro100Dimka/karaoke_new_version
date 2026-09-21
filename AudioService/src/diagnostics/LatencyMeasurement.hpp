#pragma once
#include <cstdint>
#include <span>
#include <vector>
struct LatencyMeasurementResult {
    bool found{false};
    std::uint32_t latencyFrames{0};
    float peakCorrelation{0.0F};
};
std::vector<float> makeLatencyImpulse(std::uint32_t frames, std::uint32_t impulseFrame = 0);
LatencyMeasurementResult measureImpulseLatency(std::span<const float> reference,
                                               std::span<const float> captured,
                                               std::uint32_t maxLagFrames);
