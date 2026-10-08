#include "app/AudioService.hpp"

#include <algorithm>
#include <array>
#include <charconv>
#include <cmath>
#include <ranges>
#include <sstream>
#include <stdexcept>

namespace {
std::string playbackStateText(PlaybackState state) {
    return std::to_string(static_cast<int>(state));
}

std::string_view failureCategoryName(FailureCategory category) noexcept {
    constexpr std::array names{std::string_view{"None"},     std::string_view{"Configuration"},
                               std::string_view{"Backend"},  std::string_view{"Device"},
                               std::string_view{"Realtime"}, std::string_view{"Recording"},
                               std::string_view{"Network"},  std::string_view{"Dsp"},
                               std::string_view{"Ipc"},      std::string_view{"Media"},
                               std::string_view{"Unknown"}};
    const auto index = static_cast<std::size_t>(category);
    return index < names.size() ? names[index] : std::string_view{"Unknown"};
}

std::string_view failureSeverityName(FailureSeverity severity) noexcept {
    constexpr std::array names{std::string_view{"Recoverable"}, std::string_view{"SessionFatal"},
                               std::string_view{"ServiceFatal"}};
    const auto index = static_cast<std::size_t>(severity);
    return index < names.size() ? names[index] : std::string_view{"ServiceFatal"};
}

std::string_view backendEventName(BackendEventType event) noexcept {
    constexpr std::array names{std::string_view{"None"},
                               std::string_view{"DeviceLost"},
                               std::string_view{"DeviceInvalidated"},
                               std::string_view{"DataDiscontinuity"},
                               std::string_view{"TimestampError"},
                               std::string_view{"CaptureOverrun"},
                               std::string_view{"RenderUnderrun"},
                               std::string_view{"DriverReset"},
                               std::string_view{"SampleRateChanged"}};
    const auto index = static_cast<std::size_t>(event);
    return index < names.size() ? names[index] : std::string_view{"UnknownBackendEvent"};
}

/**
 * This listener's return requirement for the room timing policy: the 99th percentile of the
 * server mix's return route, reported only after the calibration window so the room never picks a
 * deadline from the first few packets. Until then only the calibration progress is reported.
 */
std::string roomReturnRequirement(const NetworkDiagnostics& net) {
    const auto mix = std::ranges::find(net.participants, std::string_view{"__room_server_mix__"},
                                       &RemoteParticipantDiagnostics::participantId);
    if (mix == net.participants.end())
        return {};
    std::ostringstream out;
    out << "RoomReturnCalibrationSamples: " << mix->returnSamples << '\n';
    if (mix->returnSamples >= room_audio_contract::ReturnCalibrationPackets)
        out << "RoomReturnRequirementFrames: " << mix->returnRequirementFrames << '\n';
    out << "RoomArrivalCalibrationSamples: " << mix->arrivalSamples << '\n';
    if (mix->arrivalSamples >= room_audio_contract::ReturnCalibrationPackets)
        out << "RoomArrivalRequirementFrames: " << mix->arrivalRequirementFrames << '\n';
    return out.str();
}
} // namespace

bool deviceEventRequiresRecovery(const DeviceEvent& event,
                                 const RequestedConfiguration& requested) noexcept {
    const auto selected =
        event.deviceId == requested.inputDeviceId || event.deviceId == requested.outputDeviceId;
    const auto followsSystemDefault =
        requested.inputDeviceId.empty() || requested.outputDeviceId.empty();
    const auto defaultAffected =
        event.type == DeviceEventType::DefaultChanged &&
        ((event.direction == Direction::Input && requested.inputDeviceId.empty()) ||
         (event.direction == Direction::Output && requested.outputDeviceId.empty()));
    constexpr std::array disruptiveEvents{DeviceEventType::Removed, DeviceEventType::Disabled,
                                          DeviceEventType::FormatChanged};
    const auto selectedDeviceDisrupted =
        selected && std::ranges::find(disruptiveEvents, event.type) != disruptiveEvents.end();
    // IMMNotificationClient does not tell us the data flow for a format notification. If either
    // endpoint follows the Windows default, re-querying both is the only reliable way to pick up a
    // changed native format without retaining stale rate/period values.
    const auto defaultFormatChanged =
        event.type == DeviceEventType::FormatChanged && followsSystemDefault;
    return selectedDeviceDisrupted || defaultAffected || defaultFormatChanged;
}

std::string_view AudioService::serviceStateName(ServiceState state) noexcept {
    constexpr std::array names{std::string_view{"Starting"}, std::string_view{"Running"},
                               std::string_view{"Stopping"}, std::string_view{"Stopped"},
                               std::string_view{"Failed"}};
    static_assert(names.size() == static_cast<std::size_t>(ServiceState::Count));
    const auto i = static_cast<std::size_t>(state);
    return i < names.size() ? names[i] : std::string_view{"Unknown"};
}

AudioService::AudioService(std::unique_ptr<IAudioBackend> backend)
    : realtime_(media_, recording_, analysis_, network_, signal_, latency_, graphInfo_, trace_),
      session_(std::move(backend), realtime_, trace_) {}
void AudioService::start() noexcept {
    if (state_ == ServiceState::Starting) {
        (void)devices_.startNotifications();
        syncDeviceGeneration();
        state_ = ServiceState::Running;
    }
}
void AudioService::shutdown() noexcept {
    state_ = ServiceState::Stopping;
    devices_.stopNotifications();
    network_.stop();
    session_.stop();
    syncDeviceGeneration();
    state_ = ServiceState::Stopped;
    shutdownRequested_.store(true, std::memory_order_release);
}
float AudioService::floatValue(std::string_view value, float fallback) {
    if (value.empty())
        return fallback;
    float parsed = fallback;
    const auto [end, error] = std::from_chars(value.data(), value.data() + value.size(), parsed);
    if (error != std::errc{} || end != value.data() + value.size() || !std::isfinite(parsed))
        throw std::invalid_argument("Expected a finite numeric value");
    return parsed;
}
std::uint64_t AudioService::uint64Value(std::string_view value, std::uint64_t fallback,
                                        std::uint64_t maximum) {
    std::uint64_t out = fallback;
    if (!value.empty()) {
        const auto [p, e] = std::from_chars(value.data(), value.data() + value.size(), out);
        if (e != std::errc{} || p != value.data() + value.size() || out > maximum)
            throw std::invalid_argument("Unsigned numeric value is invalid or out of range");
    }
    return out;
}
std::uint64_t AudioService::hexUint64Value(std::string_view value, std::uint64_t fallback) {
    std::uint64_t out = fallback;
    if (!value.empty()) {
        const auto [p, e] = std::from_chars(value.data(), value.data() + value.size(), out, 16);
        if (e != std::errc{} || p != value.data() + value.size())
            return fallback;
    }
    return out;
}
bool AudioService::boolValue(std::string_view value, bool fallback) {
    constexpr std::array trueValues{std::string_view{"1"}, std::string_view{"true"},
                                    std::string_view{"on"}};
    constexpr std::array falseValues{std::string_view{"0"}, std::string_view{"false"},
                                     std::string_view{"off"}};
    if (std::ranges::find(trueValues, value) != trueValues.end())
        return true;
    if (std::ranges::find(falseValues, value) != falseValues.end())
        return false;
    return fallback;
}
// Driver-reported stream latency already includes endpoint buffering. A period is only a fallback
// when a driver provides no estimate; capture counts must first be converted to the output clock.
// Once rendering starts, a backend that reports presentation time replaces the output estimate
// with a measurement.
void AudioService::publishDeviceLatency() noexcept {
    const auto& runtime = session_.runtime();
    const auto captureLatency =
        runtime.inputChannels == 0
            ? 0
            : LatencyRegistry::convertFrames(runtime.inputLatencyFrames ? runtime.inputLatencyFrames
                                                                        : runtime.inputPeriodFrames,
                                             runtime.inputSampleRateHz, runtime.outputSampleRateHz);
    latency_.set(LatencyRegistry::Stage::Capture, 0, 0, captureLatency);
    latency_.set(LatencyRegistry::Stage::OutputDriver, 0, 0,
                 runtime.outputLatencyFrames ? runtime.outputLatencyFrames
                                             : runtime.outputPeriodFrames);
}
RequestedConfiguration AudioService::requestFromControl(const ControlRequest& request) const {
    RequestedConfiguration out;
#ifdef _WIN32
    out.backend = BackendKind::WasapiShared;
#endif
    if (session_.generationId() != GenerationId{0})
        out = session_.requested();

    // A request names the whole device selection: an absent id means the system default, never the
    // previous session's device (its id may belong to another backend, e.g. an ASIO CLSID).
    out.inputDeviceId = std::string(request.value("input"));
    out.outputDeviceId = std::string(request.value("output"));
    using NumericField = std::pair<std::string_view, std::uint32_t RequestedConfiguration::*>;
    constexpr std::array fields{
        NumericField{"rate", &RequestedConfiguration::sampleRateHz},
        NumericField{"period", &RequestedConfiguration::periodFrames},
        NumericField{"inputPeriod", &RequestedConfiguration::inputPeriodFrames},
        NumericField{"inChannels", &RequestedConfiguration::inputChannels},
        NumericField{"outChannels", &RequestedConfiguration::outputChannels},
    };
    for (const auto& [name, member] : fields)
        out.*member =
            static_cast<std::uint32_t>(uint64Value(request.value(name), out.*member, UINT32_MAX));

    using BackendEntry = std::pair<std::string_view, BackendKind>;
    constexpr std::array backends{BackendEntry{"fake", BackendKind::Fake},
                                  BackendEntry{"wasapi-shared", BackendKind::WasapiShared},
                                  BackendEntry{"wasapi-exclusive", BackendKind::WasapiExclusive},
                                  BackendEntry{"asio", BackendKind::Asio}};
    const auto backendName = request.value("backend");
    const auto backend = std::ranges::find_if(
        backends, [backendName](const auto& entry) { return entry.first == backendName; });
    if (backend != backends.end())
        out.backend = backend->second;
    return out;
}
// Outputs that bypass the Windows mixer follow the Windows volume themselves: exclusive mode on its
// own endpoint, ASIO on the Windows default output. Shared streams are attenuated by Windows.
void AudioService::followSystemVolume(const RequestedConfiguration& config) noexcept {
#ifdef _WIN32
    using Stream = SystemVolumeFollower::Stream;
    switch (config.backend) {
    case BackendKind::WasapiExclusive:
        systemVolume_.follow(config.outputDeviceId, Stream::BypassesWindows);
        break;
    case BackendKind::Asio:
        systemVolume_.follow({}, Stream::BypassesWindows);
        break;
    default:
        systemVolume_.follow({}, Stream::MixedByWindows);
        break;
    }
#else
    (void)config;
#endif
}
MediaContext AudioService::contextFromControl(const ControlRequest& request) const {
    using ContextEntry = std::pair<std::string_view, MediaContext>;
    constexpr std::array contexts{ContextEntry{"preview", MediaContext::EditorPreview},
                                  ContextEntry{"radio", MediaContext::Radio},
                                  ContextEntry{"recording", MediaContext::RecordingPreview}};
    const auto name = request.value("context");
    const auto context =
        std::ranges::find_if(contexts, [name](const auto& entry) { return entry.first == name; });
    return context == contexts.end() ? MediaContext::Karaoke : context->second;
}
void AudioService::captureFailure(FailureInfo failure) {
    const auto realtime = realtime_.snapshot();
    const auto network = network_.diagnostics();
    failureSnapshot_ = {
        true,
        std::move(failure),
        session_.generationId(),
        session_.requested().backend,
        session_.requested(),
        session_.runtime(),
        session_.plan(),
        session_.backendSnapshot(),
        realtime.sessionFrame,
        realtime.clockBridge.fillFrames,
        realtime.driftPpm,
        realtime.correctionRatio,
        recording_.queueFillFrames(),
        network.sendQueueFillFrames,
        network.receiveQueueFillFrames,
    };
}

void AudioService::processPendingBackendEvent() {
    const auto event = realtime_.pendingBackendEvent();
    if (event.sequence == 0)
        return;
    realtime_.acknowledgeBackendEvent(event.sequence);
    if (event.generation != session_.generationId())
        return;
    constexpr std::array fatalEvents{
        BackendEventType::DeviceLost, BackendEventType::DeviceInvalidated,
        BackendEventType::DriverReset, BackendEventType::SampleRateChanged};
    if (std::ranges::find(fatalEvents, event.type) == fatalEvents.end())
        return;
    captureFailure({FailureCategory::Device, FailureSeverity::SessionFatal, event.code,
                    std::string(backendEventName(event.type))});
    constexpr std::array nonRecoverableStates{SessionState::Idle, SessionState::Stopping};
    if (std::ranges::find(nonRecoverableStates, session_.state()) == nonRecoverableStates.end()) {
        (void)session_.recover();
        syncDeviceGeneration();
    }
}
void AudioService::processDeviceEvents() {
    DeviceEvent event;
    bool recover = false;
    while (devices_.popEvent(event)) {
        if (event.generationId != session_.generationId())
            continue;
        if (deviceEventRequiresRecovery(event, session_.requested()))
            recover = true;
    }
    constexpr std::array nonRecoverableStates{SessionState::Idle, SessionState::Stopping};
    if (recover &&
        std::ranges::find(nonRecoverableStates, session_.state()) == nonRecoverableStates.end()) {
        captureFailure({FailureCategory::Device, FailureSeverity::SessionFatal, 0,
                        "device notification triggered recovery"});
        (void)session_.recover();
        syncDeviceGeneration();
    }
}
std::uint64_t AudioService::roomPlaybackFrame(MonotonicTicks at) const noexcept {
    // A room follower hears the song later; its timers still show the room position.
    const auto followTicks = realtime_.roomFollowTicks();
    const auto own = media_.presentationFrame(MediaSlot::Music, at - followTicks);
    const auto music = media_.snapshot(MediaSlot::Music);
    if (music.state != PlaybackState::Playing || followTicks <= 0)
        return own;
    const auto framesPerTick = static_cast<double>(realtime_.roomFollowFrames()) / followTicks;
    // Until the follower's own (later) start, the room has only played since the scheduled start.
    const auto startAt = media_.scheduledStartTicks(MediaSlot::Music);
    const auto aheadTicks = startAt != 0 && at - followTicks < startAt
                                ? std::max<MonotonicTicks>(0, at - startAt)
                                : followTicks;
    return own + static_cast<std::uint64_t>(
                     std::llround(aheadTicks * framesPerTick * static_cast<double>(music.rate)));
}

std::string AudioService::diagnostics() {
    latency_.set(LatencyRegistry::Stage::MediaPitch, 0, media_.processingLatencyFrames(), 0);
    const auto rt = realtime_.snapshot();
    const auto micGap = realtime_.micGapTimeline();
    const auto backend = session_.backendSnapshot();
    const auto graph = graphInfo_.snapshot();
    const auto analysis = analysis_.snapshot();
    const auto music = media_.snapshot(MediaSlot::Music);
    const auto preview = media_.snapshot(MediaSlot::RecordingPreview);
    const auto net = network_.diagnostics();
    const auto sig = signal_.snapshot();
    const auto observedAt = monotonicTicksNow();
    const auto presentationPosition = roomPlaybackFrame(observedAt);
    const auto rate = session_.runtime().outputSampleRateHz;
    const auto stageFrames = [this](LatencyRegistry::Stage id) {
        const auto stage = latency_.get(id);
        return static_cast<std::uint64_t>(stage.algorithmicFrames) + stage.currentFillFrames;
    };
    const auto captureFrames = stageFrames(LatencyRegistry::Stage::Capture);
    const auto bridgeFrames = stageFrames(LatencyRegistry::Stage::ClockBridge);
    const auto dspFrames = stageFrames(LatencyRegistry::Stage::Dsp);
    const auto outputFrames = stageFrames(LatencyRegistry::Stage::OutputDriver);
    const auto inputRate = session_.runtime().inputSampleRateHz;
    const auto outputRate = session_.runtime().outputSampleRateHz;
    const auto inputDemand = outputRate == 0 ? 0.0
        : static_cast<double>(micGap.requestedFrames) * inputRate / outputRate;
    const auto micGapCause = micGap.sequence == 0 ? std::string_view{"NONE"}
        : micGap.bridgeAvailableFrames < inputDemand ?
              std::string_view{"CAPTURE_UNAVAILABLE_AT_RENDER"}
            : std::string_view{"CLOCK_BRIDGE_PULL_SHORTFALL"};
    const auto elapsedUs = [](MonotonicTicks later, MonotonicTicks earlier) {
        return later > 0 && earlier > 0 && later >= earlier ? (later - earlier) / 1'000 : 0;
    };
    const auto rawCaptureEndNs = micGap.rawCaptureQpc100ns == 0 || inputRate == 0
        ? 0 : static_cast<MonotonicTicks>(micGap.rawCaptureQpc100ns) * 100 +
              static_cast<MonotonicTicks>(micGap.packetFrames) * 1'000'000'000LL / inputRate;
    // Presentation time includes queued render PCM. Partition that observed total instead of
    // counting the queue a second time; driver-reported latency is the fallback before rendering.
    const auto queueFrames = std::min<std::uint64_t>(backend.renderQueueFrames, outputFrames);
    const auto milliseconds = [rate](std::uint64_t frames) {
        return rate == 0 ? 0.0 : static_cast<double>(frames) * 1'000.0 / rate;
    };
    const auto shared = session_.backendName() == "WASAPI Shared";
    const std::array fallbackCases{
        std::pair{backend.sharedPeriodLocked, std::string_view{"ENGINE_PERIODICITY_LOCKED"}},
        std::pair{backend.sharedCpuFallback, std::string_view{"CPU_USAGE_EXCEEDED"}},
        std::pair{!backend.sharedClient3Available, std::string_view{"IAUDIOCLIENT3_UNAVAILABLE"}},
        std::pair{backend.sharedMinimumPeriodFrames == 0,
                  std::string_view{"PERIOD_QUERY_UNAVAILABLE"}},
    };
    const auto fallback = std::ranges::find_if(fallbackCases, [](const auto& item) {
        return item.first;
    });
    const auto fallbackName = !shared ? std::string_view{"NOT_SHARED"}
                                      : fallback == fallbackCases.end() ? std::string_view{"NONE"}
                                                                        : fallback->second;
    const auto periodMismatch =
        session_.selected().periodFrames != session_.requested().periodFrames ||
        (shared && backend.sharedActualPeriodFrames != 0 &&
         backend.sharedActualPeriodFrames != session_.requested().periodFrames) ||
        (session_.runtime().outputSampleRateHz != 0 &&
         session_.runtime().outputSampleRateHz != session_.requested().sampleRateHz);
    const std::array mismatchCases{
        std::pair{session_.selected().periodFrames != session_.requested().periodFrames,
                  std::string_view{"UNSUPPORTED_PERIOD"}},
        std::pair{shared && backend.sharedPeriodLocked,
                  std::string_view{"ENGINE_PERIODICITY_LOCKED"}},
        std::pair{shared && backend.sharedCpuFallback,
                  std::string_view{"DRIVER_LIMITATION"}},
        std::pair{shared && !backend.sharedClient3Available,
                  std::string_view{"IAudioClient3_UNAVAILABLE"}},
        std::pair{shared && backend.sharedMinimumPeriodFrames == 0,
                  std::string_view{"INITIALIZATION_FALLBACK"}},
        std::pair{session_.runtime().outputSampleRateHz != 0 &&
                      session_.runtime().outputSampleRateHz != session_.requested().sampleRateHz,
                  std::string_view{"FORMAT_NEGOTIATION"}},
    };
    const auto mismatch = std::ranges::find_if(mismatchCases, [](const auto& item) {
        return item.first;
    });
    const auto mismatchName =
        !periodMismatch ? std::string_view{"NONE"} :
        mismatch == mismatchCases.end() ? std::string_view{"UNKNOWN"} : mismatch->second;
    const auto inputMismatchName =
        session_.selected().inputPeriodFrames != session_.requested().inputPeriodFrames
            ? std::string_view{"UNSUPPORTED_PERIOD"}
            : shared && session_.requested().inputPeriodFrames != 0 &&
                      backend.inputSharedActualPeriodFrames != 0 &&
                      session_.requested().inputPeriodFrames != backend.inputSharedActualPeriodFrames
                ? backend.inputSharedPeriodLocked ? std::string_view{"ENGINE_PERIODICITY_LOCKED"}
                                                  : std::string_view{"INITIALIZATION_FALLBACK"}
                : std::string_view{"NONE"};
    const std::array causeCases{
        std::pair{shared && backend.sharedPeriodLocked &&
                      backend.sharedActualPeriodFrames > backend.sharedRequestedPeriodFrames,
                  std::string_view{"SHARED_ENGINE_PERIOD_LOCKED"}},
        std::pair{shared && backend.renderQueueFrames > session_.runtime().outputPeriodFrames &&
                      backend.renderQueueEscalations > 0,
                  std::string_view{"QUEUE_ESCALATION"}},
        std::pair{shared && backend.sharedMinimumPeriodFrames > 0 &&
                      backend.sharedActualPeriodFrames == backend.sharedMinimumPeriodFrames &&
                      backend.sharedMinimumPeriodFrames > backend.sharedRequestedPeriodFrames,
                  std::string_view{"DRIVER_MINIMUM_PERIOD"}},
    };
    const auto cause = std::ranges::find_if(causeCases, [](const auto& item) {
        return item.first;
    });
    std::ostringstream out;
    out << "MonotonicTicks: " << observedAt << '\n'
        << "ServiceState: " << serviceStateName(state_) << '\n'
        << "SessionState: " << sessionStateName(session_.state()) << '\n'
        << "generationId: " << session_.generationId() << '\n'
        << "Backend: " << session_.backendName() << '\n'
        << "ActiveInputDeviceId: "
        << (session_.requested().inputDeviceId.empty() ? "system-default"
                                                       : session_.requested().inputDeviceId)
        << '\n'
        << "ActiveOutputDeviceId: "
        << (session_.requested().outputDeviceId.empty() ? "system-default"
                                                        : session_.requested().outputDeviceId)
        << '\n'
        << "RequestedSampleRate: " << session_.requested().sampleRateHz << '\n'
        << "SelectedSampleRate: " << session_.selected().sampleRateHz << '\n'
        << "SelectedPeriodFrames: " << session_.selected().periodFrames << '\n'
        << "RequestedPeriodFrames: " << session_.requested().periodFrames << '\n'
        << "SelectedInputPeriodFrames: " << session_.selected().inputPeriodFrames << '\n'
        << "RequestedInputPeriodFrames: " << session_.requested().inputPeriodFrames << '\n'
        << "PeriodSelectionFallback: "
        << (session_.selected().periodFrames != 0 &&
                    session_.selected().periodFrames != session_.requested().periodFrames
                ? "UNSUPPORTED_BY_CAPABILITIES"
                : "NONE")
        << '\n'
        << "PeriodMismatchReason: " << mismatchName << '\n'
        << "InputPeriodMismatchReason: " << inputMismatchName << '\n'
        << "RuntimeInputSampleRate: " << session_.runtime().inputSampleRateHz << '\n'
        << "RuntimeOutputSampleRate: " << session_.runtime().outputSampleRateHz << '\n'
        << "RuntimeInputPeriodFrames: " << session_.runtime().inputPeriodFrames << '\n'
        << "RuntimeOutputPeriodFrames: " << session_.runtime().outputPeriodFrames << '\n'
        << "RuntimeInputEndpointBufferFrames: " << session_.runtime().inputEndpointBufferFrames
        << '\n'
        << "RuntimeOutputEndpointBufferFrames: " << session_.runtime().outputEndpointBufferFrames
        << '\n'
        << "RuntimeInputLatencyFrames: " << session_.runtime().inputLatencyFrames << '\n'
        << "RuntimeOutputLatencyFrames: " << session_.runtime().outputLatencyFrames << '\n'
        << "RenderPaddingFrames: " << backend.renderPaddingFrames << '\n'
        << "SessionFrame: " << rt.sessionFrame << '\n'
        << "DriftPpm: " << rt.driftPpm << '\n'
        << "CorrectionRatio: " << rt.correctionRatio << '\n'
        << "ClockBridgeFill: " << rt.clockBridge.fillFrames << '/' << rt.clockBridge.capacityFrames
        << '\n'
        << "ClockBridgeTargetFrames: " << rt.clockBridge.targetFrames << '\n'
        << "ClockBridgeCapacityMs: "
        << (session_.runtime().inputSampleRateHz == 0
                ? 0.0
                : static_cast<double>(rt.clockBridge.capacityFrames) * 1'000.0 /
                      session_.runtime().inputSampleRateHz)
        << '\n'
        << "ClockBridgeTargetMs: "
        << (session_.runtime().inputSampleRateHz == 0
                ? 0.0
                : static_cast<double>(rt.clockBridge.targetFrames) * 1'000.0 /
                      session_.runtime().inputSampleRateHz)
        << '\n'
        << "ClockBridgeEstimatedMs: " << milliseconds(bridgeFrames) << '\n'
        << "ClockBridgeCurrentDemandFrames: " << rt.clockBridge.currentDemandFrames << '\n'
        << "ClockBridgeLargestDemandFrames: " << rt.clockBridge.largestDemandFrames << '\n'
        << "ClockBridgeResidualBeforePullFrames: " << rt.clockBridge.residualBeforePullFrames
        << '\n'
        << "ClockBridgeFillBeforePullP50Frames: " << rt.clockBridge.fillBeforePullP50Frames
        << '\n'
        << "ClockBridgeFillBeforePullP95Frames: " << rt.clockBridge.fillBeforePullP95Frames
        << '\n'
        << "ClockBridgeFillBeforePullP99Frames: " << rt.clockBridge.fillBeforePullP99Frames
        << '\n'
        << "ClockBridgeFillBeforePullMaximumFrames: "
        << rt.clockBridge.fillBeforePullMaximumFrames << '\n'
        << "ClockBridgeClockRelationship: "
        << (session_.runtime().clockRelationship == ClockRelationship::Independent ? "INDEPENDENT"
                                                                           : "SAME_DOMAIN")
        << '\n'
        << "ClockBridgeResamplerActive: "
        << (session_.runtime().clockRelationship == ClockRelationship::Independent ||
            session_.runtime().inputSampleRateHz != session_.runtime().outputSampleRateHz)
        << '\n'
        << "CapturePacketsPerWakeP95: " << backend.capturePacketsPerWakeStats.p95 << '\n'
        << "CapturePacketsPerWakeMax: " << backend.capturePacketsPerWakeStats.maximum << '\n'
        << "CaptureFramesPerWakeP95: " << backend.captureFramesPerWakeStats.p95 << '\n'
        << "CaptureFramesPerWakeMax: " << backend.captureFramesPerWakeStats.maximum << '\n'
        << "CaptureRawQpc100ns: " << backend.captureRawQpc100ns << '\n'
        << "CaptureStampDeliveredAtNs: " << realtime_.captureStampDeliveredAtNs() << '\n'
        << "CaptureStampCorrectedStartNs: " << realtime_.captureStampCorrectedStartNs() << '\n'
        << "ClockBridgeCorrectionRatio: " << rt.clockBridge.fillCorrectionRatio << '\n'
        << "ClockBridgeUnderruns: " << rt.clockBridge.underruns << '\n'
        << "ClockBridgeOverruns: " << rt.clockBridge.overruns << '\n'
        << "ClockBridgeDroppedFrames: " << rt.clockBridge.droppedFrames << '\n'
        << "MicCaptureSkippedFrames: " << rt.micCaptureSkippedFrames << '\n'
        << "MicCaptureRepeatedFrames: " << rt.micCaptureRepeatedFrames << '\n'
        << "MicInsertedSilenceFrames: " << rt.micInsertedSilenceFrames << '\n'
        << "MicLastGapCause: " << micGapCause << '\n'
        << "MicLastGapSequence: " << micGap.sequence << '\n'
        << "MicLastGapFrames: " << micGap.missingFrames << '\n'
        << "MicLastGapBridgeAvailableFrames: " << micGap.bridgeAvailableFrames << '\n'
        << "MicLastGapRequestedFrames: " << micGap.requestedFrames << '\n'
        << "MicLastGapCaptureDevicePosition: " << micGap.captureDevicePosition << '\n'
        << "MicLastGapRawCaptureQpc100ns: " << micGap.rawCaptureQpc100ns << '\n'
        << "MicLastGapPacketFrames: " << micGap.packetFrames << '\n'
        << "MicLastGapLastEmptyProbeNs: " << micGap.lastEmptyPacketProbeNs << '\n'
        << "MicLastGapCaptureEventObservedNs: " << micGap.captureEventObservedNs << '\n'
        << "MicLastGapWakeObservedNs: " << micGap.wakeObservedNs << '\n'
        << "MicLastGapGetBufferStartedNs: " << micGap.getBufferStartedNs << '\n'
        << "MicLastGapPacketDeliveredNs: " << micGap.packetDeliveredNs << '\n'
        << "MicLastGapEngineStartedNs: " << micGap.engineProcessingStartedNs << '\n'
        << "MicLastGapBridgeInsertedNs: " << micGap.bridgeInsertedNs << '\n'
        << "MicLastGapRenderWakeObservedNs: " << micGap.renderWakeObservedNs << '\n'
        << "MicLastGapRenderConsumedNs: " << micGap.micConsumedForRenderNs << '\n'
        << "MicLastGapRenderSubmittedNs: " << micGap.renderSubmittedNs << '\n'
        << "MicLastGapPresentationNs: " << micGap.presentationNs << '\n'
        << "MicLastGapCaptureStampCorrectionNs: " << micGap.captureStampCorrectionNs << '\n'
        << "MicLastGapCaptureEventGapUs: " << micGap.captureEventGapUs << '\n'
        << "MicLastGapPacketQpcGapUs: " << micGap.packetQpcGapUs << '\n'
        << "MicLastGapPacketsThisWake: " << micGap.packetsThisWake << '\n'
        << "MicLastGapFramesThisWake: " << micGap.framesThisWake << '\n'
        << "MicLastGapRenderWakePackets: " << micGap.renderWakePackets << '\n'
        << "MicLastGapRenderWakeFrames: " << micGap.renderWakeFrames << '\n'
        << "MicLastGapBridgeFillBeforeInsertFrames: "
        << micGap.bridgeFillBeforeInsertFrames << '\n'
        << "MicLastGapBridgeFillAfterInsertFrames: "
        << micGap.bridgeFillAfterInsertFrames << '\n'
        << "MicLastGapDeviceCaptureAgeUs: "
        << elapsedUs(micGap.getBufferStartedNs, rawCaptureEndNs) << '\n'
        << "MicLastGapWakeToGetBufferUs: "
        << elapsedUs(micGap.getBufferStartedNs, micGap.wakeObservedNs) << '\n'
        << "MicLastGapEngineToBridgeUs: "
        << elapsedUs(micGap.bridgeInsertedNs, micGap.engineProcessingStartedNs) << '\n'
        << "MicLastGapLatestPacketToRenderUs: "
        << elapsedUs(micGap.micConsumedForRenderNs, micGap.bridgeInsertedNs) << '\n'
        << "MicLastGapSubmissionToPresentationUs: "
        << elapsedUs(micGap.presentationNs, micGap.renderSubmittedNs) << '\n'
        << "MicMonitoringAgeP50Us: " << rt.micMonitoringAgeP50Us << '\n'
        << "MicMonitoringAgeP95Us: " << rt.micMonitoringAgeP95Us << '\n'
        << "MicMonitoringAgeP99Us: " << rt.micMonitoringAgeP99Us << '\n'
        << "MicMonitoringAgeMinUs: " << rt.micMonitoringAgeMinUs << '\n'
        << "MicMonitoringAgeMaxUs: " << rt.micMonitoringAgeMaxUs << '\n'
        << "MonitoringEnabled: " << realtime_.monitoring() << '\n'
        << "MonitoringSafetyTripped: " << realtime_.monitoringSafetyTripped() << '\n'
        << "MonitoringSafetyTripFrame: " << realtime_.monitoringSafetyTripFrame() << '\n'
        << "MonitoringSafetyInputPeak: " << realtime_.monitoringSafetyInputPeak() << '\n'
        << "StaleCallbacks: " << rt.staleCallbacks << '\n'
        << "PresentationJumps: " << rt.presentationJumps << '\n'
        << "RenderClockSkipFrames: " << backend.renderClockSkipFrames << '\n'
        << "RenderClockRebaseFrames: " << backend.renderClockRebaseFrames << '\n'
        << "RenderStarvedFrames: " << backend.renderStarvedFrames << '\n'
        << "RenderTimingPressureFrames: " << backend.renderTimingPressureFrames << '\n'
        << "RenderConfirmedUnderrunFrames: " << backend.renderConfirmedUnderrunFrames << '\n'
        << "RenderQueueEscalations: " << backend.renderQueueEscalations << '\n'
        << "CaptureDiscontinuities: " << backend.captureDiscontinuities << '\n'
        << "RenderQueueFrames: " << backend.renderQueueFrames << '\n'
        << "InputRawProcessing: " << backend.inputRaw << '\n'
        << "OutputRawProcessing: " << backend.outputRaw << '\n'
        << "InputRawReason: " << backend.inputRawReason << '\n'
        << "OutputRawReason: " << backend.outputRawReason << '\n'
        << "MmcssActive: " << backend.mmcssActive << '\n'
        << "OutputEndpointVolume: " << backend.outputEndpointVolume << '\n'
        << "BackendOutputNonzeroBlocks: " << backend.outputNonzeroBlocks << '\n'
        << "BackendOutputPeak: " << backend.outputPeak << '\n'
        << "SystemVolumeGain: " << realtime_.systemGain() << '\n'
        << "MicrophoneEnabled: " << (realtime_.microphoneEnabled() ? 1 : 0) << '\n'
        << "PresentationJumpMaxNs: " << rt.presentationJumpMaxNs << '\n'
        << "XRuns: " << backend.xruns << '\n'
        << "DeadlineMisses: " << backend.deadlineMisses << '\n'
        << "PlaybackState: " << playbackStateText(music.state) << '\n'
        << "PlaybackPositionFrames: " << media_.timelineFrame(MediaSlot::Music) << '\n'
        << "PlaybackPresentationPositionFrames: " << presentationPosition << '\n'
        << "RoomClockObservationFrames: " << network_.roomTimelineFrame(observedAt, 0) << '\n'
        << "MusicBufferFill: " << music.bufferFillFrames << '\n'
        << "MusicUnderruns: " << music.underruns << '\n'
        << "PreviewState: " << playbackStateText(preview.state) << '\n'
        << "PreviewPositionFrames: " << media_.timelineFrame(MediaSlot::RecordingPreview) << '\n'
        << "RadioState: " << playbackStateText(media_.snapshot(MediaSlot::Radio).state) << '\n'
        << "RecordingState: " << static_cast<int>(recording_.state()) << '\n'
        << "RecordingQueueFill: " << recording_.queueFillFrames() << '\n'
        << "InputPeak: " << sig.peak << '\n'
        << "InputRMS: " << sig.rms << '\n'
        << "InputPitchHz: " << analysis.pitchHz << '\n'
        << "InputClipping: " << sig.clipping << '\n'
        << "NetworkSendQueueFill: " << net.sendQueueFillFrames << '\n'
        << "NetworkReceiveQueueFill: " << net.receiveQueueFillFrames << '\n'
        << "NetworkPacketsSent: " << net.packetsSent << '\n'
        << "RoomVoiceUpstreamNonzeroBlocks: " << net.normalizedSendNonzeroBlocks << '\n'
        << "RoomVoiceUpstreamPeak: " << net.normalizedSendPeak << '\n'
        << "NetworkGeneration: " << net.generation << '\n'
        << "NetworkStreamEpoch: " << net.streamEpoch << '\n'
        << "NetworkSendGapLatestMs: " << static_cast<double>(net.sendGapLatestMicros) / 1'000.0
        << '\n'
        << "NetworkSendGapMaximumMs: " << static_cast<double>(net.sendGapMaximumMicros) / 1'000.0
        << '\n'
        << "NetworkSendGapMaximumAtMs: "
        << static_cast<double>(net.sendGapMaximumAtMicros) / 1'000.0 << '\n'
        << "NetworkSendGapMaximumTimelineFrame: " << net.sendGapMaximumTimelineFrame << '\n'
        << "NetworkSendGapMaximumGeneration: " << net.sendGapMaximumGeneration << '\n'
        << "NetworkSendGapMaximumStreamEpoch: " << net.sendGapMaximumStreamEpoch << '\n'
        << "NetworkSendMonotonicMs: " << static_cast<double>(net.lastSendMonotonicMicros) / 1'000.0
        << '\n'
        << "NetworkSendTimelineFrame: " << net.lastSendTimelineFrame << '\n'
        << "NetworkSendGeneration: " << net.lastSendGeneration << '\n'
        << "NetworkSendStreamEpoch: " << net.lastSendStreamEpoch << '\n'
        << "NetworkPacketsReceived: " << net.packetsReceived << '\n'
        << "NetworkRelayEchoes: " << net.relayEchoes << '\n'
        << "VoiceCodec: " << (net.sendCodec == VoiceCodec::Pcm16 ? "Pcm16" : "Opus") << '\n'
        << "AcousticLatencyUs: " << realtime_.acousticLatencyNs() / 1'000 << '\n'
        << "AcousticCalibrationContext: " << realtime_.calibrationContext() << '\n'
        << "AcousticCalibrationValid: " << realtime_.acousticCalibrationValid() << '\n'
        << "AcousticLastMeasuredUs: " << realtime_.lastAcousticLatency().hiddenLatencyNs / 1'000
        << '\n'
        << "AcousticLastConfidence: " << realtime_.lastAcousticLatency().confidence << '\n'
        << "AcousticPassiveUs: " << realtime_.passiveLatency().hiddenLatencyNs / 1'000 << '\n'
        << "AcousticPassiveAccepted: " << realtime_.passiveLatency().accepted << '\n'
        << "AcousticPassiveAttempts: " << realtime_.passiveLatency().attempts << '\n'
        << "CaptureAgeUs: " << realtime_.captureAgeNs() / 1'000 << '\n'
        << "LOCAL LATENCY BUDGET\n"
        << "LocalCaptureDeviceMs: " << milliseconds(captureFrames) << '\n'
        << "LocalAudioServiceInternalMs: " << milliseconds(bridgeFrames) << '\n'
        << "LocalResamplerDspMs: " << milliseconds(dspFrames) << '\n'
        << "LocalRenderQueueMs: " << milliseconds(queueFrames) << '\n'
        << "LocalEndpointOutputMs: " << milliseconds(outputFrames - queueFrames) << '\n'
        << "LocalEstimatedMonitoringMs: "
        << milliseconds(captureFrames + bridgeFrames + dspFrames + outputFrames) << '\n'
        << "LocalLatencyClassification: "
        << (cause == causeCases.end() ? std::string_view{"UNKNOWN"} : cause->second) << '\n'
        << "SharedClient3Available: " << backend.sharedClient3Available << '\n'
        << "SharedEnginePeriodRequestedFrames: " << backend.sharedRequestedPeriodFrames << '\n'
        << "SharedEnginePeriodDefaultFrames: " << backend.sharedDefaultPeriodFrames << '\n'
        << "SharedEnginePeriodFundamentalFrames: " << backend.sharedFundamentalPeriodFrames << '\n'
        << "SharedEnginePeriodMinimumFrames: " << backend.sharedMinimumPeriodFrames << '\n'
        << "SharedEnginePeriodMaximumFrames: " << backend.sharedMaximumPeriodFrames << '\n'
        << "SharedEnginePeriodActualFrames: " << backend.sharedActualPeriodFrames << '\n'
        << "SharedEnginePeriodicityLocked: " << backend.sharedPeriodLocked << '\n'
        << "SharedStreamRenderFirst: " << backend.sharedRenderFirst << '\n'
        << "InputSharedClient3Available: " << backend.inputSharedClient3Available << '\n'
        << "InputSharedEnginePeriodicityLocked: " << backend.inputSharedPeriodLocked << '\n'
        << "InputSharedEnginePeriodRequestedFrames: " << backend.inputSharedRequestedPeriodFrames << '\n'
        << "InputSharedEnginePeriodDefaultFrames: " << backend.inputSharedDefaultPeriodFrames << '\n'
        << "InputSharedEnginePeriodFundamentalFrames: " << backend.inputSharedFundamentalPeriodFrames << '\n'
        << "InputSharedEnginePeriodMinimumFrames: " << backend.inputSharedMinimumPeriodFrames << '\n'
        << "InputSharedEnginePeriodMaximumFrames: " << backend.inputSharedMaximumPeriodFrames << '\n'
        << "InputSharedEnginePeriodActualFrames: " << backend.inputSharedActualPeriodFrames << '\n'
        << "SharedEnginePeriodFallback: " << fallbackName << '\n'
        << "CaptureStampCorrectionUs: " << realtime_.captureStampCorrectionNs() / 1'000 << '\n'
        << "MusicLoudnessRms: " << media_.snapshot(MediaSlot::Music).loudnessRms << '\n'
        << "SongLoudnessGain: "
        << streamingLoudnessGain(media_.snapshot(MediaSlot::Music).loudnessRms) << '\n'
        << "OwnVoiceRms: " << realtime_.ownVoiceRms() << '\n'
        << "RemoteMixNonzeroBlocks: " << rt.remoteMixNonzeroBlocks << '\n'
        << "RemoteMixPeak: " << rt.remoteMixPeak << '\n'
        << "MasterOutputNonzeroBlocks: " << rt.masterOutputNonzeroBlocks << '\n'
        << "MasterOutputPeak: " << rt.masterOutputPeak << '\n'
        << "NetworkDroppedSendBlocks: " << net.droppedSendBlocks << '\n'
        << "JitterTargetPackets: " << net.jitter.currentTargetPackets << '\n'
        << "NetworkRoundTripMs: " << net.timing.roundTripMs << '\n'
        << "NetworkRoundTripP50Ms: " << net.roundTripP50Ms << '\n'
        << "NetworkRoundTripP95Ms: " << net.roundTripP95Ms << '\n'
        << "NetworkRoundTripP99Ms: " << net.roundTripP99Ms << '\n'
        << "RoomSharedTimeline: " << net.sharedTimeline << '\n'
        << "NetworkTransportRunning: " << net.transportRunning << '\n'
        << "NetworkSendEnabled: " << net.sendEnabled << '\n'
        << "NetworkDirectPeerCount: " << net.directPeerCount << '\n'
        << "RoomCompensationFrames: " << net.sharedTargetDelayFrames << '\n'
        << "RoomRequestedDelayFrames: " << net.advertisedTargetDelayFrames << '\n'
        << "RoomPlayoutDelayFrames: " << net.roomPlayoutDelayFrames << '\n'
        << roomReturnRequirement(net)
        << "RoomFollowFrames: " << realtime_.roomFollowFrames() << '\n'
        << "AnalysisProcessedFrames: " << analysis.processedFrames << '\n'
        << "AnalysisDroppedFrames: " << analysis.droppedFrames << '\n'
        << "RealtimePoolBytes: " << graph.poolBytes << '\n'
        << "GraphStages: ";
    for (const auto& stage : graph.stages)
        out << stage.name << ">";
    out << '\n'
        << "TraceSize: " << trace_.size() << '\n'
        << "EstimatedLatencyFrames: " << latency_.totalFrames() << '\n'
        << "MonitoringLatencyFrames: " << latency_.totalFrames(LatencyRegistry::Path::Monitoring)
        << '\n'
        << "PlaybackLatencyFrames: " << latency_.totalFrames(LatencyRegistry::Path::Playback)
        << '\n'
        << "MediaPitchLatencyFrames: " << media_.processingLatencyFrames() << '\n'
        << "AnalysisStaleFrames: " << analysis.staleFrames << '\n'
        << "NetworkReceiveQueueOverruns: " << net.receiveQueueOverruns << '\n'
        << "NetworkStaleBlocks: " << net.staleBlocks << '\n';
    struct Metric {
        std::string_view name;
        std::string_view unit;
        BackendSnapshot::Quantiles values;
    };
    const std::array metrics{
        Metric{"RenderPadding", "Frames", backend.renderPaddingStats},
        Metric{"CaptureEventGap", "Us", backend.captureEventGapStats},
        Metric{"CapturePacketGap", "Us", backend.capturePacketGapStats},
        Metric{"RenderEventGap", "Us", backend.renderEventGapStats},
        Metric{"DuplexWait", "Us", backend.duplexWaitStats},
        Metric{"RenderCallback", "Us", backend.renderCallbackStats},
    };
    for (const auto& [name, unit, values] : metrics)
        out << name << "Samples: " << values.count << '\n'
            << name << "P50" << unit << ": " << values.p50 << '\n'
            << name << "P95" << unit << ": " << values.p95 << '\n'
            << name << "P99" << unit << ": " << values.p99 << '\n'
            << name << "Max" << unit << ": " << values.maximum << '\n';
    constexpr std::array monitoringStages{
        LatencyRegistry::Stage::Capture, LatencyRegistry::Stage::ClockBridge,
        LatencyRegistry::Stage::Dsp, LatencyRegistry::Stage::OutputDriver};
    for (const auto id : monitoringStages) {
        const auto stage = latency_.get(id);
        out << stage.name << "LatencyFrames: "
            << static_cast<std::uint64_t>(stage.algorithmicFrames) + stage.currentFillFrames
            << '\n';
    }
    for (const auto& participant : net.participants) {
        out << "RemoteLevel." << participant.participantId << ": " << participant.level << '\n'
            << "RemoteGain." << participant.participantId << ": " << participant.gain << '\n'
            << "RemoteMuted." << participant.participantId << ": " << participant.muted << '\n'
            << "RemoteDecodedNonzeroPackets." << participant.participantId << ": "
            << participant.decodedNonzeroPackets << '\n'
            << "RemoteDecodedPeak." << participant.participantId << ": "
            << participant.decodedPeak << '\n'
            << "RemoteQueuedNonzeroPackets." << participant.participantId << ": "
            << participant.queuedNonzeroPackets << '\n'
            << "RemoteQueuedPeak." << participant.participantId << ": "
            << participant.queuedPeak << '\n'
            << "RemoteRenderedNonzeroBlocks." << participant.participantId << ": "
            << participant.renderedNonzeroBlocks << '\n'
            << "RemoteRenderedPeak." << participant.participantId << ": "
            << participant.renderedPeak << '\n'
            << "RemoteJitterMs." << participant.participantId << ": "
            << participant.timing.interarrivalJitterMs << '\n'
            << "RemoteTargetDelayFrames." << participant.participantId << ": "
            << participant.timing.targetDelayFrames << '\n'
            << "RemoteClockOffsetMs." << participant.participantId << ": "
            << participant.timing.clockOffsetMs << '\n'
            << "RemoteClockDriftPpm." << participant.participantId << ": "
            << participant.timing.clockDriftPpm << '\n'
            << "RemoteAlignmentDelayFrames." << participant.participantId << ": "
            << participant.alignmentDelayFrames << '\n'
            << "RemoteLatePackets." << participant.participantId << ": " << participant.latePackets
            << '\n'
            << "RemoteLostPackets." << participant.participantId << ": "
            << participant.jitter.lostPackets << '\n'
            << "RemoteLossPermille." << participant.participantId << ": "
            << participant.lossPermille << '\n'
            << "RemoteReportedLossPermille." << participant.participantId << ": "
            << participant.reportedLossPermille << '\n'
            << "RemoteDecodeUnderruns." << participant.participantId << ": "
            << participant.decodeUnderruns << '\n'
            << "RemoteQueueFillFrames." << participant.participantId << ": "
            << participant.queueFillFrames << '\n'
            << "RemoteLatenessTargetFrames." << participant.participantId << ": "
            << participant.latenessTargetFrames << '\n'
            << "RemoteVoiceRms." << participant.participantId << ": " << participant.voiceRms
            << '\n'
            << "RemoteLateAudioCuts." << participant.participantId << ": "
            << participant.lateAudioCuts << '\n'
            << "RemoteLateNonzeroVoiceCuts." << participant.participantId << ": "
            << participant.lateNonzeroVoiceCuts << '\n'
            << "RemoteLateEmptyMixPackets." << participant.participantId << ": "
            << participant.lateEmptyMixPackets << '\n'
            << "RemoteLateOtherAudioCuts." << participant.participantId << ": "
            << participant.lateOtherAudioCuts << '\n'
            << "RemoteMaximumConsecutiveLateAudioCuts." << participant.participantId << ": "
            << participant.maximumConsecutiveLateAudioCuts << '\n'
            << "RemoteTimelineExcluded." << participant.participantId << ": "
            << participant.timelineExcluded << '\n'
            << "RemoteRelayFirstPackets." << participant.participantId << ": "
            << participant.relayFirstPackets << '\n'
            << "RemoteDirectFirstPackets." << participant.participantId << ": "
            << participant.directFirstPackets << '\n'
            << "RemoteLatenessLatestTransportFrames." << participant.participantId << ": "
            << participant.latenessLatestFrames << '\n'
            << "RemoteServerIngressFrames." << participant.participantId << ": "
            << participant.serverIngressFrames << '\n'
            << "RemoteServerMixWaitFrames." << participant.participantId << ": "
            << participant.serverMixWaitFrames << '\n'
            << "RemoteReturnPathFrames." << participant.participantId << ": "
            << participant.returnPathFrames << '\n'
            << "RemoteReturnP50Frames." << participant.participantId << ": "
            << participant.returnP50Frames << '\n'
            << "RemoteReturnP95Frames." << participant.participantId << ": "
            << participant.returnP95Frames << '\n'
            << "RemoteReturnRequirementFrames." << participant.participantId << ": "
            << participant.returnRequirementFrames << '\n'
            << "RemoteReturnSamples." << participant.participantId << ": "
            << participant.returnSamples << '\n'
            << "RemoteArrivalRequirementFrames." << participant.participantId << ": "
            << participant.arrivalRequirementFrames << '\n'
            << "RemoteReturnTracePackets." << participant.participantId << ": "
            << participant.returnStages.packets << '\n'
            << "RemoteReturnQueueAdmissions." << participant.participantId << ": "
            << participant.returnStages.queueAdmissions << '\n'
            << "RemoteSocketReceiveGapLatestUs." << participant.participantId << ": "
            << participant.returnStages.latestReceiveGapMicros << '\n'
            << "RemoteSocketReceiveGapMaximumUs." << participant.participantId << ": "
            << participant.returnStages.maximumReceiveGapMicros << '\n'
            << "RemoteSocketToProcessLatestUs." << participant.participantId << ": "
            << participant.returnStages.latestSocketToProcessMicros << '\n'
            << "RemoteSocketToProcessMaximumUs." << participant.participantId << ": "
            << participant.returnStages.maximumSocketToProcessMicros << '\n'
            << "RemoteProcessToDecisionLatestUs." << participant.participantId << ": "
            << participant.returnStages.latestProcessToDecisionMicros << '\n'
            << "RemoteProcessToDecisionMaximumUs." << participant.participantId << ": "
            << participant.returnStages.maximumProcessToDecisionMicros << '\n'
            << "RemoteProcessToQueueLatestUs." << participant.participantId << ": "
            << participant.returnStages.latestProcessToQueueMicros << '\n'
            << "RemoteProcessToQueueMaximumUs." << participant.participantId << ": "
            << participant.returnStages.maximumProcessToQueueMicros << '\n'
            << "RemoteInterPeerAlignmentErrorFrames." << participant.participantId << ": "
            << participant.interPeerAlignmentErrorFrames << '\n'
            << "RemoteQueueAlignmentErrorFrames." << participant.participantId << ": "
            << participant.queueAlignmentErrorFrames << '\n';
        for (const auto& packet : participant.packetTrace)
            out << "RemotePacketTrace." << participant.participantId << ": "
                << "generation=" << packet.generation.value()
                << ";streamEpoch=" << packet.streamEpoch
                << ";sequence=" << packet.sequence
                << ";musicalFrame=" << packet.musicalFrame
                << ";serverIngressFrames=" << packet.serverIngressFrames
                << ";serverCollectionFrames=" << packet.serverCollectionFrames
                << ";serverSendTimelineFrame=" << packet.serverSendTimelineFrame
                << ";socketReceiveMicros=" << packet.socketReceiveMicros
                << ";processingMicros=" << packet.processingMicros
                << ";decisionMicros=" << packet.decisionMicros
                << ";socketTimelineFrame=" << packet.socketTimelineFrame
                << ";receiveTimelineFrame=" << packet.receiveTimelineFrame
                << ";decisionTimelineFrame=" << packet.decisionTimelineFrame
                << ";targetDelayFrames=" << packet.targetDelayFrames
                << ";targetPresentationFrame=" << packet.targetPresentationFrame
                << ";receiveSlackFrames=" << packet.receiveSlackFrames
                << ";socketPresentationSlackFrames=" << packet.socketPresentationSlackFrames
                << ";decisionSlackFrames=" << packet.decisionSlackFrames
                << ";dueInFrames=" << packet.dueInFrames
                << ";queueFillFrames=" << packet.queueFillFrames
                << ";lateSkipFrames=" << packet.lateSkipFrames
                << ";nonzero=" << packet.nonzero
                << ";decision=" << packet.decision << '\n';
    }
    for (std::uint32_t channel = 0; channel < backend.inputChannelCount; ++channel)
        out << "AsioInputChannelName." << channel << ": "
            << backend.inputChannelNames[channel].data() << '\n'
            << "AsioInputChannelRms." << channel << ": " << rt.inputChannelRms[channel] << '\n';
    if (backend.inputChannelCount)
        out << "AsioSelectedInputChannel: " << rt.selectedInputChannel << '\n';
    if (failureSnapshot_.valid) {
        out << "LastFailureCategory: " << failureCategoryName(failureSnapshot_.failure.category)
            << '\n'
            << "LastFailureSeverity: " << failureSeverityName(failureSnapshot_.failure.severity)
            << '\n'
            << "LastFailureCode: " << failureSnapshot_.failure.code << '\n'
            << "LastFailureMessage: " << failureSnapshot_.failure.message << '\n'
            << "FailureGenerationId: " << failureSnapshot_.generationId << '\n'
            << "FailureSessionFrame: " << failureSnapshot_.sessionFrame << '\n'
            << "FailureClockBridgeFill: " << failureSnapshot_.clockBridgeFillFrames << '\n'
            << "FailureRecordingQueueFill: " << failureSnapshot_.recordingQueueFillFrames << '\n'
            << "FailureNetworkSendQueueFill: " << failureSnapshot_.networkSendQueueFillFrames
            << '\n'
            << "FailureNetworkReceiveQueueFill: " << failureSnapshot_.networkReceiveQueueFillFrames
            << '\n'
            << "FailureXRuns: " << failureSnapshot_.backendState.xruns << '\n'
            << "FailureDeadlineMisses: " << failureSnapshot_.backendState.deadlineMisses << '\n';
    }
    return out.str();
}
