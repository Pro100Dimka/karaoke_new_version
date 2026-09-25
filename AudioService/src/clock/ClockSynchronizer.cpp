#include "clock/ClockSynchronizer.hpp"

#include <algorithm>
#include <cmath>

namespace {
constexpr double MaxAcceptedRelativeDrift = 0.01;
constexpr double FilterPreviousWeight = 0.98;
constexpr double FilterObservationWeight = 0.02;
constexpr double MaxReportedDriftPpm = 500.0;
constexpr double MaxCorrectionStep = 0.000005;
} // namespace

void ClockSynchronizer::prepare(std::uint32_t captureSampleRateHz,
                                std::uint32_t renderSampleRateHz) noexcept {
    captureSampleRateHz_ = std::max(1U, captureSampleRateHz);
    renderSampleRateHz_ = std::max(1U, renderSampleRateHz);
    reset();
}

void ClockSynchronizer::reset() noexcept {
    initialized_ = false;
    first_ = {};
    last_ = {};
    filteredRatio_ = 1.0;
    driftPpm_.store(0.0, std::memory_order_relaxed);
    correctionRatio_.store(1.0, std::memory_order_relaxed);
    rejected_.store(0, std::memory_order_relaxed);
}

void ClockSynchronizer::observe(const ClockObservation& observation) noexcept {
    if (!observation.valid || observation.capturePosition < 0 || observation.renderPosition < 0 ||
        observation.captureTimestamp < 0 || observation.renderTimestamp < 0) {
        rejected_.fetch_add(1, std::memory_order_relaxed);
        return;
    }

    if (!initialized_) {
        first_ = observation;
        last_ = observation;
        initialized_ = true;
        return;
    }

    const auto positionsMonotonic = observation.capturePosition > last_.capturePosition &&
                                    observation.renderPosition > last_.renderPosition;
    const auto timestampsMonotonic = observation.captureTimestamp > last_.captureTimestamp &&
                                     observation.renderTimestamp > last_.renderTimestamp;
    if (!positionsMonotonic || !timestampsMonotonic) {
        rejected_.fetch_add(1, std::memory_order_relaxed);
        return;
    }

    const auto captureFrames = observation.capturePosition - first_.capturePosition;
    const auto renderFrames = observation.renderPosition - first_.renderPosition;
    const auto captureTime = observation.captureTimestamp - first_.captureTimestamp;
    const auto renderTime = observation.renderTimestamp - first_.renderTimestamp;
    last_ = observation;

    if (captureFrames <= 0 || renderFrames <= 0 || captureTime <= 0 || renderTime <= 0) {
        rejected_.fetch_add(1, std::memory_order_relaxed);
        return;
    }

    // Compare each device's observed rate against its own nominal rate. Timestamp units cancel,
    // so this works with any common monotonic unit provided by the backend (for example WASAPI's
    // 100-ns QPC values or a fake clock's integer ticks).
    const auto captureNormalized =
        static_cast<double>(captureFrames) /
        (static_cast<double>(captureSampleRateHz_) * static_cast<double>(captureTime));
    const auto renderNormalized =
        static_cast<double>(renderFrames) /
        (static_cast<double>(renderSampleRateHz_) * static_cast<double>(renderTime));
    if (renderNormalized <= 0.0) {
        rejected_.fetch_add(1, std::memory_order_relaxed);
        return;
    }

    const auto ratio = captureNormalized / renderNormalized;
    if (!std::isfinite(ratio) || std::abs(ratio - 1.0) > MaxAcceptedRelativeDrift) {
        rejected_.fetch_add(1, std::memory_order_relaxed);
        return;
    }

    filteredRatio_ = filteredRatio_ * FilterPreviousWeight + ratio * FilterObservationWeight;
    const auto driftPpm =
        std::clamp((filteredRatio_ - 1.0) * 1'000'000.0, -MaxReportedDriftPpm, MaxReportedDriftPpm);
    driftPpm_.store(driftPpm, std::memory_order_relaxed);
    const auto correction = correctionRatio_.load(std::memory_order_relaxed);
    const auto desiredCorrection = 1.0 + driftPpm / 1'000'000.0;
    const auto step =
        std::clamp(desiredCorrection - correction, -MaxCorrectionStep, MaxCorrectionStep);
    correctionRatio_.store(correction + step, std::memory_order_relaxed);
}
