#include "TestHarness.hpp"
#include "recording/RecordingEngine.hpp"

#include <filesystem>
#include <vector>

namespace Tests {
namespace {
RecordingResult runRecordingScenario(const std::filesystem::path& path) {
    RecordingEngine recording;
    recording.setGeneration(GenerationId{1});
    recording.prepare("r1", path.string(), 48000, 1, RecordingTap::RawInput, 96000);
    recording.start(SessionFrame{0}, 0);
    const std::vector<float> block(480, 0.1F);
    SessionFrame frame{0};
    for (int index = 0; index < 50; ++index) {
        recording.push(GenerationId{1}, RecordingTap::RawInput, frame, block, 480);
        frame += 480;
    }
    recording.pause(frame);
    frame += 4800;
    recording.resume(frame);
    for (int index = 0; index < 50; ++index) {
        recording.push(GenerationId{1}, RecordingTap::RawInput, frame, block, 480);
        frame += 480;
    }
    return recording.stop(frame);
}
} // namespace

void recordingDurationCountsAcceptedPcm() {
    const auto result = runRecordingScenario(tempRoot / "recording-duration.wav");
    expect(result.durationFrames == 48000, "recording duration counts accepted PCM exactly");
}

void recordingPauseCreatesGapMetadata() {
    const auto result = runRecordingScenario(tempRoot / "recording-gap.wav");
    expect(!result.gaps.empty() && result.gaps.front().frameCount == 4800,
           "recording pause stored as metadata gap");
}

void recordingWritesWav() {
    const auto path = tempRoot / "recording-file.wav";
    const auto result = runRecordingScenario(path);
    expect(result.finalized && std::filesystem::file_size(path) > 44,
           "recording finalizes and writes WAV data");
}

void recordingRejectsStaleGeneration() {
    RecordingEngine recording;
    const auto path = tempRoot / "recording-stale.wav";
    recording.setGeneration(GenerationId{2});
    recording.prepare("r2", path.string(), 48000, 1, RecordingTap::RawInput, 4096);
    recording.start(SessionFrame{0}, 0);
    const std::vector<float> block(128, 0.1F);
    recording.push(GenerationId{1}, RecordingTap::RawInput, SessionFrame{0}, block, 128);
    const auto result = recording.stop(SessionFrame{128});
    expect(result.staleBlocks == 1 && result.durationFrames == 0,
           "recording rejects stale generation PCM");
}
} // namespace Tests
