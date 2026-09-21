#include "app/AudioService.hpp"
#include "backend/fake/FakeAudioBackend.hpp"
#include "recording/RecordingEngine.hpp"

#include <filesystem>
#include <iostream>
#include <memory>
#include <string>

namespace {
bool expectStatus(const ControlResponse& response, ControlStatus expected, const char* gate,
                  std::size_t iteration) {
    if (response.status == expected)
        return true;
    std::cerr << gate << " failed at iteration " << iteration << ": " << response.text << '\n';
    return false;
}

bool startStopGate() {
    auto backend = std::make_unique<FakeAudioBackend>();
    AudioService service{std::move(backend)};
    service.start();
    constexpr std::size_t Cycles = 10'000;
    for (std::size_t cycle = 0; cycle < Cycles; ++cycle) {
        if (!expectStatus(service.handleLine("1|PrepareSession|backend=fake|rate=48000|period=128"),
                          ControlStatus::Ok, "10k start/stop prepare", cycle) ||
            !expectStatus(service.handleLine("1|StartSession"), ControlStatus::Ok,
                          "10k start/stop start", cycle) ||
            !expectStatus(service.handleLine("1|StopSession"), ControlStatus::Ok,
                          "10k start/stop stop", cycle)) {
            return false;
        }
    }
    return service.session().state() == SessionState::Idle;
}

bool reconfigurationGate() {
    auto backend = std::make_unique<FakeAudioBackend>();
    AudioService service{std::move(backend)};
    service.start();
    if (!expectStatus(service.handleLine("1|PrepareSession|backend=fake|rate=48000|period=128"),
                      ControlStatus::Ok, "reconfiguration prepare", 0) ||
        !expectStatus(service.handleLine("1|StartSession"), ControlStatus::Ok,
                      "reconfiguration start", 0)) {
        return false;
    }

    constexpr std::size_t Cycles = 1'000;
    for (std::size_t cycle = 0; cycle < Cycles; ++cycle) {
        const auto command = cycle % 2 == 0 ? "1|Reconfigure|backend=fake|rate=44100|period=144"
                                            : "1|Reconfigure|backend=fake|rate=48000|period=128";
        if (!expectStatus(service.handleLine(command), ControlStatus::Ok, "1k reconfiguration",
                          cycle)) {
            return false;
        }
    }
    return service.session().state() == SessionState::Running;
}

bool recordingGate() {
    const auto path = std::filesystem::temp_directory_path() / "audioservice-release-recording.wav";
    RecordingEngine recording;
    constexpr GenerationId Generation{1};
    recording.setGeneration(Generation);
    constexpr std::size_t Cycles = 1'000;

    for (std::size_t cycle = 0; cycle < Cycles; ++cycle) {
        recording.prepare("release-" + std::to_string(cycle), path.string(), 48000, 1,
                          RecordingTap::RawInput, 1024);
        recording.start(SessionFrame{0}, 0);
        const auto result = recording.stop(SessionFrame{0});
        if (!result.finalized || recording.state() != RecordingState::Finished) {
            std::cerr << "1k recording cycles failed at iteration " << cycle << '\n';
            std::filesystem::remove(path);
            return false;
        }
    }
    std::filesystem::remove(path);
    return true;
}
} // namespace

int main() {
    if (!startStopGate())
        return 1;
    if (!reconfigurationGate())
        return 1;
    if (!recordingGate())
        return 1;
    std::cout << "Release repetition gates passed\n";
    return 0;
}
