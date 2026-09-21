#include "analysis/SignalMetrics.hpp"

#include <algorithm>
#include <cmath>

void SignalMetrics::observe(std::span<const float> samples) noexcept {
    if (samples.empty()) {
        peak_.store(0.0F, std::memory_order_relaxed);
        rms_.store(0.0F, std::memory_order_relaxed);
        signalPresent_.store(false, std::memory_order_relaxed);
        clipping_.store(false, std::memory_order_relaxed);
        return;
    }
    double squareSum = 0.0;
    float peak = 0.0F;
    std::uint64_t clips = 0;
    for (const auto sample : samples) {
        const auto absolute = std::abs(sample);
        peak = std::max(peak, absolute);
        squareSum += static_cast<double>(sample) * static_cast<double>(sample);
        clips += absolute >= 1.0F ? 1U : 0U;
    }
    const auto rms = static_cast<float>(std::sqrt(squareSum / static_cast<double>(samples.size())));
    const auto previousNoise = noiseFloor_.load(std::memory_order_relaxed);
    const auto nextNoise = rms < 0.05F ? previousNoise * 0.995F + rms * 0.005F : previousNoise;
    peak_.store(peak, std::memory_order_relaxed);
    rms_.store(rms, std::memory_order_relaxed);
    noiseFloor_.store(nextNoise, std::memory_order_relaxed);
    signalPresent_.store(rms >= std::max(0.001F, nextNoise * 2.0F), std::memory_order_relaxed);
    clipping_.store(clips != 0, std::memory_order_relaxed);
    if (clips != 0)
        clipCount_.fetch_add(clips, std::memory_order_relaxed);
}

SignalMetricsSnapshot SignalMetrics::snapshot() const noexcept {
    return {
        peak_.load(std::memory_order_relaxed),       rms_.load(std::memory_order_relaxed),
        noiseFloor_.load(std::memory_order_relaxed), signalPresent_.load(std::memory_order_relaxed),
        clipping_.load(std::memory_order_relaxed),   clipCount_.load(std::memory_order_relaxed)};
}
