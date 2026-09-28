#pragma once

#ifdef _WIN32
#ifndef WIN32_LEAN_AND_MEAN
#define WIN32_LEAN_AND_MEAN
#endif
#include <audioclient.h>
#include <windows.h>

#include "common/Types.hpp"

#include <cstdint>
#include <cstddef>
#include <chrono>
#include <vector>

namespace WasapiPcm {
[[nodiscard]] AudioSampleFormat sampleFormat(const WAVEFORMATEX* format) noexcept;
[[nodiscard]] std::vector<std::byte> copyWithSampleRate(const WAVEFORMATEX* format,
                                                        std::uint32_t sampleRateHz);
[[nodiscard]] bool eventCallbackMissedDeadline(
    std::chrono::steady_clock::time_point waitStarted,
    std::chrono::steady_clock::time_point eventReady,
    std::chrono::steady_clock::time_point completed,
    std::chrono::steady_clock::duration period) noexcept;
/** Device capture time of a packet from its QPC position (100 ns units), or 0 when the device
 * reports something implausible (in the future or more than a second old). */
[[nodiscard]] MonotonicTicks captureTicksFromQpc(MonotonicTicks qpc100ns,
                                                 MonotonicTicks now = monotonicTicksNow()) noexcept;
/** Presentation time measured from the render clock when it is plausible (not in the past and at
 * most a second ahead); otherwise the fallback. Some virtual endpoints report unrelated clocks. */
[[nodiscard]] MonotonicTicks plausiblePresentationTicks(MonotonicTicks measured,
                                                        MonotonicTicks fallback,
                                                        MonotonicTicks now) noexcept;
void toFloat(const BYTE* input, float* output, std::uint32_t frames, const WAVEFORMATEX* format,
             bool silent) noexcept;
void fromFloat(const float* input, BYTE* output, std::uint32_t frames,
               const WAVEFORMATEX* format) noexcept;
} // namespace WasapiPcm
#endif
