#include "backend/fake/FakeAudioBackend.hpp"

#include <algorithm>
#include <cmath>
#include <stdexcept>
#include <utility>

namespace {
constexpr double PartsPerMillion = 1'000'000.0;
constexpr double NanosecondsPerSecond = 1'000'000'000.0;
} // namespace

FakeAudioBackend::FakeAudioBackend(FakeBackendSettings settings) : settings_(std::move(settings)) {}

AudioDeviceCapabilities FakeAudioBackend::queryCapabilities(const RequestedConfiguration&) {
    return settings_.capabilities;
}

RuntimeConfiguration FakeAudioBackend::open(const RequestedConfiguration&) {
    if (settings_.failOpen) {
        throw std::runtime_error("Fake backend open failed");
    }
    open_ = true;
    callbackCount_ = 0;
    capturePacketIndex_ = 0;
    capturePosition_ = 0.0;
    renderPosition_ = 0.0;
    return settings_.runtime;
}

void FakeAudioBackend::start(IAudioCallback& callback, GenerationId generation) {
    if (!open_) {
        throw std::logic_error("Fake backend must be open before start");
    }
    if (settings_.failStart) {
        throw std::runtime_error("Fake backend start failed");
    }
    callback_ = &callback;
    lastCallback_ = &callback;
    generation_ = generation;
    lastGeneration_ = generation;
    running_ = true;
}

void FakeAudioBackend::stop() noexcept {
    running_ = false;
    callback_ = nullptr;
}

void FakeAudioBackend::close() noexcept {
    stop();
    open_ = false;
}

BackendSnapshot FakeAudioBackend::snapshot() const noexcept {
    return {open_, running_, 0, xruns_, 0, true};
}

void FakeAudioBackend::pump(std::span<const float> capture, std::uint32_t captureChannels,
                            std::span<float> render, std::uint32_t renderChannels,
                            std::int64_t capturePosition, std::int64_t renderPosition) noexcept {
    if (!running_ || callback_ == nullptr) {
        return;
    }

    const auto captureFrames =
        captureChannels == 0 ? 0U : static_cast<std::uint32_t>(capture.size() / captureChannels);
    const auto renderFrames =
        renderChannels == 0 ? 0U : static_cast<std::uint32_t>(render.size() / renderChannels);
    const auto timestamp = monotonicTicksNow();

    if (captureFrames != 0) {
        callback_->onCapture(generation_, {capture.data(), nullptr, captureFrames, captureChannels,
                                           capturePosition, timestamp, 0});
    }
    if (renderFrames != 0) {
        callback_->onRender(generation_, {nullptr, render.data(), renderFrames, renderChannels,
                                          renderPosition, timestamp, 0});
    }
}

void FakeAudioBackend::pumpConfigured(std::span<const float> capture,
                                      std::span<float> render) noexcept {
    if (!running_ || callback_ == nullptr) {
        return;
    }

    const auto inputChannels = settings_.runtime.inputChannels;
    const auto outputChannels = settings_.runtime.outputChannels;
    const auto availableCaptureFrames = inputChannels == 0 ? 0U : capture.size() / inputChannels;
    const auto availableRenderFrames = outputChannels == 0 ? 0U : render.size() / outputChannels;
    const auto captureFrames = configuredCaptureFrames(availableCaptureFrames);
    const auto renderFrames = static_cast<std::uint32_t>(
        std::min<std::size_t>(settings_.runtime.outputPeriodFrames, availableRenderFrames));
    const auto timestamp = configuredTimestamp();

    if (captureFrames != 0) {
        callback_->onCapture(
            generation_, {capture.data(), nullptr, captureFrames, inputChannels,
                          static_cast<std::int64_t>(std::llround(capturePosition_)), timestamp, 0});
    }
    if (renderFrames != 0) {
        callback_->onRender(generation_, {nullptr, render.data(), renderFrames, outputChannels,
                                          static_cast<std::int64_t>(std::llround(renderPosition_)),
                                          timestamp, 0});
    }

    advanceConfiguredClock(captureFrames, renderFrames);
    ++callbackCount_;
    emitScheduledFault();
}

void FakeAudioBackend::replay(std::span<const FakeBackendReplayStep> steps,
                              std::span<const float> captureScratch,
                              std::span<float> renderScratch) noexcept {
    if (!running_ || callback_ == nullptr)
        return;

    const auto inputChannels = settings_.runtime.inputChannels;
    const auto outputChannels = settings_.runtime.outputChannels;
    for (const auto& step : steps) {
        const auto captureSamples = static_cast<std::size_t>(step.captureFrames) * inputChannels;
        const auto renderSamples = static_cast<std::size_t>(step.renderFrames) * outputChannels;
        if (captureSamples > captureScratch.size() || renderSamples > renderScratch.size()) {
            ++xruns_;
            return;
        }
        if (step.captureFrames != 0) {
            callback_->onCapture(generation_,
                                 {captureScratch.data(), nullptr, step.captureFrames, inputChannels,
                                  step.capturePosition, step.timestamp, 0});
        }
        if (step.renderFrames != 0) {
            callback_->onRender(generation_,
                                {nullptr, renderScratch.data(), step.renderFrames, outputChannels,
                                 step.renderPosition, step.timestamp, 0});
        }
        if (step.event != BackendEventType::None)
            callback_->onBackendEvent(generation_, step.event, step.eventCode);
    }
}

void FakeAudioBackend::inject(BackendEventType event, std::int32_t code) noexcept {
    if (callback_ != nullptr) {
        callback_->onBackendEvent(generation_, event, code);
    }
}

void FakeAudioBackend::injectStaleEvent(BackendEventType event, std::int32_t code) noexcept {
    if (lastCallback_ != nullptr) {
        lastCallback_->onBackendEvent(lastGeneration_, event, code);
    }
}

std::uint32_t FakeAudioBackend::configuredCaptureFrames(std::size_t availableFrames) noexcept {
    auto frames = settings_.runtime.inputPeriodFrames;
    if (!settings_.capturePacketFrames.empty()) {
        frames =
            settings_
                .capturePacketFrames[capturePacketIndex_ % settings_.capturePacketFrames.size()];
        ++capturePacketIndex_;
    }
    return static_cast<std::uint32_t>(std::min<std::size_t>(frames, availableFrames));
}

MonotonicTicks FakeAudioBackend::configuredTimestamp() const noexcept {
    const auto rate = std::max(1U, settings_.runtime.outputSampleRateHz);
    const auto period = std::max(1U, settings_.runtime.outputPeriodFrames);
    const auto periodNs = static_cast<MonotonicTicks>(std::llround(
        static_cast<double>(period) * NanosecondsPerSecond / static_cast<double>(rate)));
    auto timestamp = timestampBase_ + static_cast<MonotonicTicks>(callbackCount_) * periodNs;
    if (!settings_.timestampJitterNs.empty()) {
        timestamp += settings_.timestampJitterNs[static_cast<std::size_t>(
            callbackCount_ % settings_.timestampJitterNs.size())];
    }
    return timestamp;
}

void FakeAudioBackend::advanceConfiguredClock(std::uint32_t captureFrames,
                                              std::uint32_t renderFrames) noexcept {
    capturePosition_ +=
        static_cast<double>(captureFrames) * (1.0 + settings_.captureDriftPpm / PartsPerMillion);
    renderPosition_ +=
        static_cast<double>(renderFrames) * (1.0 + settings_.renderDriftPpm / PartsPerMillion);
}

void FakeAudioBackend::emitScheduledFault() noexcept {
    if (callback_ == nullptr || settings_.scheduledFault == BackendEventType::None ||
        callbackCount_ != settings_.faultAfterCallbacks) {
        return;
    }
    callback_->onBackendEvent(generation_, settings_.scheduledFault, settings_.scheduledFaultCode);
}
