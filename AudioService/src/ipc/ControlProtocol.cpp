#include "ipc/ControlProtocol.hpp"

#include <array>
#include <charconv>
#include <exception>
#include <ranges>

namespace {
using Entry = std::pair<std::string_view, ControlCommand>;

constexpr std::array commands{
    Entry{"GetServiceState", ControlCommand::GetServiceState},
    Entry{"GetDevices", ControlCommand::GetDevices},
    Entry{"GetAudioCapabilities", ControlCommand::GetAudioCapabilities},
    Entry{"GetDiagnostics", ControlCommand::GetDiagnostics},
    Entry{"PrepareSession", ControlCommand::PrepareSession},
    Entry{"StartSession", ControlCommand::StartSession},
    Entry{"StopSession", ControlCommand::StopSession},
    Entry{"RecoverSession", ControlCommand::RecoverSession},
    Entry{"SuspendSession", ControlCommand::SuspendSession},
    Entry{"ResumeSession", ControlCommand::ResumeSession},
    Entry{"SetMonitoring", ControlCommand::SetMonitoring},
    Entry{"SetGain", ControlCommand::SetGain},
    Entry{"SetDspEnabled", ControlCommand::SetDspEnabled},
    Entry{"SetDspParameter", ControlCommand::SetDspParameter},
    Entry{"Reconfigure", ControlCommand::Reconfigure},
    Entry{"ShutdownService", ControlCommand::ShutdownService},
    Entry{"LoadSong", ControlCommand::LoadSong},
    Entry{"UnloadSong", ControlCommand::UnloadSong},
    Entry{"Play", ControlCommand::Play},
    Entry{"Pause", ControlCommand::Pause},
    Entry{"Resume", ControlCommand::Resume},
    Entry{"Stop", ControlCommand::Stop},
    Entry{"Seek", ControlCommand::Seek},
    Entry{"SetPlaybackRate", ControlCommand::SetPlaybackRate},
    Entry{"SetTranspose", ControlCommand::SetTranspose},
    Entry{"SetMusicGain", ControlCommand::SetMusicGain},
    Entry{"SetReferenceVocalGain", ControlCommand::SetReferenceVocalGain},
    Entry{"PrepareRecording", ControlCommand::PrepareRecording},
    Entry{"StartRecording", ControlCommand::StartRecording},
    Entry{"PauseRecording", ControlCommand::PauseRecording},
    Entry{"ResumeRecording", ControlCommand::ResumeRecording},
    Entry{"StopRecording", ControlCommand::StopRecording},
    Entry{"GetRecordingState", ControlCommand::GetRecordingState},
    Entry{"GetInputLevel", ControlCommand::GetInputLevel},
    Entry{"GetSpectrum", ControlCommand::GetSpectrum},
    Entry{"StartInputTest", ControlCommand::StartInputTest},
    Entry{"StopInputTest", ControlCommand::StopInputTest},
    Entry{"PlayOutputTest", ControlCommand::PlayOutputTest},
    Entry{"LoadPreview", ControlCommand::LoadPreview},
    Entry{"PlayPreview", ControlCommand::PlayPreview},
    Entry{"PausePreview", ControlCommand::PausePreview},
    Entry{"StopPreview", ControlCommand::StopPreview},
    Entry{"SeekPreview", ControlCommand::SeekPreview},
    Entry{"SetPreviewLoop", ControlCommand::SetPreviewLoop},
    Entry{"LoadRecordingPreview", ControlCommand::LoadRecordingPreview},
    Entry{"PlayRecordingPreview", ControlCommand::PlayRecordingPreview},
    Entry{"PauseRecordingPreview", ControlCommand::PauseRecordingPreview},
    Entry{"StopRecordingPreview", ControlCommand::StopRecordingPreview},
    Entry{"SeekRecordingPreview", ControlCommand::SeekRecordingPreview},
    Entry{"PlayReferenceTone", ControlCommand::PlayReferenceTone},
    Entry{"LoadRadioStation", ControlCommand::LoadRadioStation},
    Entry{"PlayRadio", ControlCommand::PlayRadio},
    Entry{"PauseRadio", ControlCommand::PauseRadio},
    Entry{"StopRadio", ControlCommand::StopRadio},
    Entry{"SetRadioGain", ControlCommand::SetRadioGain},
    Entry{"JoinMediaSession", ControlCommand::JoinMediaSession},
    Entry{"SetRoomClock", ControlCommand::SetRoomClock},
    Entry{"LeaveMediaSession", ControlCommand::LeaveMediaSession},
    Entry{"AddRemoteParticipant", ControlCommand::AddRemoteParticipant},
    Entry{"RemoveRemoteParticipant", ControlCommand::RemoveRemoteParticipant},
    Entry{"SetRemoteGain", ControlCommand::SetRemoteGain},
    Entry{"SetRemoteMute", ControlCommand::SetRemoteMute},
    Entry{"SetRemoteEffect", ControlCommand::SetRemoteEffect},
    Entry{"SetDirectPeer", ControlCommand::SetDirectPeer},
    Entry{"GetEvents", ControlCommand::GetEvents},
};

std::string_view takeField(std::string_view& input) noexcept {
    const auto separator = input.find('|');
    if (separator == std::string_view::npos) {
        const auto field = input;
        input = {};
        return field;
    }

    const auto field = input.substr(0, separator);
    input.remove_prefix(separator + 1U);
    return field;
}
} // namespace

std::string_view ControlRequest::value(std::string_view key) const noexcept {
    const auto it =
        std::ranges::find_if(arguments, [key](const auto& item) { return item.first == key; });
    return it == arguments.end() ? std::string_view{} : std::string_view{it->second};
}

std::string_view controlCommandName(ControlCommand command) noexcept {
    const auto it = std::ranges::find_if(
        commands, [command](const auto& item) { return item.second == command; });
    return it == commands.end() ? std::string_view{"Unknown"} : it->first;
}

bool parseControlRequest(std::string_view line, ControlRequest& request) noexcept {
    // Clients terminate every request with a newline; it is framing, not part of the last field.
    while (!line.empty() && (line.back() == '\n' || line.back() == '\r'))
        line.remove_suffix(1U);
    if (line.empty() || line.size() > MaxControlRequestBytes)
        return false;

    try {
        request = {};
        request.arguments.reserve(MaxControlArguments);

        const auto versionText = takeField(line);
        const auto commandText = takeField(line);
        if (versionText.empty() || commandText.empty())
            return false;

        std::uint32_t version = 0;
        const auto [versionEnd, versionError] =
            std::from_chars(versionText.data(), versionText.data() + versionText.size(), version);
        if (versionError != std::errc{} || versionEnd != versionText.data() + versionText.size()) {
            return false;
        }

        const auto command = std::ranges::find_if(
            commands, [commandText](const auto& item) { return item.first == commandText; });
        if (command == commands.end())
            return false;

        request.protocolVersion = version;
        request.command = command->second;

        while (!line.empty()) {
            if (request.arguments.size() == MaxControlArguments)
                return false;

            const auto argument = takeField(line);
            const auto equals = argument.find('=');
            if (equals == std::string_view::npos)
                continue;

            request.arguments.emplace_back(std::string{argument.substr(0, equals)},
                                           std::string{argument.substr(equals + 1U)});
        }
        return true;
    } catch (const std::exception&) {
        return false;
    }
}

std::string serializeControlResponse(const ControlResponse& response) {
    return std::to_string(static_cast<int>(response.status)) + "|" + response.text + "\n";
}
