#include "TestHarness.hpp"
#include "app/AudioService.hpp"
#include "backend/fake/FakeAudioBackend.hpp"
#include "ipc/ControlProtocol.hpp"

#include <array>
#include <cstdlib>

namespace Tests {
void ipcParsesMonitoringCommand() {
    ControlRequest request;
    expect(parseControlRequest("1|SetMonitoring|enabled=true", request), "IPC request parsed");
    expect(request.command == ControlCommand::SetMonitoring && request.value("enabled") == "true",
           "IPC command and arguments mapped");
}

void ipcMapsRemoteParticipantCommand() {
    ControlRequest request;
    expect(parseControlRequest("1|AddRemoteParticipant|participantId=alice", request) &&
               request.command == ControlCommand::AddRemoteParticipant,
           "runtime media IPC command mapped");
}

void ipcMapsDirectPeerCommand() {
    ControlRequest request;
    expect(parseControlRequest("1|SetDirectPeer|participantId=guest|host=127.0.0.1|port=41002|"
                               "voiceToken=0000000000000001",
                               request) &&
               request.command == ControlCommand::SetDirectPeer,
           "direct room peer IPC command mapped");
}

void ipcMapsServerRoomPlayoutDelayCommand() {
    ControlRequest request;
    expect(parseControlRequest("1|SetRoomPlayoutDelay|milliseconds=84", request) &&
               request.command == ControlCommand::SetRoomPlayoutDelay &&
               request.value("milliseconds") == "84",
           "server-owned room playout delay IPC command mapped");
}

void ipcMapsDiagnosticRoomInputCommand() {
    ControlRequest request;
    expect(parseControlRequest(
               "1|SetDiagnosticRoomInput|frequencyHz=697|gain=0.1|requestedDelayMs=160",
               request) &&
               request.command == ControlCommand::SetDiagnosticRoomInput &&
               request.value("frequencyHz") == "697" && request.value("gain") == "0.1" &&
               request.value("requestedDelayMs") == "160",
           "the Multi-Electron E2E can drive deterministic microphone PCM and negotiation");
}

void ipcPacketTraceControlNeverReplacesTheMicrophoneOrDelay() {
    struct DiagnosticEnvironment {
        std::string previous;
        DiagnosticEnvironment() {
            char* value = nullptr;
            std::size_t length = 0;
            if (_dupenv_s(&value, &length, "AD_VOICE_ROOM_E2E") == 0 && value != nullptr)
                previous = value;
            std::free(value);
        }
        ~DiagnosticEnvironment() {
            _putenv_s("AD_VOICE_ROOM_E2E", previous.c_str());
        }
    } environment;
    AudioService service{std::make_unique<FakeAudioBackend>()};
    service.network().prepare(48'000, 1, 24'000, 120, GenerationId{1});
    service.network().setRoomPlayoutDelay(55.0F);
    service.network().setDiagnosticRequestedDelay(87.0F);
    const auto input = service.realtime().diagnosticRoomInputReport();
    const auto delayState = [](const NetworkDiagnostics& diagnostics) {
        return std::array{diagnostics.playoutDelayFrames, diagnostics.sharedTargetDelayFrames,
                          diagnostics.advertisedTargetDelayFrames,
                          diagnostics.roomPlayoutDelayFrames};
    };
    const auto delays = delayState(service.network().diagnostics());
    const auto prefix = (tempRoot / "ipc-packet-trace").string();
    const auto blockedPrefix = (tempRoot / "ipc-packet-trace-blocked").string();
    constexpr std::array suffixes{".sender.csv", ".receive.csv", ".render.csv", ".status.csv"};
    const auto removeExports = [&] {
        for (const auto& path : {prefix, blockedPrefix})
            for (const auto* suffix : suffixes) {
                std::error_code ignored;
                std::filesystem::remove(path + suffix, ignored);
            }
    };
    removeExports();
    std::filesystem::create_directory(blockedPrefix + ".sender.csv");
    struct Step {
        std::string arguments;
        ControlStatus status;
        const char* message;
        bool active = false;
        bool prepared = true;
        bool environmentEnabled = true;
    };
    const std::array steps{
        Step{"packetTrace=start", ControlStatus::NotSupported,
             "trace controls retain the existing Room E2E environment gate", false, false, false},
        Step{"packetTrace=unknown", ControlStatus::InvalidRequest,
             "an unknown trace action cannot fall through to microphone replacement", false, false},
        Step{"packetTrace=start|enabled=true|frequencyHz=invalid|gain=2|requestedDelayMs=250|"
             "filePath=missing-reference.wav", ControlStatus::Ok,
             "trace start prepares storage before any input or tone arguments are parsed", true},
        Step{"packetTrace=export|tracePath=" + prefix, ControlStatus::InvalidRequest,
             "an active trace cannot be exported", true},
        Step{"packetTrace=unknown", ControlStatus::InvalidRequest,
             "an invalid action leaves the current capture active", true},
        Step{"packetTrace=stop|enabled=true|frequencyHz=invalid", ControlStatus::Ok,
             "trace stop bypasses microphone and tone controls"},
        Step{"packetTrace=export", ControlStatus::InvalidRequest,
             "export requires an explicit path prefix"},
        Step{"packetTrace=export|tracePath=" + blockedPrefix, ControlStatus::InvalidRequest,
             "file export errors are reported as invalid requests"},
        Step{"packetTrace=export|tracePath=" + prefix, ControlStatus::Ok,
             "a stopped trace exports all diagnostic lanes"},
    };
    for (const auto& step : steps) {
        _putenv_s("AD_VOICE_ROOM_E2E", step.environmentEnabled ? "1" : "");
        const auto response = service.handleLine("1|SetDiagnosticRoomInput|" + step.arguments);
        const auto status = service.network().diagnosticPacketTrace().status();
        expect(response.status == step.status && status.active == step.active &&
                   status.prepared == step.prepared,
               step.message);
        expect(service.realtime().diagnosticRoomInputReport() == input &&
                   delayState(service.network().diagnostics()) == delays,
               "trace-only commands leave real microphone selection and every delay unchanged");
        if (step.active)
            for (const auto* suffix : suffixes)
                expect(!std::filesystem::exists(prefix + suffix),
                       "active export cannot publish partial packet evidence");
    }
    for (const auto* suffix : suffixes)
        expect(std::filesystem::is_regular_file(prefix + suffix),
               "stopped export writes each packet lane and its completeness status");
    removeExports();
}

void ipcMapsRecordingPreviewCommand() {
    ControlRequest request;
    expect(parseControlRequest("1|LoadRecordingPreview|path=test.wav", request) &&
               request.command == ControlCommand::LoadRecordingPreview,
           "recording preview IPC command mapped");
}

void ipcAcceptsNewlineTerminatedRequest() {
    ControlRequest request;
    expect(parseControlRequest("1|GetServiceState\n", request) &&
               request.command == ControlCommand::GetServiceState,
           "newline framing is not part of the command name");
    expect(parseControlRequest("1|SetMonitoring|enabled=true\r\n", request) &&
               request.value("enabled") == "true",
           "CRLF framing is not part of the last argument");
}

void ipcRejectsMalformedVersion() {
    ControlRequest request;
    expect(!parseControlRequest("x|GetServiceState", request),
           "malformed protocol version rejected");
}
} // namespace Tests
