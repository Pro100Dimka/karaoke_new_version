#pragma once

#include "common/Types.hpp"

#include <array>
#include <string_view>

class IAudioCallback {
  public:
    virtual ~IAudioCallback() = default;
    virtual void onCapture(GenerationId generation, const BackendAudioBuffer& buffer) noexcept = 0;
    virtual void onRender(GenerationId generation, const BackendAudioBuffer& buffer) noexcept = 0;
    virtual void onRenderSubmitted(MonotonicTicks) noexcept {}
    virtual void onBackendEvent(GenerationId generation, BackendEventType event,
                                std::int32_t code) noexcept = 0;
};

struct BackendSnapshot {
    bool open{false};
    bool running{false};
    std::uint32_t renderPaddingFrames{0};
    std::uint64_t xruns{0};
    std::uint64_t deadlineMisses{0};
    bool mmcssActive{false};
    std::uint64_t renderClockSkipFrames{0}; // frames the device clock ran past everything submitted
    // Frames the device never counted (silence it played while starved) removed from the queue.
    std::uint64_t renderClockRebaseFrames{0};
    // Windows volume of the output endpoint, 0..1; -1 where it does not apply (ASIO, tests).
    float outputEndpointVolume{-1.0F};
    // Legacy QPC-versus-device-clock shortfall. This does not prove audible silence.
    std::uint64_t renderStarvedFrames{0};
    // Frames the shared render queue currently keeps ahead of the engine.
    std::uint32_t renderQueueFrames{0};
    // Streams opened in RAW mode, skipping the Windows signal processing (shared WASAPI only).
    bool inputRaw{false};
    bool outputRaw{false};
    // Nonzero PCM blocks successfully submitted to the physical/backend render stream.
    std::uint64_t outputNonzeroBlocks{0};
    float outputPeak{0.0F};
    std::uint64_t renderTimingPressureFrames{0};
    std::uint64_t renderConfirmedUnderrunFrames{0};
    std::uint64_t renderQueueEscalations{0};
    struct Quantiles {
        std::uint32_t count{0}, p50{0}, p95{0}, p99{0}, maximum{0};
    };
    Quantiles renderPaddingStats{}; // frames
    Quantiles captureEventGapStats{}; // microseconds
    Quantiles capturePacketGapStats{}; // microseconds, from device QPC timestamps
    Quantiles renderEventGapStats{}; // microseconds
    Quantiles duplexWaitStats{}; // microseconds, only waits actually taken
    Quantiles renderCallbackStats{}; // microseconds
    bool sharedClient3Available{false};
    bool sharedPeriodLocked{false};
    bool sharedRenderFirst{false};
    bool sharedCpuFallback{false};
    std::uint32_t sharedRequestedPeriodFrames{0};
    std::uint32_t sharedDefaultPeriodFrames{0};
    std::uint32_t sharedFundamentalPeriodFrames{0};
    std::uint32_t sharedMinimumPeriodFrames{0};
    std::uint32_t sharedMaximumPeriodFrames{0};
    std::uint32_t sharedActualPeriodFrames{0};
    std::uint32_t inputSharedRequestedPeriodFrames{0};
    std::uint32_t inputSharedDefaultPeriodFrames{0};
    std::uint32_t inputSharedFundamentalPeriodFrames{0};
    std::uint32_t inputSharedMinimumPeriodFrames{0};
    std::uint32_t inputSharedMaximumPeriodFrames{0};
    std::uint32_t inputSharedActualPeriodFrames{0};
    bool inputSharedClient3Available{false};
    bool inputSharedPeriodLocked{false};
    std::uint64_t captureDiscontinuities{0};
    std::string_view inputRawReason{"NOT_APPLICABLE"};
    std::string_view outputRawReason{"NOT_APPLICABLE"};
    Quantiles capturePacketsPerWakeStats{};
    Quantiles captureFramesPerWakeStats{};
    std::uint64_t captureRawQpc100ns{0};
    std::uint32_t inputChannelCount{0};
    std::array<std::array<char, 32>, MaxAudioChannels> inputChannelNames{};
};

class IAudioBackend {
  public:
    virtual ~IAudioBackend() = default;
    [[nodiscard]] virtual std::string_view name() const noexcept = 0;
    virtual AudioDeviceCapabilities queryCapabilities(const RequestedConfiguration& requested) = 0;
    virtual RuntimeConfiguration open(const RequestedConfiguration& requested) = 0;
    /** Opens the backend vendor's native device configuration UI, when one exists. */
    virtual bool openControlPanel(const RequestedConfiguration&) {
        return false;
    }
    virtual void start(IAudioCallback& callback, GenerationId generation) = 0;
    virtual void stop() noexcept = 0;
    virtual void close() noexcept = 0;
    [[nodiscard]] virtual BackendSnapshot snapshot() const noexcept = 0;
};
