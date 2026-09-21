#pragma once

#include "backend/IAudioBackend.hpp"

#include <cstdint>
#include <limits>
#include <span>
#include <vector>

struct FakeBackendSettings {
    AudioDeviceCapabilities capabilities{};
    RuntimeConfiguration runtime{48000,
                                 48000,
                                 128,
                                 128,
                                 256,
                                 256,
                                 1,
                                 2,
                                 AudioSampleFormat::Float32,
                                 AudioSampleFormat::Float32,
                                 ClockRelationship::SameDomain,
                                 128,
                                 128};
    std::vector<std::uint32_t> capturePacketFrames{};
    std::vector<std::int64_t> timestampJitterNs{};
    double captureDriftPpm{0.0};
    double renderDriftPpm{0.0};
    std::uint64_t faultAfterCallbacks{std::numeric_limits<std::uint64_t>::max()};
    BackendEventType scheduledFault{BackendEventType::None};
    std::int32_t scheduledFaultCode{0};
    bool failOpen{false};
    bool failStart{false};
};

struct FakeBackendReplayStep {
    std::uint32_t captureFrames{0};
    std::uint32_t renderFrames{0};
    std::int64_t capturePosition{0};
    std::int64_t renderPosition{0};
    MonotonicTicks timestamp{0};
    BackendEventType event{BackendEventType::None};
    std::int32_t eventCode{0};
};

class FakeAudioBackend final : public IAudioBackend {
  public:
    explicit FakeAudioBackend(FakeBackendSettings settings = {});

    [[nodiscard]] std::string_view name() const noexcept override {
        return "Fake";
    }
    AudioDeviceCapabilities queryCapabilities(const RequestedConfiguration&) override;
    RuntimeConfiguration open(const RequestedConfiguration& requested) override;
    void start(IAudioCallback& callback, GenerationId generation) override;
    void stop() noexcept override;
    void close() noexcept override;
    [[nodiscard]] BackendSnapshot snapshot() const noexcept override;

    void pump(std::span<const float> capture, std::uint32_t captureChannels,
              std::span<float> render, std::uint32_t renderChannels, std::int64_t capturePosition,
              std::int64_t renderPosition) noexcept;
    void pumpConfigured(std::span<const float> capture, std::span<float> render) noexcept;
    void replay(std::span<const FakeBackendReplayStep> steps, std::span<const float> captureScratch,
                std::span<float> renderScratch) noexcept;
    void inject(BackendEventType event, std::int32_t code = 0) noexcept;
    void injectStaleEvent(BackendEventType event, std::int32_t code = 0) noexcept;

  private:
    [[nodiscard]] std::uint32_t configuredCaptureFrames(std::size_t availableFrames) noexcept;
    [[nodiscard]] MonotonicTicks configuredTimestamp() const noexcept;
    void advanceConfiguredClock(std::uint32_t captureFrames, std::uint32_t renderFrames) noexcept;
    void emitScheduledFault() noexcept;

    FakeBackendSettings settings_;
    IAudioCallback* callback_{nullptr};
    IAudioCallback* lastCallback_{nullptr};
    GenerationId generation_{0};
    GenerationId lastGeneration_{0};
    bool open_{false};
    bool running_{false};
    std::uint64_t xruns_{0};
    std::uint64_t callbackCount_{0};
    std::size_t capturePacketIndex_{0};
    double capturePosition_{0.0};
    double renderPosition_{0.0};
    MonotonicTicks timestampBase_{1'000'000'000};
};
