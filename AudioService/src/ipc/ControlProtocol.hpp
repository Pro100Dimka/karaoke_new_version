#pragma once

#include "common/Types.hpp"

#include <cstddef>
#include <cstdint>
#include <string>
#include <string_view>
#include <utility>
#include <vector>

inline constexpr std::size_t MaxControlRequestBytes = 4096;
inline constexpr std::size_t MaxControlArguments = 32;

enum class ControlStatus {
    Ok,
    InvalidRequest,
    InvalidState,
    ProtocolVersionMismatch,
    NotSupported,
    Failed
};
enum class ControlCommand {
    GetServiceState,
    GetDevices,
    GetDiagnostics,
    PrepareSession,
    StartSession,
    StopSession,
    RecoverSession,
    SuspendSession,
    ResumeSession,
    SetMonitoring,
    SetGain,
    SetDspEnabled,
    SetDspParameter,
    Reconfigure,
    ShutdownService,
    LoadSong,
    UnloadSong,
    Play,
    Pause,
    Resume,
    Stop,
    Seek,
    SetPlaybackRate,
    SetTranspose,
    SetMusicGain,
    SetReferenceVocalGain,
    PrepareRecording,
    StartRecording,
    PauseRecording,
    ResumeRecording,
    StopRecording,
    GetRecordingState,
    GetInputLevel,
    GetSpectrum,
    StartInputTest,
    StopInputTest,
    PlayOutputTest,
    LoadPreview,
    PlayPreview,
    PausePreview,
    StopPreview,
    SeekPreview,
    SetPreviewLoop,
    LoadRecordingPreview,
    PlayRecordingPreview,
    PauseRecordingPreview,
    StopRecordingPreview,
    SeekRecordingPreview,
    PlayReferenceTone,
    LoadRadioStation,
    PlayRadio,
    PauseRadio,
    StopRadio,
    SetRadioGain,
    JoinMediaSession,
    LeaveMediaSession,
    AddRemoteParticipant,
    RemoveRemoteParticipant,
    SetRemoteGain,
    SetRemoteMute,
    GetEvents
};

struct ControlRequest {
    std::uint32_t protocolVersion{ControlProtocolVersion};
    ControlCommand command{ControlCommand::GetServiceState};
    std::vector<std::pair<std::string, std::string>> arguments;
    [[nodiscard]] std::string_view value(std::string_view key) const noexcept;
};
struct ControlResponse {
    ControlStatus status{ControlStatus::Ok};
    std::string text;
};

[[nodiscard]] bool parseControlRequest(std::string_view line, ControlRequest& request) noexcept;
[[nodiscard]] std::string serializeControlResponse(const ControlResponse& response);
[[nodiscard]] std::string_view controlCommandName(ControlCommand command) noexcept;
