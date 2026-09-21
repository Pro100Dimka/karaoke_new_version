#include "TestHarness.hpp"
#include "ipc/ControlProtocol.hpp"

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
