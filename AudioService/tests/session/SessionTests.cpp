#include "TestHarness.hpp"
#include "app/AudioService.hpp"
#include "backend/fake/FakeAudioBackend.hpp"
#include "realtime/RealtimeInstrumentation.hpp"

#include <algorithm>
#include <array>
#include <cmath>
#include <memory>
#include <string>
#include <string_view>
#include <vector>

namespace Tests {
namespace {
struct RunningService {
    RunningService()
        : backend(std::make_unique<FakeAudioBackend>()), fake(backend.get()),
          service(std::move(backend)) {
        service.start();
        service.session().prepare(RequestedConfiguration{});
        service.session().start();
    }

    std::unique_ptr<FakeAudioBackend> backend;
    FakeAudioBackend* fake;
    AudioService service;
};
} // namespace

void runtimeConfigurationComesFromBackend() {
    auto backend = std::make_unique<FakeAudioBackend>();
    AudioService service{std::move(backend)};
    service.start();
    const auto runtime = service.session().prepare(RequestedConfiguration{});
    expect(runtime.outputSampleRateHz == 48000, "runtime configuration comes from opened backend");
}

void renderTimelineAdvancesInFrames() {
    RunningService fixture;
    std::vector<float> capture(256, 0.2F), render(256);
    fixture.fake->pump(capture, 1, render, 2, 0, 0);
    expect(fixture.service.realtime().sessionFrame() == SessionFrame{128},
           "render timeline advances in frames");
}

void bareMonitoringReachesOutput() {
    RunningService fixture;
    fixture.service.realtime().setMonitoring(true);
    std::vector<float> capture(256, 0.2F), render(256);
    fixture.fake->pump(capture, 1, render, 2, 0, 0);
    expect(render.front() != 0.0F, "bare monitoring reaches output");
}

void leftOnlyMicrophoneIsHeardInBothSpeakers() {
    RunningService fixture;
    fixture.service.realtime().setMonitoring(true);
    constexpr std::size_t Frames = 128;
    std::vector<float> capture(Frames * 2U, 0.0F), render(Frames * 2U, 0.0F);
    for (std::size_t frame = 0; frame < Frames; ++frame)
        capture[frame * 2U] = 0.4F; // stereo input, the microphone is wired to the left channel only
    for (int block = 0; block < 32; ++block)
        fixture.fake->pump(capture, 2, render, 2, 0, 0);
    const auto left = render[Frames], right = render[Frames + 1U];
    expect(left > 0.01F, "left-only microphone is audible");
    expect(std::abs(left - right) < 1.0e-4F, "left-only microphone is heard equally in both speakers");
}

void realtimeCallbackHasNoHardRtViolations() {
    RunningService fixture;
    fixture.service.realtime().setMonitoring(true);
    std::vector<float> capture(256, 0.2F), render(256);
    RealtimeInstrumentation::reset();
    fixture.fake->pump(capture, 1, render, 2, 0, 0);
    const auto violations = RealtimeInstrumentation::snapshot();
    const std::array counters{violations.allocations,    violations.deallocations,
                              violations.blockingCalls,  violations.diskIoCalls,
                              violations.networkIoCalls, violations.ipcCalls};
    expect(std::ranges::all_of(counters, [](std::uint64_t count) { return count == 0; }),
           "realtime callback has no allocation, free, blocking or I/O violations");
}

void deviceLossRecoversWithNewGeneration() {
    RunningService fixture;
    const auto beforeLoss = fixture.service.session().generationId();
    fixture.fake->inject(BackendEventType::DeviceLost, -1);
    const auto diagnostics = fixture.service.handleLine("1|GetDiagnostics");
    expect(diagnostics.status == ControlStatus::Ok,
           "diagnostics remains available after device loss");
    expect(fixture.service.session().state() == SessionState::Running &&
               fixture.service.session().generationId() > beforeLoss,
           "device loss uses recovery and new generation");
}

void deviceLossCapturesFailureSnapshot() {
    RunningService fixture;
    const auto failedGeneration = fixture.service.session().generationId();
    fixture.fake->inject(BackendEventType::DeviceLost, -17);

    const auto response = fixture.service.handleLine("1|GetDiagnostics");
    const std::string_view diagnostics{response.text};
    const auto generationText =
        std::string{"FailureGenerationId: "} + std::to_string(failedGeneration.value());

    expect(diagnostics.find("LastFailureCategory: Device") != std::string_view::npos &&
               diagnostics.find("LastFailureSeverity: SessionFatal") != std::string_view::npos &&
               diagnostics.find(generationText) != std::string_view::npos,
           "device loss captures bounded failure snapshot before recovery");
}

void stopInvalidatesGeneration() {
    RunningService fixture;
    const auto beforeStop = fixture.service.session().generationId();
    fixture.service.session().stop();
    expect(fixture.service.session().state() == SessionState::Idle &&
               fixture.service.session().generationId() > beforeStop,
           "stop invalidates generation");
}

void sessionLifecycleIsExposedThroughIpc() {
    auto backend = std::make_unique<FakeAudioBackend>();
    AudioService service{std::move(backend)};
    service.start();
    expect(service.handleLine("1|PrepareSession|backend=fake|rate=44100|period=128").status ==
               ControlStatus::Ok,
           "session can be prepared through IPC");
    expect(service.handleLine("1|SuspendSession").status == ControlStatus::Ok,
           "suspend lifecycle exposed");
    expect(service.handleLine("1|ResumeSession").status == ControlStatus::Ok,
           "resume lifecycle exposed");
}
} // namespace Tests
