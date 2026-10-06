#pragma once

#ifdef _WIN32
#ifndef WIN32_LEAN_AND_MEAN
#define WIN32_LEAN_AND_MEAN
#endif
#include <audioclient.h>
#include <windows.h>

#include "common/Types.hpp"

#include <array>
#include <atomic>
#include <chrono>
#include <cstddef>
#include <cstdint>
#include <vector>

namespace WasapiPcm {
struct MeasurementQuantiles {
    std::uint32_t count{0}, p50{0}, p95{0}, p99{0}, maximum{0};
};

[[nodiscard]] std::vector<std::uint32_t> sharedPeriodChoices(std::uint32_t minimum,
                                                              std::uint32_t maximum,
                                                              std::uint32_t fundamental);

// The audio thread only stores samples. Sorting happens when diagnostics are requested.
class RecentMeasurements {
  public:
    void observe(std::uint32_t value) noexcept;
    [[nodiscard]] MeasurementQuantiles snapshot() const;
    void reset() noexcept;

  private:
    std::array<std::atomic<std::uint32_t>, 256> values_{};
    std::atomic<std::uint64_t> next_{0};
};

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
enum class SharedQueueReason { None, ConfirmedUnderrun, RepeatedLateEmpty, SilentRecovery };
struct SharedQueueState {
    std::uint32_t periods{1};
    std::uint32_t lateEmptyEvents{0};
};
struct SharedQueueEvidence {
    std::uint32_t periodFrames, bufferFrames, sampleRateHz, paddingFrames, renderEventGapUs;
    bool renderEvent;
    std::uint64_t confirmedUnderrunFrames, timingPressureFrames;
    bool silentRecovery;
};
struct SharedQueueDecision {
    std::uint32_t periods;
    SharedQueueReason reason;
};
/** QPC/device-clock divergence after allowing one frame of integer clock quantization. */
[[nodiscard]] std::uint64_t timingPressureFrames(std::uint64_t elapsedQpc100ns,
                                                 std::uint64_t playedFrames,
                                                 std::uint32_t sampleRateHz) noexcept;
/** Queue growth requires a direct clock skip or repeated late render events with no padding. */
[[nodiscard]] SharedQueueDecision updateSharedQueue(SharedQueueState& state,
                                                    const SharedQueueEvidence& evidence) noexcept;
void toFloat(const BYTE* input, float* output, std::uint32_t frames, const WAVEFORMATEX* format,
             bool silent) noexcept;
void fromFloat(const float* input, BYTE* output, std::uint32_t frames,
               const WAVEFORMATEX* format) noexcept;
} // namespace WasapiPcm
#endif
