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

void unsupportedRateUsesSystemDefault() {
    FakeBackendSettings settings;
    settings.capabilities.sampleRatesHz = {44100, 48000};
    settings.capabilities.defaultSampleRateHz = 48000;
    auto backend = std::make_unique<FakeAudioBackend>(settings);
    AudioService service{std::move(backend)};
    service.start();
    RequestedConfiguration requested;
    requested.sampleRateHz = 46000;
    service.session().prepare(requested);
    expect(service.session().requested().sampleRateHz == 48000,
           "an unsupported requested rate falls back to the system device format");
}

void unspecifiedFormatUsesSystemDefaults() {
    FakeBackendSettings settings;
    settings.capabilities.sampleRatesHz = {44100, 48000};
    settings.capabilities.defaultSampleRateHz = 44100;
    settings.capabilities.minPeriodFrames = 96;
    settings.capabilities.maxPeriodFrames = 960;
    settings.capabilities.defaultPeriodFrames = 441;
    auto backend = std::make_unique<FakeAudioBackend>(settings);
    AudioService service{std::move(backend)};
    service.start();
    RequestedConfiguration requested;
    requested.sampleRateHz = 0;
    requested.periodFrames = 0;
    service.session().prepare(requested);
    expect(service.session().requested().sampleRateHz == 44100,
           "an unspecified rate uses the system device format");
    expect(service.session().requested().periodFrames == 441,
           "an unspecified buffer uses the device default period");
}

void unspecifiedChannelsStayWithinRealtimeEngineCapacity() {
    FakeBackendSettings settings;
    settings.capabilities.inputChannels = MaxAudioChannels + 4;
    settings.capabilities.outputChannels = 2;
    auto backend = std::make_unique<FakeAudioBackend>(settings);
    AudioService service{std::move(backend)};
    service.start();

    service.session().prepare(RequestedConfiguration{});

    expect(service.session().requested().inputChannels == MaxAudioChannels,
           "driver-owned channel selection is capped to the realtime engine capacity");
}

void productionAudioConfigurationDoesNotInventDeviceDefaults() {
    const AudioDeviceCapabilities capabilities;
    const RequestedConfiguration requested;
    const std::array values{
        capabilities.defaultSampleRateHz,
        capabilities.minPeriodFrames,
        capabilities.maxPeriodFrames,
        capabilities.defaultPeriodFrames,
        capabilities.fundamentalPeriodFrames,
        capabilities.inputChannels,
        capabilities.outputChannels,
        requested.sampleRateHz,
        requested.periodFrames,
        requested.inputChannels,
        requested.outputChannels,
    };
    expect(std::ranges::all_of(values, [](const auto value) { return value == 0; }) &&
               capabilities.sampleRatesHz.empty() && capabilities.formats.empty() &&
               capabilities.periodFrames.empty(),
           "production audio configuration leaves device-owned values unspecified");
}

void emptyDeviceCapabilitiesAreRejectedBeforeOpening() {
    FakeBackendSettings settings;
    settings.capabilities = {};
    auto backend = std::make_unique<FakeAudioBackend>(settings);
    AudioService service(std::move(backend));
    bool rejected = false;
    try {
        (void)service.session().prepare({});
    } catch (const std::exception&) {
        rejected = true;
    }
    expect(rejected && service.session().state() == SessionState::Failed,
           "a backend cannot silently replace missing system capabilities with invented values");
}

void ipcExposesSelectedDeviceCapabilities() {
    auto backend = std::make_unique<FakeAudioBackend>();
    AudioService service{std::move(backend)};
    service.start();
    const auto response = service.handleLine(
        "1|GetAudioCapabilities|backend=fake|rate=0|period=0");
    expect(response.status == ControlStatus::Ok,
           "selected device capabilities are available through IPC");
    expect(response.text.find("defaultSampleRateHz=48000") != std::string::npos &&
               response.text.find("defaultPeriodFrames=480") != std::string::npos,
           "capability response contains system defaults");
}

void ipcReusesActiveSessionCapabilities() {
    FakeBackendSettings settings;
    settings.capabilities.sampleRatesHz = {96000};
    settings.capabilities.defaultSampleRateHz = 96000;
    settings.capabilities.defaultPeriodFrames = 512;
    settings.runtime.inputSampleRateHz = 96000;
    settings.runtime.outputSampleRateHz = 96000;
    auto backend = std::make_unique<FakeAudioBackend>(settings);
    AudioService service{std::move(backend)};
    service.start();
    service.session().prepare(RequestedConfiguration{});
    service.session().start();

    const auto response = service.handleLine(
        "1|GetAudioCapabilities|backend=fake|rate=0|period=0");
    expect(response.status == ControlStatus::Ok,
           "capabilities remain readable while an audio session is running");
    expect(response.text.find("defaultSampleRateHz=96000") != std::string::npos &&
               response.text.find("defaultPeriodFrames=512") != std::string::npos,
           "a running session reuses its cached device capabilities instead of opening a second driver");
}

void systemDefaultFormatChangeRequiresRecovery() {
    RequestedConfiguration requested;
    requested.inputDeviceId.clear();
    requested.outputDeviceId.clear();
    const DeviceEvent event{DeviceEventType::FormatChanged, Direction::Output, "new-default",
                            GenerationId{1}};
    expect(deviceEventRequiresRecovery(event, requested),
           "a format change on the system-default endpoint rebuilds the active session");
}

void unrelatedDevicePropertyDoesNotRestartAudioSession() {
    RequestedConfiguration requested;
    requested.inputDeviceId.clear();
    requested.outputDeviceId.clear();
    const DeviceEvent event{DeviceEventType::PropertyChanged, Direction::Output, "default-device",
                            GenerationId{1}};
    expect(!deviceEventRequiresRecovery(event, requested),
           "an unrelated endpoint property notification must not restart a healthy audio session");
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

void oppositePolarityAsioPairDoesNotCancelMicrophone() {
    RunningService fixture;
    fixture.service.realtime().setMonitoring(true);
    constexpr std::size_t Frames = 128;
    std::vector<float> capture(Frames * 2U), render(Frames * 2U, 0.0F);
    for (std::size_t frame = 0; frame < Frames; ++frame) {
        capture[frame * 2U] = 0.35F;
        capture[frame * 2U + 1U] = -0.35F;
    }
    for (int block = 0; block < 32; ++block)
        fixture.fake->pump(capture, 2, render, 2, 0, 0);
    expect(std::abs(render[Frames]) > 0.1F,
           "an opposite-polarity ASIO input pair keeps one microphone channel instead of cancelling it");
    expect(std::abs(render[Frames] - render[Frames + 1U]) < 1.0e-4F,
           "the selected ASIO microphone channel is centred in the output");
}

// Energy of the monitored voice after the input has gone silent: only an effect tail can still be heard.
float monitoredTailEnergy(bool effectOn, bool effectsFirst = false) {
    RunningService fixture;
    if (!effectsFirst)
        fixture.service.realtime().setMonitoring(true);
    if (effectOn) {
        fixture.service.realtime().setDspEnabled(true);
        (void)fixture.service.realtime().setDspParameter("delay.mix", 0.8F);
        (void)fixture.service.realtime().setDspParameter("delay.ms", 5.0F);
        (void)fixture.service.realtime().setDspParameter("reverb.mix", 0.8F);
    }
    if (effectsFirst)
        fixture.service.realtime().setMonitoring(true);
    constexpr std::size_t Frames = 128;
    std::vector<float> loud(Frames, 0.4F), silent(Frames, 0.0F), render(Frames * 2U, 0.0F);
    for (int block = 0; block < 8; ++block)
        fixture.fake->pump(loud, 1, render, 2, 0, 0);
    for (int block = 0; block < 4; ++block)
        fixture.fake->pump(silent, 1, render, 2, 0, 0);
    float energy = 0.0F;
    for (int block = 0; block < 8; ++block) {
        fixture.fake->pump(silent, 1, render, 2, 0, 0);
        for (const float sample : render)
            energy += sample * sample;
    }
    return energy;
}

void voiceEffectsAreAudibleInMonitoring() {
    const auto clean = monitoredTailEnergy(false);
    const auto processed = monitoredTailEnergy(true);
    expect(clean < 1.0e-6F, "clean monitoring has no tail after the input stops");
    expect(processed > 1.0e-4F, "echo and reverb are audible in monitoring");
    expect(monitoredTailEnergy(true, true) > 1.0e-4F, "effects set before monitoring is switched on are audible too");
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

void diagnosticsExposeRemoteParticipantLevels() {
    RunningService fixture;
    expect(fixture.service.handleLine("1|AddRemoteParticipant|participantId=guest-1").status ==
               ControlStatus::Ok,
           "remote participant can be registered for diagnostics");

    const auto diagnostics = fixture.service.handleLine("1|GetDiagnostics").text;
    expect(diagnostics.find("RemoteLevel.guest-1: 0") != std::string::npos,
           "diagnostics expose the participant level used by the room dock");
    expect(diagnostics.find("RemoteClockOffsetMs.guest-1:") != std::string::npos &&
               diagnostics.find("RemoteClockDriftPpm.guest-1:") != std::string::npos &&
               diagnostics.find("RemoteAlignmentDelayFrames.guest-1:") != std::string::npos &&
               diagnostics.find("RemoteLatePackets.guest-1:") != std::string::npos &&
               diagnostics.find("RemoteInterPeerAlignmentErrorFrames.guest-1:") !=
                   std::string::npos,
           "diagnostics expose clock, late-packet and sample-alignment metrics per participant");
}
} // namespace Tests
