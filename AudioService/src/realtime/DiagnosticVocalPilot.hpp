#pragma once

#include <cmath>
#include <cstdint>

// Test-only vocal marker. Its beat index is derived from the server's musical frame, never from
// packet arrival or render callbacks. Distinct frequencies identify the two capture sources.
[[nodiscard]] inline float diagnosticVocalPilotSample(std::uint64_t musicalFrame,
                                                       std::uint64_t startFrame,
                                                       std::uint32_t rateHz, float frequencyHz,
                                                       float gain) noexcept {
    if (musicalFrame < startFrame || rateHz == 0)
        return 0.0F;
    const auto period = rateHz / 2U;
    const auto duration = rateHz * 3U / 100U;
    const auto position = (musicalFrame - startFrame) % period;
    if (position >= duration)
        return 0.0F;
    constexpr double Pi = 3.14159265358979323846;
    const auto envelope = std::sin(Pi * (static_cast<double>(position) + 0.5) / duration);
    const auto phase = 2.0 * Pi * frequencyHz * position / rateHz;
    return static_cast<float>(gain * envelope * envelope * std::sin(phase));
}
