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
void toFloat(const BYTE* input, float* output, std::uint32_t frames, const WAVEFORMATEX* format,
             bool silent) noexcept;
void fromFloat(const float* input, BYTE* output, std::uint32_t frames,
               const WAVEFORMATEX* format) noexcept;
} // namespace WasapiPcm
#endif
