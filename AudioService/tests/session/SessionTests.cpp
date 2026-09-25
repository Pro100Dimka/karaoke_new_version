#include "TestHarness.hpp"
#include "app/AudioService.hpp"
#include "backend/fake/FakeAudioBackend.hpp"
#include "realtime/RealtimeInstrumentation.hpp"

#include <algorithm>
#include <array>
#include <atomic>
#include <cmath>
#include <limits>
#include <memory>
#include <string>
#include <string_view>
#include <thread>
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

void referenceToneStopCannotBeUndoneByAnInFlightRender() {
    FakeBackendSettings settings;
    settings.runtime.inputPeriodFrames = MaxBlockFrames;
    settings.runtime.outputPeriodFrames = MaxBlockFrames;
    AudioService service{std::make_unique<FakeAudioBackend>(settings)};
    service.start();
    (void)service.session().prepare({});
    const auto generation = service.session().generationId();
    std::vector<float> output(MaxBlockFrames * 2);
    bool silent = true;
    for (int attempt = 0; attempt < 100 && silent; ++attempt) {
        service.realtime().playReferenceTone(440.0F, MaxBlockFrames * 16, 0.1F);
        std::atomic<bool> entered{false};
        std::thread render([&] {
            entered.store(true, std::memory_order_release);
            service.realtime().onRender(generation, {nullptr, output.data(), MaxBlockFrames, 2});
        });
        while (!entered.load(std::memory_order_acquire))
            std::this_thread::yield();
        const auto stopAt = std::chrono::steady_clock::now() +
                            std::chrono::microseconds((attempt % 10) * 10);
        while (std::chrono::steady_clock::now() < stopAt)
            std::atomic_signal_fence(std::memory_order_seq_cst);
        service.realtime().playReferenceTone(440.0F, 0, 0.1F);
        render.join();
        service.realtime().onRender(generation, {nullptr, output.data(), 128, 2});
        silent = std::all_of(output.begin(), output.begin() + 256,
                             [](float sample) { return sample == 0.0F; });
    }
    expect(silent, "an in-flight tone cannot underflow its duration and undo a stop command");
}

void referenceToneRejectsNonFiniteParameters() {
    RunningService fixture;
    std::vector<float> output(256);
    const auto invalid = std::numeric_limits<float>::quiet_NaN();
    for (const auto parameters : {std::array{invalid, 0.1F}, std::array{440.0F, invalid}}) {
        fixture.service.realtime().playReferenceTone(parameters[0], 128, parameters[1]);
        fixture.service.realtime().onRender(fixture.service.session().generationId(),
                                            {nullptr, output.data(), 128, 2});
        expect(std::all_of(output.begin(), output.end(),
                           [](float sample) { return std::isfinite(sample); }),
               "invalid diagnostic tone parameters must never contaminate output PCM");
    }
}

void invalidNumericControlCannotMutateRuntimeState() {
    RunningService fixture;
    const auto generation = fixture.service.session().generationId();
    for (const auto value : {"nan", "inf", "-inf", "junk", "1.0junk"}) {
        const auto response =
            fixture.service.handleLine("1|SetGain|target=master|value=" + std::string(value));
        expect(response.status == ControlStatus::InvalidRequest &&
                   fixture.service.realtime().mixerGains().master == 1.0F,
               "invalid numeric input is rejected without poisoning mixer state");
    }
    for (const auto field : {"rate", "period", "inChannels", "outChannels"}) {
        const auto response = fixture.service.handleLine("1|Reconfigure|backend=fake|" +
                                                         std::string(field) + "=4294967296");
        expect(response.status == ControlStatus::InvalidRequest &&
                   fixture.service.session().generationId() == generation,
               "oversized device values must not wrap or restart a valid session");
    }
    for (const auto arguments : {"localPort=65536|voiceToken=1", "localPort=0|voiceToken=0"}) {
        const auto response = fixture.service.handleLine(
            "1|JoinMediaSession|localParticipantId=self|" + std::string(arguments));
        expect(response.status == ControlStatus::InvalidRequest &&
                   !fixture.service.network().sharedTimelineEnabled(),
               "invalid room endpoint or token is rejected before mutating the media session");
    }
}

void previewTransportCommandsDoNotFallThrough() {
    RunningService fixture;
    const auto path = tempRoot / "context-transport.wav";
    makeTestWav(path, 9600);
    const std::array contexts{
        std::pair{"preview", MediaSlot::Preview},
        std::pair{"recording", MediaSlot::RecordingPreview},
        std::pair{"radio", MediaSlot::Radio},
    };
    for (const auto& [context, slot] : contexts) {
        fixture.service.media().load(slot, path.string());
        expect(fixture.service.media().waitUntilReady(slot) == PlaybackState::Ready,
               "preview source becomes ready");
        const auto seek =
            fixture.service.handleLine("1|Seek|context=" + std::string(context) + "|frame=1200");
        const auto stop = fixture.service.handleLine("1|Stop|context=" + std::string(context));
        expect(seek.status == ControlStatus::Ok && seek.text == "Seeked",
               "non-karaoke seek returns without applying another command");
        expect(stop.status == ControlStatus::Ok && stop.text == "Stopped",
               "non-karaoke stop returns without falling through to seek or rate changes");
    }
}

void loadingSongWithoutCompanionsUnloadsThePreviousStems() {
    RunningService fixture;
    const auto path = tempRoot / "old-companion.wav";
    makeTestWav(path, 9600);
    const auto source = path.string();
    expect(fixture.service
                   .handleLine("1|LoadSong|instrumental=" + source + "|vocals=" + source +
                               "|melody=" + source)
                   .status == ControlStatus::Ok,
           "first song loads all companions");
    for (const auto slot : {MediaSlot::Music, MediaSlot::ReferenceVocal, MediaSlot::Melody})
        (void)fixture.service.media().waitUntilReady(slot);
    expect(fixture.service.handleLine("1|LoadSong|instrumental=" + source).status ==
               ControlStatus::Ok,
           "next song loads with no companions");
    expect(fixture.service.media().snapshot(MediaSlot::ReferenceVocal).state ==
                   PlaybackState::Empty &&
               fixture.service.media().snapshot(MediaSlot::Melody).state == PlaybackState::Empty,
           "new song cannot play the previous song's vocal or melody");
}

void recordingControlExposesAuthoritativeGapMetadata() {
    RunningService fixture;
    auto& recording = fixture.service.recording();
    const auto path = tempRoot / "recording-metadata.wav";
    recording.prepare("metadata", path.string(), 44100, 1, RecordingTap::MasterMix, 8);
    recording.start(SessionFrame{100}, 2205);
    recording.push(fixture.service.session().generationId(), RecordingTap::MasterMix,
                   SessionFrame{100}, std::vector<float>(16, 0.1F), 16);
    const auto result = recording.stop(SessionFrame{116});
    expect(result.overrunCount == 1 && result.gaps.size() == 1,
           "metadata fixture creates a real PCM queue overrun");
    const auto response = fixture.service.handleLine("1|GetRecordingState|details=true");
    for (const auto text : {"\"sampleRate\":44100", "\"channels\":1", "\"durationFrames\":16",
                            "\"startSessionFrame\":100", "\"startPlaybackPosition\":2205",
                            "\"overrunCount\":1", "\"startFrame\":100", "\"frameCount\":16"}) {
        expect(response.status == ControlStatus::Ok &&
                   response.text.find(text) != std::string::npos,
               std::string("recording IPC preserves native metadata: ") + text);
    }
}

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

void runtimeConfigurationRejectsUnsupportedDimensions() {
    struct Dimension { std::uint32_t RuntimeConfiguration::*member; std::uint32_t maximum; };
    const std::array dimensions{
        Dimension{&RuntimeConfiguration::inputChannels, MaxAudioChannels},
        Dimension{&RuntimeConfiguration::outputChannels, MaxAudioChannels},
    };
    for (const auto& dimension : dimensions) {
        FakeBackendSettings settings;
        settings.runtime.*dimension.member = dimension.maximum + 1;
        AudioService service{std::make_unique<FakeAudioBackend>(settings)};
        service.start();
        bool rejected = false;
        try { (void)service.session().prepare({}); } catch (const std::exception&) { rejected = true; }
        expect(rejected && service.session().state() == SessionState::Failed,
               "Runtime dimensions beyond bounded DSP capacity must fail before starting callbacks");
    }
}

void runtimePlanAccountsForEndpointPackets() {
    FakeBackendSettings settings;
    settings.runtime.inputEndpointBufferFrames = 2048;
    settings.runtime.outputEndpointBufferFrames = 2048;
    AudioService service{std::make_unique<FakeAudioBackend>(settings)};
    service.start(); (void)service.session().prepare({});
    expect(service.session().plan().maximumBlockFrames >= 2048,
           "Endpoint packets may exceed a nominal period and must fit the realtime storage");
}

void runtimeRejectsUnsupportedSampleFormats() {
    const std::array members{&RuntimeConfiguration::inputFormat, &RuntimeConfiguration::outputFormat};
    for (const auto member : members) {
        FakeBackendSettings settings;
        settings.runtime.*member = AudioSampleFormat::Unknown;
        AudioService service{std::make_unique<FakeAudioBackend>(settings)};
        service.start();
        bool rejected = false;
        try { (void)service.session().prepare({}); } catch (const std::exception&) { rejected = true; }
        expect(rejected, "Unsupported runtime PCM must fail explicitly instead of producing silence");
    }
}

void runtimePlanRejectsCapacityOverflow() {
    FakeBackendSettings settings;
    settings.runtime.inputPeriodFrames = 1U << 29U;
    AudioService service{std::make_unique<FakeAudioBackend>(settings)};
    service.start();
    bool rejected = false;
    try { (void)service.session().prepare({}); } catch (const std::exception&) { rejected = true; }
    expect(rejected, "A driver-reported period must not wrap the clock bridge capacity");
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
