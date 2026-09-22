#include "TestHarness.hpp"
#include "recording/RecordingEngine.hpp"
#include "app/AudioService.hpp"
#include "backend/fake/FakeAudioBackend.hpp"
#include "media/WavDecoder.hpp"

#include <algorithm>
#include <filesystem>
#include <ranges>
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

void prepareRecordingSelectsMasterMixTap() {
    auto backend = std::make_unique<FakeAudioBackend>();
    AudioService service{std::move(backend)};
    service.start();
    service.session().prepare(RequestedConfiguration{});
    const auto path = tempRoot / "recording-master-mix.wav";

    const auto response = service.handleLine("1|PrepareRecording|id=mix|path=" + path.string() +
                                             "|tap=performance");

    expect(response.status == ControlStatus::Ok, "performance mix recording can be prepared");
    expect(service.recording().result().selectedTap == RecordingTap::PerformanceMix,
           "PrepareRecording maps performance tap to the song and configured voice mix");
}

void performanceMixRecordsVoiceWithoutMonitoring() {
    auto backend = std::make_unique<FakeAudioBackend>();
    auto* fake = backend.get();
    AudioService service{std::move(backend)};
    service.start();
    service.session().prepare(RequestedConfiguration{});
    service.session().start();
    service.realtime().setMonitoring(false);
    const auto path = tempRoot / "recording-performance-mix.wav";
    service.recording().prepare("performance", path.string(), 48000, 2,
                                RecordingTap::PerformanceMix, 48000);
    service.recording().start(SessionFrame{0}, 0);
    std::vector<float> capture(128, 0.25F), render(256, 0.0F);
    for (std::int64_t block = 0; block < 20; ++block)
        fake->pump(capture, 1, render, 2, block * 128, block * 128);
    service.recording().stop(service.realtime().sessionFrame());

    WavDecoder decoder;
    decoder.open(path.string());
    std::vector<float> recorded(4096);
    const auto frames = decoder.read(recorded, 2048);
    const auto loudest = *std::max_element(recorded.begin(), recorded.begin() + frames * 2U);
    expect(loudest > 0.01F, "performance mix contains configured microphone when monitoring is off");
    expect(std::ranges::all_of(render, [](float sample) { return sample == 0.0F; }),
           "recording the voice does not force microphone monitoring into the speakers");
}
} // namespace Tests
