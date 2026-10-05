#include "TestHarness.hpp"
#include "backend/fake/FakeAudioBackend.hpp"

#include <array>
#include <vector>

namespace Tests {
namespace {
class CallbackProbe final : public IAudioCallback {
  public:
    void onCapture(GenerationId generation, const BackendAudioBuffer& buffer) noexcept override {
        captureGenerations.push_back(generation);
        captureFrames.push_back(buffer.frames);
        capturePositions.push_back(buffer.devicePosition);
        captureTimestamps.push_back(buffer.timestamp);
    }

    void onRender(GenerationId generation, const BackendAudioBuffer& buffer) noexcept override {
        renderGenerations.push_back(generation);
        renderPositions.push_back(buffer.devicePosition);
        if (writeOutput && buffer.output != nullptr)
            std::fill_n(buffer.output, static_cast<std::size_t>(buffer.frames) * buffer.channels,
                        0.25F);
    }

    void onBackendEvent(GenerationId generation, BackendEventType event,
                        std::int32_t code) noexcept override {
        eventGenerations.push_back(generation);
        events.push_back(event);
        eventCodes.push_back(code);
    }

    std::vector<GenerationId> captureGenerations;
    std::vector<GenerationId> renderGenerations;
    std::vector<GenerationId> eventGenerations;
    std::vector<std::uint32_t> captureFrames;
    std::vector<std::int64_t> capturePositions;
    std::vector<std::int64_t> renderPositions;
    std::vector<MonotonicTicks> captureTimestamps;
    std::vector<BackendEventType> events;
    std::vector<std::int32_t> eventCodes;
    bool writeOutput{false};
};

struct OpenFake {
    explicit OpenFake(FakeBackendSettings settings) : backend(std::move(settings)) {
        (void)backend.open(RequestedConfiguration{});
        backend.start(callback, GenerationId{7});
    }

    CallbackProbe callback;
    FakeAudioBackend backend;
};
} // namespace

void fakeBackendUsesConfiguredPacketPattern() {
    FakeBackendSettings settings;
    settings.runtime.inputChannels = 1;
    settings.runtime.outputChannels = 2;
    settings.capturePacketFrames = {144, 96, 72};
    OpenFake fixture{settings};
    std::vector<float> capture(256, 0.1F);
    std::vector<float> render(512);

    for (int iteration = 0; iteration < 3; ++iteration) {
        fixture.backend.pumpConfigured(capture, render);
    }

    expect(fixture.callback.captureFrames == std::vector<std::uint32_t>({144, 96, 72}),
           "fake backend reproduces configured variable capture packet sizes");
}

void fakeBackendAppliesConfiguredDrift() {
    FakeBackendSettings settings;
    settings.runtime.inputChannels = 1;
    settings.runtime.outputChannels = 2;
    settings.runtime.inputPeriodFrames = 128;
    settings.runtime.outputPeriodFrames = 128;
    settings.captureDriftPpm = 10'000.0;
    OpenFake fixture{settings};
    std::vector<float> capture(128, 0.1F);
    std::vector<float> render(256);

    for (int iteration = 0; iteration < 4; ++iteration) {
        fixture.backend.pumpConfigured(capture, render);
    }

    expect(fixture.callback.capturePositions.back() > fixture.callback.renderPositions.back(),
           "fake backend drift changes capture position relative to render clock");
}

void fakeBackendAppliesTimestampJitter() {
    FakeBackendSettings settings;
    settings.runtime.inputChannels = 1;
    settings.runtime.outputChannels = 2;
    settings.timestampJitterNs = {0, 50'000, -25'000};
    OpenFake fixture{settings};
    std::vector<float> capture(128, 0.1F);
    std::vector<float> render(256);

    for (int iteration = 0; iteration < 3; ++iteration) {
        fixture.backend.pumpConfigured(capture, render);
    }

    const auto firstStep =
        fixture.callback.captureTimestamps[1] - fixture.callback.captureTimestamps[0];
    const auto secondStep =
        fixture.callback.captureTimestamps[2] - fixture.callback.captureTimestamps[1];
    expect(firstStep != secondStep,
           "fake backend timestamp jitter is independent from deterministic positions");
}

void fakeBackendEmitsScheduledFault() {
    FakeBackendSettings settings;
    settings.runtime.inputChannels = 1;
    settings.runtime.outputChannels = 2;
    settings.faultAfterCallbacks = 2;
    settings.scheduledFault = BackendEventType::DeviceLost;
    settings.scheduledFaultCode = -42;
    OpenFake fixture{settings};
    std::vector<float> capture(128, 0.1F);
    std::vector<float> render(256);

    fixture.backend.pumpConfigured(capture, render);
    fixture.backend.pumpConfigured(capture, render);

    expect(fixture.callback.events == std::vector<BackendEventType>{BackendEventType::DeviceLost} &&
               fixture.callback.eventCodes == std::vector<std::int32_t>{-42},
           "fake backend emits the scheduled fault at the configured callback");
}

void fakeBackendCanReproduceStaleCallbackAfterStop() {
    FakeBackendSettings settings;
    OpenFake fixture{settings};
    fixture.backend.stop();
    fixture.backend.injectStaleEvent(BackendEventType::DriverReset, 9);

    expect(fixture.callback.eventGenerations == std::vector<GenerationId>{GenerationId{7}} &&
               fixture.callback.events ==
                   std::vector<BackendEventType>{BackendEventType::DriverReset},
           "fake backend can reproduce a callback from the stopped generation");
}

void fakeBackendResetsOutputEvidenceForEveryDeviceSession() {
    FakeBackendSettings settings;
    settings.runtime.outputChannels = 2;
    settings.runtime.outputPeriodFrames = 128;
    OpenFake fixture{settings};
    fixture.callback.writeOutput = true;
    std::vector<float> render(256);
    fixture.backend.pump({}, 0, render, 2, 0, 0);
    expect(fixture.backend.snapshot().outputNonzeroBlocks == 1,
           "the first device session records submitted nonzero PCM");

    fixture.backend.stop();
    fixture.backend.close();
    (void)fixture.backend.open(RequestedConfiguration{});
    fixture.backend.start(fixture.callback, GenerationId{8});

    expect(fixture.backend.snapshot().outputNonzeroBlocks == 0 &&
               fixture.backend.snapshot().outputPeak == 0.0F,
           "backend recreation starts a bounded before/after PCM evidence window");
}
void fakeBackendReplaysTimingTraceWithoutPcmStorage() {
    FakeBackendSettings settings;
    settings.runtime.inputChannels = 1;
    settings.runtime.outputChannels = 2;
    OpenFake fixture{settings};
    std::vector<float> capture(256, 0.1F);
    std::vector<float> render(512);
    constexpr std::array trace{
        FakeBackendReplayStep{128, 128, 0, 0, 1'000'000, BackendEventType::None, 0},
        FakeBackendReplayStep{96, 128, 128, 128, 2'000'000, BackendEventType::DataDiscontinuity, 3},
    };

    fixture.backend.replay(trace, capture, render);

    expect(fixture.callback.captureFrames == std::vector<std::uint32_t>({128, 96}) &&
               fixture.callback.capturePositions == std::vector<std::int64_t>({0, 128}) &&
               fixture.callback.captureTimestamps ==
                   std::vector<MonotonicTicks>({1'000'000, 2'000'000}) &&
               fixture.callback.events ==
                   std::vector<BackendEventType>{BackendEventType::DataDiscontinuity},
           "fake backend replays timing and event trace without stored PCM");
}

} // namespace Tests
