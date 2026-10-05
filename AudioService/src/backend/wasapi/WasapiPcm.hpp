#pragma once

#ifdef _WIN32
#ifndef WIN32_LEAN_AND_MEAN
#define WIN32_LEAN_AND_MEAN
#endif
#include <audioclient.h>
#include <windows.h>

#include "common/Types.hpp"

#include <chrono>
#include <cstddef>
#include <cstdint>
#include <vector>

namespace WasapiPcm {
[[nodiscard]] AudioSampleFormat sampleFormat(const WAVEFORMATEX* format) noexcept;
[[nodiscard]] std::vector<std::byte> copyWithSampleRate(const WAVEFORMATEX* format,
                                                        std::uint32_t sampleRateHz);
[[nodiscard]] bool eventCallbackMissedDeadline(std::chrono::steady_clock::time_point waitStarted,
                                               std::chrono::steady_clock::time_point eventReady,
                                               std::chrono::steady_clock::time_point completed,
                                               std::chrono::steady_clock::duration period) noexcept;
/** Device capture time of a packet from its QPC position (100 ns units), or 0 when the device
 * reports something implausible (in the future or more than a second old). */
[[nodiscard]] MonotonicTicks captureTicksFromQpc(MonotonicTicks qpc100ns,
                                                 MonotonicTicks now = monotonicTicksNow()) noexcept;
/**
 * Frames submitted to the render stream so far, as the render clock should count them. A device
 * that starves (a glitch) plays silence it never adds to its position, so "submitted minus played"
 * grows with every glitch although the audible delay does not: one crackling laptop reached 14 s.
 * Beyond what the stream can hold (two buffers plus the stream latency) the count is rebased to
 * one buffer ahead of the device.
 */
[[nodiscard]] std::uint64_t rebasedRenderSubmission(std::uint64_t submittedFrames,
                                                    std::uint64_t positionFrames,
                                                    std::uint32_t paddingFrames,
                                                    std::uint32_t bufferFrames,
                                                    std::uint32_t streamLatencyFrames) noexcept;
/**
 * Shared-mode render queue depth in engine periods. One period is the lowest latency, but an
 * endpoint whose engine converts the rate or whose thread wakes irregularly drains it before the
 * next wake-up and plays silence (crackle). When a measurement window shows the engine played
 * more than one period less than the wall clock advanced, the queue grows by one period, up to
 * the whole endpoint buffer. A caller-confirmed silent recovery interval permits one step down
 * when the engine is no longer starving; audible playback never triggers this probe.
 */
[[nodiscard]] std::uint32_t sharedQueuePeriods(std::uint32_t periods, std::uint32_t maximumPeriods,
                                               std::uint64_t elapsedFrames,
                                               std::uint64_t playedFrames,
                                               std::uint32_t periodFrames,
                                               bool silentRecovery = false) noexcept;
void toFloat(const BYTE* input, float* output, std::uint32_t frames, const WAVEFORMATEX* format,
             bool silent) noexcept;
void fromFloat(const float* input, BYTE* output, std::uint32_t frames,
               const WAVEFORMATEX* format) noexcept;
} // namespace WasapiPcm
#endif
