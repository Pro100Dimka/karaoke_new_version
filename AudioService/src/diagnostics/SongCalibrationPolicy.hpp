#pragma once

#include "common/Types.hpp"

#include <cstdlib>
#include <optional>

/** Where the applied acoustic correction came from. */
enum class CalibrationOrigin { None, Profile, TestSignal, Song };

/**
 * Whether a hidden delay the passive estimator found from the song itself replaces the applied
 * correction. Never while a song plays (the voice timeline must not jump mid-performance), never
 * over an explicit test-signal measurement of the same session, and not for a difference the
 * estimate itself does not resolve.
 */
[[nodiscard]] inline std::optional<MonotonicTicks>
songCalibrationToApply(MonotonicTicks foundNs, bool songPlaying, CalibrationOrigin origin,
                       bool calibrated, MonotonicTicks appliedNs) noexcept {
    // The estimate repeats within 1 ms; closer than this it only confirms the applied one.
    constexpr MonotonicTicks RefineThresholdNs = 2'000'000;
    if (foundNs < 0 || songPlaying || origin == CalibrationOrigin::TestSignal)
        return std::nullopt;
    if (calibrated && std::llabs(foundNs - appliedNs) <= RefineThresholdNs)
        return std::nullopt;
    return foundNs;
}
