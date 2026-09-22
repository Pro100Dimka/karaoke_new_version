#pragma once

#ifdef _WIN32
#ifndef WIN32_LEAN_AND_MEAN
#define WIN32_LEAN_AND_MEAN
#endif
#include <audioclient.h>
#include <windows.h>

#include "common/Types.hpp"

#include <cstdint>

namespace WasapiPcm {
// Shared-mode endpoint processing commonly adds roughly 3 dB of perceived level. Exclusive mode
// bypasses that path, so compensate only at the listening boundary; mixer values and recordings
// remain identical when the user changes backend.
inline constexpr float ExclusiveListeningLevelCompensation = 1.4125376F;
[[nodiscard]] AudioSampleFormat sampleFormat(const WAVEFORMATEX* format) noexcept;
void toFloat(const BYTE* input, float* output, std::uint32_t frames, const WAVEFORMATEX* format,
             bool silent) noexcept;
void fromFloat(const float* input, BYTE* output, std::uint32_t frames,
               const WAVEFORMATEX* format, float listeningGain = 1.0F) noexcept;
} // namespace WasapiPcm
#endif
