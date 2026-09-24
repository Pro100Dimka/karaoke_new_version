#include "app/AudioService.hpp"

#include <array>
#include <ranges>
#include <sstream>
#include <stdexcept>

ControlResponse AudioService::handleLine(std::string_view line) {
    ControlRequest request;
    if (!parseControlRequest(line, request))
        return {ControlStatus::InvalidRequest, "Malformed request"};
    return handle(request);
}
std::optional<ControlResponse> AudioService::handleServiceControl(const ControlRequest& request) {
    switch (request.command) {
    case ControlCommand::GetServiceState:
        return ControlResponse{ControlStatus::Ok, std::string(serviceStateName(state_))};
    case ControlCommand::GetDevices: {
        std::ostringstream out;
        for (const auto& device : devices_.enumerate()) {
            out << device.id << ',' << device.name << ',' << static_cast<int>(device.backend) << ','
                << static_cast<int>(device.direction) << ',' << device.channels << '\n';
        }
        return ControlResponse{ControlStatus::Ok, out.str()};
    }
    case ControlCommand::GetAudioCapabilities: {
        const auto config = requestFromControl(request);
        const auto sameActiveDevice = config.backend == session_.requested().backend &&
                                      config.inputDeviceId == session_.requested().inputDeviceId &&
                                      config.outputDeviceId == session_.requested().outputDeviceId;
        AudioDeviceCapabilities queriedCapabilities;
        const AudioDeviceCapabilities* capabilities = nullptr;
        if (sameActiveDevice && session_.capabilities()) {
            capabilities = &*session_.capabilities();
        } else {
            auto backend = createAudioBackend(config.backend);
            queriedCapabilities = backend->queryCapabilities(config);
            capabilities = &queriedCapabilities;
        }
        const auto writeList = [](std::ostringstream& out, std::string_view name,
                                  const std::vector<std::uint32_t>& values) {
            out << name << '=';
            for (std::size_t index = 0; index < values.size(); ++index) {
                if (index != 0)
                    out << ',';
                out << values[index];
            }
            out << '\n';
        };
        std::ostringstream out;
        writeList(out, "sampleRatesHz", capabilities->sampleRatesHz);
        writeList(out, "periodFrames", capabilities->periodFrames);
        out << "defaultSampleRateHz=" << capabilities->defaultSampleRateHz << '\n'
            << "defaultPeriodFrames=" << capabilities->defaultPeriodFrames << '\n'
            << "minPeriodFrames=" << capabilities->minPeriodFrames << '\n'
            << "maxPeriodFrames=" << capabilities->maxPeriodFrames << '\n'
            << "fundamentalPeriodFrames=" << capabilities->fundamentalPeriodFrames << '\n';
        return ControlResponse{ControlStatus::Ok, out.str()};
    }
    case ControlCommand::GetDiagnostics:
        return ControlResponse{ControlStatus::Ok, diagnostics()};
    case ControlCommand::PrepareSession: {
        auto config = requestFromControl(request);
        session_.replaceBackend(createAudioBackend(config.backend));
        session_.prepare(std::move(config));
        syncDeviceGeneration();
        return ControlResponse{ControlStatus::Ok, "Prepared"};
    }
    case ControlCommand::StartSession:
        session_.start();
        return ControlResponse{ControlStatus::Ok, "Running"};
    case ControlCommand::StopSession:
        session_.stop();
        syncDeviceGeneration();
        return ControlResponse{ControlStatus::Ok, "Idle"};
    case ControlCommand::RecoverSession: {
        const auto recovered = session_.recover();
        syncDeviceGeneration();
        return recovered ? ControlResponse{ControlStatus::Ok, "Recovered"}
                         : ControlResponse{ControlStatus::Failed, "RecoveryFailed"};
    }
    case ControlCommand::SuspendSession:
        session_.suspend();
        syncDeviceGeneration();
        return ControlResponse{ControlStatus::Ok, "Suspended"};
    case ControlCommand::ResumeSession: {
        const auto resumed = session_.resume();
        syncDeviceGeneration();
        return resumed ? ControlResponse{ControlStatus::Ok, "Resumed"}
                       : ControlResponse{ControlStatus::Failed, "ResumeFailed"};
    }
    case ControlCommand::Reconfigure: {
        auto config = requestFromControl(request);
        const auto restart = session_.state() == SessionState::Running;
        session_.stop();
        session_.replaceBackend(createAudioBackend(config.backend));
        session_.prepare(std::move(config));
        if (restart)
            session_.start();
        syncDeviceGeneration();
        return ControlResponse{ControlStatus::Ok, "Reconfigured"};
    }
    case ControlCommand::ShutdownService:
        shutdown();
        return ControlResponse{ControlStatus::Ok, "Stopped"};
    case ControlCommand::GetEvents: {
        const auto trace = trace_.snapshot();
        return ControlResponse{ControlStatus::Ok,
                               "events=" + std::to_string(trace.events.size()) +
                                   ";overwritten=" + std::to_string(trace.overwritten) +
                                   ";dropped=" + std::to_string(trace.dropped)};
    }
    default:
        return std::nullopt;
    }
}

std::optional<ControlResponse> AudioService::handleMixerControl(const ControlRequest& request) {
    switch (request.command) {
    case ControlCommand::SetMonitoring:
        realtime_.setMonitoring(boolValue(request.value("enabled"), true));
        return ControlResponse{ControlStatus::Ok, "MonitoringUpdated"};
    case ControlCommand::SetGain: {
        using GainEntry = std::pair<std::string_view, float MixerGains::*>;
        constexpr std::array gains{
            GainEntry{"mic", &MixerGains::microphone},
            GainEntry{"music", &MixerGains::music},
            GainEntry{"reference", &MixerGains::reference},
            GainEntry{"preview", &MixerGains::preview},
            GainEntry{"radio", &MixerGains::radio},
            GainEntry{"remote", &MixerGains::remote},
            GainEntry{"master", &MixerGains::master},
            GainEntry{"melody", &MixerGains::melody},
        };
        const auto target = request.value("target");
        const auto match = std::ranges::find_if(
            gains, [target](const auto& entry) { return entry.first == target; });
        if (match == gains.end()) {
            return ControlResponse{ControlStatus::InvalidRequest, "Unknown gain target"};
        }
        auto values = realtime_.mixerGains();
        values.*(match->second) = floatValue(request.value("value"), 1.0F);
        realtime_.setMixerGains(values);
        return ControlResponse{ControlStatus::Ok, "GainUpdated"};
    }
    case ControlCommand::SetDspEnabled:
        realtime_.setDspEnabled(boolValue(request.value("enabled"), true));
        return ControlResponse{ControlStatus::Ok, "DspUpdated"};
    case ControlCommand::SetDspParameter:
        return realtime_.setDspParameter(request.value("name"),
                                         floatValue(request.value("value"), 0.0F))
                   ? ControlResponse{ControlStatus::Ok, "DspParameterUpdated"}
                   : ControlResponse{ControlStatus::InvalidRequest, "Unknown DSP parameter"};
    default:
        return std::nullopt;
    }
}

std::optional<ControlResponse> AudioService::handlePlaybackControl(const ControlRequest& request) {
    switch (request.command) {
    case ControlCommand::LoadSong:
        realtime_.resetRoomBackingDelay();
        media_.load(MediaSlot::Music, std::string(request.value("instrumental")));
        if (!request.value("vocals").empty()) {
            media_.load(MediaSlot::ReferenceVocal, std::string(request.value("vocals")));
        }
        if (!request.value("melody").empty()) {
            media_.load(MediaSlot::Melody, std::string(request.value("melody")));
        }
        media_.activate(MediaContext::Karaoke);
        return ControlResponse{ControlStatus::Ok, "SongLoading"};
    case ControlCommand::UnloadSong:
        media_.unload(MediaSlot::Music);
        media_.unload(MediaSlot::ReferenceVocal);
        media_.unload(MediaSlot::Melody);
        return ControlResponse{ControlStatus::Ok, "SongUnloaded"};
    case ControlCommand::Play: {
        const auto context = contextFromControl(request);
        media_.play(context);
        return ControlResponse{ControlStatus::Ok, "Playing"};
    }
    case ControlCommand::Pause: {
        const auto context = contextFromControl(request);
        media_.pause(context);
        return ControlResponse{ControlStatus::Ok, "Paused"};
    }
    case ControlCommand::Resume: {
        const auto context = contextFromControl(request);
        media_.play(context);
        return ControlResponse{ControlStatus::Ok, "Playing"};
    }
    case ControlCommand::Stop: {
        const auto context = contextFromControl(request);
        media_.stop(context);
        if (context == MediaContext::Karaoke)
            realtime_.resetRoomBackingDelay();
        return ControlResponse{ControlStatus::Ok, "Stopped"};
    }
    case ControlCommand::Seek: {
        const auto context = contextFromControl(request);
        media_.seek(context, uint64Value(request.value("frame"), 0));
        if (context == MediaContext::Karaoke)
            realtime_.resetRoomBackingDelay();
        return ControlResponse{ControlStatus::Ok, "Seeked"};
    }
    case ControlCommand::SetPlaybackRate:
        media_.setRate(floatValue(request.value("value"), 1.0F));
        return ControlResponse{ControlStatus::Ok, "RateUpdated"};
    case ControlCommand::SetTranspose:
        media_.setTranspose(floatValue(request.value("semitones"), 0.0F));
        return ControlResponse{ControlStatus::Ok, "TransposeUpdated"};
    case ControlCommand::SetMusicGain: {
        auto gains = realtime_.mixerGains();
        gains.music = floatValue(request.value("value"), 1.0F);
        realtime_.setMixerGains(gains);
        return ControlResponse{ControlStatus::Ok, "MusicGainUpdated"};
    }
    case ControlCommand::SetReferenceVocalGain: {
        auto gains = realtime_.mixerGains();
        gains.reference = floatValue(request.value("value"), 0.0F);
        realtime_.setMixerGains(gains);
        return ControlResponse{ControlStatus::Ok, "ReferenceGainUpdated"};
    }
    default:
        return std::nullopt;
    }
}

std::optional<ControlResponse> AudioService::handleRecordingControl(const ControlRequest& request) {
    switch (request.command) {
    case ControlCommand::PrepareRecording: {
        const auto tap = request.value("tap") == "performance"
                             ? RecordingTap::PerformanceMix
                             : request.value("tap") == "master" ? RecordingTap::MasterMix
                             : request.value("tap") == "processed" ? RecordingTap::ProcessedVoice
                                                                       : RecordingTap::RawInput;
        recording_.prepare(std::string(request.value("id")), std::string(request.value("path")),
                           session_.plan().internalSampleRateHz, session_.plan().outputChannels, tap,
                           session_.plan().internalSampleRateHz);
        return ControlResponse{ControlStatus::Ok, "RecordingPrepared"};
    }
    case ControlCommand::StartRecording:
        recording_.start(realtime_.sessionFrame(),
                         media_.snapshot(MediaSlot::Music).sourcePositionFrames);
        return ControlResponse{ControlStatus::Ok, "Recording"};
    case ControlCommand::PauseRecording:
        recording_.pause(realtime_.sessionFrame());
        return ControlResponse{ControlStatus::Ok, "RecordingPaused"};
    case ControlCommand::ResumeRecording:
        recording_.resume(realtime_.sessionFrame());
        return ControlResponse{ControlStatus::Ok, "Recording"};
    case ControlCommand::StopRecording: {
        const auto result = recording_.stop(realtime_.sessionFrame());
        return ControlResponse{ControlStatus::Ok, result.filePath};
    }
    case ControlCommand::GetRecordingState:
        return ControlResponse{ControlStatus::Ok,
                               std::to_string(static_cast<int>(recording_.state()))};
    default:
        return std::nullopt;
    }
}

std::optional<ControlResponse> AudioService::handleSignalControl(const ControlRequest& request) {
    switch (request.command) {
    case ControlCommand::GetInputLevel: {
        const auto signal = signal_.snapshot();
        return ControlResponse{ControlStatus::Ok,
                               "peak=" + std::to_string(signal.peak) +
                                   ";rms=" + std::to_string(signal.rms) +
                                   ";present=" + std::to_string(signal.signalPresent) +
                                   ";clipping=" + std::to_string(signal.clipping)};
    }
    case ControlCommand::GetSpectrum: {
        std::string bands;
        for (const auto level : realtime_.outputSpectrum())
            bands += (bands.empty() ? "" : ",") + std::to_string(level);
        return ControlResponse{ControlStatus::Ok, "bands=" + bands};
    }
    case ControlCommand::StartInputTest:
        return ControlResponse{ControlStatus::Ok, "InputTestUsesOpenCapture"};
    case ControlCommand::StopInputTest:
        return ControlResponse{ControlStatus::Ok, "InputTestStopped"};
    case ControlCommand::PlayOutputTest:
        realtime_.playReferenceTone(880.0F, session_.plan().internalSampleRateHz / 4U, 0.08F);
        return ControlResponse{ControlStatus::Ok, "OutputTestStarted"};
    case ControlCommand::PlayReferenceTone:
        realtime_.playReferenceTone(
            floatValue(request.value("frequency"), 440.0F),
            static_cast<std::uint32_t>(
                uint64Value(request.value("frames"), session_.plan().internalSampleRateHz / 4U)),
            floatValue(request.value("gain"), 0.08F));
        return ControlResponse{ControlStatus::Ok, "ToneStarted"};
    default:
        return std::nullopt;
    }
}

std::optional<ControlResponse> AudioService::handlePreviewControl(const ControlRequest& request) {
    switch (request.command) {
    case ControlCommand::LoadPreview:
        media_.load(MediaSlot::Preview, std::string(request.value("path")));
        media_.activate(MediaContext::EditorPreview);
        return ControlResponse{ControlStatus::Ok, "PreviewLoading"};
    case ControlCommand::PlayPreview:
        media_.play(MediaContext::EditorPreview);
        return ControlResponse{ControlStatus::Ok, "PreviewPlaying"};
    case ControlCommand::PausePreview:
        media_.pause(MediaContext::EditorPreview);
        return ControlResponse{ControlStatus::Ok, "PreviewPaused"};
    case ControlCommand::StopPreview:
        media_.stop(MediaContext::EditorPreview);
        return ControlResponse{ControlStatus::Ok, "PreviewStopped"};
    case ControlCommand::SeekPreview:
        media_.seek(MediaContext::EditorPreview, uint64Value(request.value("frame"), 0));
        return ControlResponse{ControlStatus::Ok, "PreviewSeeked"};
    case ControlCommand::SetPreviewLoop:
        media_.setPreviewLoop(boolValue(request.value("enabled"), true),
                              uint64Value(request.value("start"), 0),
                              uint64Value(request.value("end"), 0));
        return ControlResponse{ControlStatus::Ok, "PreviewLoopUpdated"};
    case ControlCommand::LoadRecordingPreview:
        media_.load(MediaSlot::RecordingPreview, std::string(request.value("path")));
        media_.activate(MediaContext::RecordingPreview);
        return ControlResponse{ControlStatus::Ok, "RecordingPreviewLoading"};
    case ControlCommand::PlayRecordingPreview:
        media_.play(MediaContext::RecordingPreview);
        return ControlResponse{ControlStatus::Ok, "RecordingPreviewPlaying"};
    case ControlCommand::PauseRecordingPreview:
        media_.pause(MediaContext::RecordingPreview);
        return ControlResponse{ControlStatus::Ok, "RecordingPreviewPaused"};
    case ControlCommand::StopRecordingPreview:
        media_.stop(MediaContext::RecordingPreview);
        return ControlResponse{ControlStatus::Ok, "RecordingPreviewStopped"};
    case ControlCommand::SeekRecordingPreview:
        media_.seek(MediaContext::RecordingPreview, uint64Value(request.value("frame"), 0));
        return ControlResponse{ControlStatus::Ok, "RecordingPreviewSeeked"};
    default:
        return std::nullopt;
    }
}

std::optional<ControlResponse> AudioService::handleRadioControl(const ControlRequest& request) {
    switch (request.command) {
    case ControlCommand::LoadRadioStation:
        media_.load(MediaSlot::Radio, std::string(request.value("url")));
        media_.activate(MediaContext::Radio);
        return ControlResponse{ControlStatus::Ok, "RadioLoading"};
    case ControlCommand::PlayRadio:
        media_.play(MediaContext::Radio);
        return ControlResponse{ControlStatus::Ok, "RadioPlaying"};
    case ControlCommand::PauseRadio:
        media_.pause(MediaContext::Radio);
        return ControlResponse{ControlStatus::Ok, "RadioPaused"};
    case ControlCommand::StopRadio:
        media_.stop(MediaContext::Radio);
        return ControlResponse{ControlStatus::Ok, "RadioStopped"};
    case ControlCommand::SetRadioGain: {
        auto gains = realtime_.mixerGains();
        gains.radio = floatValue(request.value("value"), 1.0F);
        realtime_.setMixerGains(gains);
        return ControlResponse{ControlStatus::Ok, "RadioGainUpdated"};
    }
    default:
        return std::nullopt;
    }
}

std::optional<ControlResponse> AudioService::handleNetworkControl(const ControlRequest& request) {
    switch (request.command) {
    case ControlCommand::JoinMediaSession:
        // Warm the common room timeline before any song is loaded. Playback commands must not
        // clear these network/clock estimates or alignment will audibly converge after every start.
        network_.setSharedTimeline(true);
        network_.setLocalParticipant(std::string(request.value("localParticipantId")));
        {
            const auto token = hexUint64Value(request.value("voiceToken"), 0);
            if (token == 0)
                return ControlResponse{ControlStatus::InvalidRequest,
                                       "Missing or invalid voice token"};
            network_.setSessionToken(token);
        }
        network_.startReceive(
            static_cast<std::uint16_t>(uint64Value(request.value("localPort"), 40000)));
        if (!request.value("host").empty()) {
            network_.startSend(
                std::string(request.value("host")),
                static_cast<std::uint16_t>(uint64Value(request.value("remotePort"), 40000)));
        }
        return ControlResponse{ControlStatus::Ok, "MediaSessionJoined"};
    case ControlCommand::LeaveMediaSession:
        network_.setSharedTimeline(false);
        network_.stop();
        return ControlResponse{ControlStatus::Ok, "MediaSessionLeft"};
    case ControlCommand::AddRemoteParticipant:
        return network_.addRemoteParticipant(std::string(request.value("participantId")))
                   ? ControlResponse{ControlStatus::Ok, "RemoteParticipantAdded"}
                   : ControlResponse{ControlStatus::Failed,
                                     "Remote participant limit reached or id invalid"};
    case ControlCommand::RemoveRemoteParticipant:
        return network_.removeRemoteParticipant(request.value("participantId"))
                   ? ControlResponse{ControlStatus::Ok, "RemoteParticipantRemoved"}
                   : ControlResponse{ControlStatus::InvalidRequest, "Unknown participant"};
    case ControlCommand::SetRemoteGain: {
        const auto participantId = request.value("participantId");
        if (participantId.empty()) {
            auto gains = realtime_.mixerGains();
            gains.remote = floatValue(request.value("value"), 1.0F);
            realtime_.setMixerGains(gains);
            return ControlResponse{ControlStatus::Ok, "RemoteMasterGainUpdated"};
        }
        return network_.setRemoteGain(participantId, floatValue(request.value("value"), 1.0F))
                   ? ControlResponse{ControlStatus::Ok, "RemoteGainUpdated"}
                   : ControlResponse{ControlStatus::InvalidRequest, "Unknown participant"};
    }
    case ControlCommand::SetRemoteMute: {
        const auto participantId = request.value("participantId");
        if (participantId.empty()) {
            auto gains = realtime_.mixerGains();
            gains.remote = boolValue(request.value("muted"), true) ? 0.0F : 1.0F;
            realtime_.setMixerGains(gains);
            return ControlResponse{ControlStatus::Ok, "RemoteMasterMuteUpdated"};
        }
        return network_.setRemoteMute(participantId, boolValue(request.value("muted"), true))
                   ? ControlResponse{ControlStatus::Ok, "RemoteMuteUpdated"}
                   : ControlResponse{ControlStatus::InvalidRequest, "Unknown participant"};
    }
    case ControlCommand::SetRemoteEffect: {
        const auto participantId = request.value("participantId");
        const auto effect = request.value("effect");
        if (participantId.empty() || effect.empty())
            return ControlResponse{ControlStatus::InvalidRequest,
                                   "Participant and effect are required"};
        return network_.setRemoteEffect(participantId, effect,
                                        floatValue(request.value("value"), 0.0F))
                   ? ControlResponse{ControlStatus::Ok, "RemoteEffectUpdated"}
                   : ControlResponse{ControlStatus::InvalidRequest,
                                     "Unknown participant or effect"};
    }
    default:
        return std::nullopt;
    }
}

ControlResponse AudioService::handle(const ControlRequest& request) {
    processPendingBackendEvent();
    processDeviceEvents();
    if (request.protocolVersion != ControlProtocolVersion) {
        return {ControlStatus::ProtocolVersionMismatch, "ProtocolVersionMismatch"};
    }

    using Handler = std::optional<ControlResponse> (AudioService::*)(const ControlRequest&);
    constexpr std::array handlers{
        static_cast<Handler>(&AudioService::handleServiceControl),
        static_cast<Handler>(&AudioService::handleMixerControl),
        static_cast<Handler>(&AudioService::handlePlaybackControl),
        static_cast<Handler>(&AudioService::handleRecordingControl),
        static_cast<Handler>(&AudioService::handleSignalControl),
        static_cast<Handler>(&AudioService::handlePreviewControl),
        static_cast<Handler>(&AudioService::handleRadioControl),
        static_cast<Handler>(&AudioService::handleNetworkControl),
    };

    try {
        for (const auto handler : handlers) {
            if (auto response = (this->*handler)(request))
                return *response;
        }
    } catch (const std::logic_error& error) {
        captureFailure(
            {FailureCategory::Configuration, FailureSeverity::Recoverable, 0, error.what()});
        return {ControlStatus::InvalidState, error.what()};
    } catch (const std::exception& error) {
        captureFailure({FailureCategory::Unknown, FailureSeverity::Recoverable, 0, error.what()});
        return {ControlStatus::Failed, error.what()};
    }
    return {ControlStatus::InvalidRequest, "Unknown command"};
}
