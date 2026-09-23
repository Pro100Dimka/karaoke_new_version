#include "app/AudioService.hpp"

#include <array>
#include <charconv>
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
} // namespace
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
    return error == std::errc{} && end == value.data() + value.size() ? parsed : fallback;
}
std::uint64_t AudioService::uint64Value(std::string_view value, std::uint64_t fallback) {
    std::uint64_t out = fallback;
    if (!value.empty()) {
        const auto [p, e] = std::from_chars(value.data(), value.data() + value.size(), out);
        if (e != std::errc{} || p != value.data() + value.size())
            return fallback;
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
// The device period plus the driver-reported stream latency is what a sample spends in each endpoint.
void AudioService::publishDeviceLatency() noexcept {
    const auto& runtime = session_.runtime();
    latency_.set(LatencyRegistry::Stage::Capture, 0, 0,
                 runtime.inputPeriodFrames + runtime.inputLatencyFrames);
    latency_.set(LatencyRegistry::Stage::OutputDriver, 0, 0,
                 runtime.outputPeriodFrames + runtime.outputLatencyFrames);
}
RequestedConfiguration AudioService::requestFromControl(const ControlRequest& request) const {
    RequestedConfiguration out;
#ifdef _WIN32
    out.backend = BackendKind::WasapiShared;
#endif
    if (session_.generationId() != GenerationId{0})
        out = session_.requested();

    // A request names the whole device selection: an absent id means the system default, never the previous
    // session's device (its id may belong to another backend, e.g. an ASIO CLSID).
    out.inputDeviceId = std::string(request.value("input"));
    out.outputDeviceId = std::string(request.value("output"));
    out.sampleRateHz =
        static_cast<std::uint32_t>(uint64Value(request.value("rate"), out.sampleRateHz));
    out.periodFrames =
        static_cast<std::uint32_t>(uint64Value(request.value("period"), out.periodFrames));
    out.inputChannels =
        static_cast<std::uint32_t>(uint64Value(request.value("inChannels"), out.inputChannels));
    out.outputChannels =
        static_cast<std::uint32_t>(uint64Value(request.value("outChannels"), out.outputChannels));

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
        const auto& request = session_.requested();
        const auto selected =
            event.deviceId == request.inputDeviceId || event.deviceId == request.outputDeviceId;
        const auto defaultAffected =
            event.type == DeviceEventType::DefaultChanged &&
            ((event.direction == Direction::Input && request.inputDeviceId.empty()) ||
             (event.direction == Direction::Output && request.outputDeviceId.empty()));
        constexpr std::array disruptiveEvents{DeviceEventType::Removed, DeviceEventType::Disabled,
                                              DeviceEventType::PropertyChanged};
        const auto selectedDeviceDisrupted =
            selected && std::ranges::find(disruptiveEvents, event.type) != disruptiveEvents.end();
        if (selectedDeviceDisrupted || defaultAffected)
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
std::string AudioService::diagnostics() const {
    const auto rt = realtime_.snapshot();
    const auto backend = session_.backendSnapshot();
    const auto graph = graphInfo_.snapshot();
    const auto analysis = analysis_.snapshot();
    const auto music = media_.snapshot(MediaSlot::Music);
    const auto preview = media_.snapshot(MediaSlot::RecordingPreview);
    const auto net = network_.diagnostics();
    const auto sig = signal_.snapshot();
    std::ostringstream out;
    out << "ServiceState: " << serviceStateName(state_) << '\n'
        << "SessionState: " << sessionStateName(session_.state()) << '\n'
        << "generationId: " << session_.generationId() << '\n'
        << "Backend: " << session_.backendName() << '\n'
        << "RequestedSampleRate: " << session_.requested().sampleRateHz << '\n'
        << "RuntimeInputSampleRate: " << session_.runtime().inputSampleRateHz << '\n'
        << "RuntimeOutputSampleRate: " << session_.runtime().outputSampleRateHz << '\n'
        << "RuntimeInputPeriodFrames: " << session_.runtime().inputPeriodFrames << '\n'
        << "RuntimeOutputPeriodFrames: " << session_.runtime().outputPeriodFrames << '\n'
        << "RenderPaddingFrames: " << backend.renderPaddingFrames << '\n'
        << "SessionFrame: " << rt.sessionFrame << '\n'
        << "DriftPpm: " << rt.driftPpm << '\n'
        << "CorrectionRatio: " << rt.correctionRatio << '\n'
        << "ClockBridgeFill: " << rt.clockBridge.fillFrames << '/' << rt.clockBridge.capacityFrames
        << '\n'
        << "StaleCallbacks: " << rt.staleCallbacks << '\n'
        << "XRuns: " << backend.xruns << '\n'
        << "DeadlineMisses: " << backend.deadlineMisses << '\n'
        << "PlaybackState: " << playbackStateText(music.state) << '\n'
        << "PlaybackPositionFrames: " << music.sourcePositionFrames << '\n'
        << "MusicBufferFill: " << music.bufferFillFrames << '\n'
        << "PreviewState: " << playbackStateText(preview.state) << '\n'
        << "PreviewPositionFrames: " << preview.sourcePositionFrames << '\n'
        << "RadioState: " << playbackStateText(media_.snapshot(MediaSlot::Radio).state) << '\n'
        << "RecordingState: " << static_cast<int>(recording_.state()) << '\n'
        << "RecordingQueueFill: " << recording_.queueFillFrames() << '\n'
        << "InputPeak: " << sig.peak << '\n'
        << "InputRMS: " << sig.rms << '\n'
        << "InputClipping: " << sig.clipping << '\n'
        << "NetworkSendQueueFill: " << net.sendQueueFillFrames << '\n'
        << "NetworkReceiveQueueFill: " << net.receiveQueueFillFrames << '\n'
        << "NetworkPacketsSent: " << net.packetsSent << '\n'
        << "NetworkPacketsReceived: " << net.packetsReceived << '\n'
        << "NetworkDroppedSendBlocks: " << net.droppedSendBlocks << '\n'
        << "JitterTargetPackets: " << net.jitter.currentTargetPackets << '\n'
        << "NetworkRoundTripMs: " << net.timing.roundTripMs << '\n'
        << "AnalysisProcessedFrames: " << analysis.processedFrames << '\n'
        << "AnalysisDroppedFrames: " << analysis.droppedFrames << '\n'
        << "RealtimePoolBytes: " << graph.poolBytes << '\n'
        << "GraphStages: ";
    for (const auto& stage : graph.stages)
        out << stage.name << ">";
    out << '\n'
        << "TraceSize: " << trace_.size() << '\n'
        << "EstimatedLatencyFrames: " << latency_.totalFrames() << '\n'
        << "AnalysisStaleFrames: " << analysis.staleFrames << '\n'
        << "NetworkReceiveQueueOverruns: " << net.receiveQueueOverruns << '\n'
        << "NetworkStaleBlocks: " << net.staleBlocks << '\n';
    for (const auto& participant : net.participants) {
        out << "RemoteLevel." << participant.participantId << ": " << participant.level << '\n'
            << "RemoteJitterMs." << participant.participantId << ": "
            << participant.timing.interarrivalJitterMs << '\n'
            << "RemoteTargetDelayFrames." << participant.participantId << ": "
            << participant.timing.targetDelayFrames << '\n';
    }
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
