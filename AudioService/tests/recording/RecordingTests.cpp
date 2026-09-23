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

void performanceMixExcludesReferenceVocal() {
    const auto musicPath = tempRoot / "silent-music.wav";
    const auto vocalPath = tempRoot / "reference-vocal.wav";
    WavWriter silent;
    silent.open(musicPath.string(), 48000, 2);
    silent.write(std::vector<float>(48000 * 2, 0.0F));
    silent.close();
    makeTestWav(vocalPath, 48000);

    auto backend = std::make_unique<FakeAudioBackend>();
    auto* fake = backend.get();
    AudioService service{std::move(backend)};
    service.start();
    service.session().prepare(RequestedConfiguration{});
    service.session().start();
    service.media().load(MediaSlot::Music, musicPath.string());
    service.media().load(MediaSlot::ReferenceVocal, vocalPath.string());
    expect(service.media().waitUntilReady(MediaSlot::Music) == PlaybackState::Ready &&
               service.media().waitUntilReady(MediaSlot::ReferenceVocal) == PlaybackState::Ready,
           "karaoke tracks are ready for the performance recording test");
    service.realtime().setMixerGains(
        MixerGains{.microphone = 0.0F, .music = 1.0F, .reference = 1.0F});
    service.media().play(MediaContext::Karaoke);

    const auto path = tempRoot / "performance-without-reference.wav";
    service.recording().prepare("without-reference", path.string(), 48000, 2,
                                RecordingTap::PerformanceMix, 48000);
    service.recording().start(SessionFrame{0}, 0);
    std::vector<float> capture(128, 0.0F), render(256, 0.0F);
    float speakerPeak = 0.0F;
    for (std::int64_t block = 0; block < 100; ++block) {
        fake->pump(capture, 1, render, 2, block * 128, block * 128);
        for (const auto sample : render)
            speakerPeak = std::max(speakerPeak, std::abs(sample));
    }
    service.recording().stop(service.realtime().sessionFrame());

    WavDecoder decoder;
    decoder.open(path.string());
    std::vector<float> recorded(32768);
    const auto frames = decoder.read(recorded, 16384);
    float recordingPeak = 0.0F;
    for (std::size_t index = 0; index < frames * 2U; ++index)
        recordingPeak = std::max(recordingPeak, std::abs(recorded[index]));
    expect(speakerPeak > 0.05F, "reference vocal remains audible in karaoke speakers");
    expect(recordingPeak < 0.001F, "reference vocal is excluded from the performance mix");
}

void performanceMixExcludesMelody() {
    const auto musicPath = tempRoot / "silent-music-melody.wav";
    const auto melodyPath = tempRoot / "melody-reference.wav";
    WavWriter silent;
    silent.open(musicPath.string(), 48000, 2);
    silent.write(std::vector<float>(48000 * 2, 0.0F));
    silent.close();
    makeTestWav(melodyPath, 48000);

    auto backend = std::make_unique<FakeAudioBackend>();
    auto* fake = backend.get();
    AudioService service{std::move(backend)};
    service.start();
    service.session().prepare(RequestedConfiguration{});
    service.session().start();
    service.media().load(MediaSlot::Music, musicPath.string());
    service.media().load(MediaSlot::Melody, melodyPath.string());
    expect(service.media().waitUntilReady(MediaSlot::Music) == PlaybackState::Ready &&
               service.media().waitUntilReady(MediaSlot::Melody) == PlaybackState::Ready,
           "karaoke tracks are ready for the melody performance recording test");
    service.realtime().setMixerGains(
        MixerGains{.microphone = 0.0F, .music = 1.0F, .melody = 1.0F});
    service.media().play(MediaContext::Karaoke);

    const auto path = tempRoot / "performance-without-melody.wav";
    service.recording().prepare("without-melody", path.string(), 48000, 2,
                                RecordingTap::PerformanceMix, 48000);
    service.recording().start(SessionFrame{0}, 0);
    std::vector<float> capture(128, 0.0F), render(256, 0.0F);
    float speakerPeak = 0.0F;
    for (std::int64_t block = 0; block < 100; ++block) {
        fake->pump(capture, 1, render, 2, block * 128, block * 128);
        for (const auto sample : render)
            speakerPeak = std::max(speakerPeak, std::abs(sample));
    }
    service.recording().stop(service.realtime().sessionFrame());

    WavDecoder decoder;
    decoder.open(path.string());
    std::vector<float> recorded(32768);
    const auto frames = decoder.read(recorded, 16384);
    float recordingPeak = 0.0F;
    for (std::size_t index = 0; index < frames * 2U; ++index)
        recordingPeak = std::max(recordingPeak, std::abs(recorded[index]));
    expect(speakerPeak > 0.05F, "melody reference remains audible in karaoke speakers");
    expect(recordingPeak < 0.001F, "melody reference is excluded from the performance mix");
}
} // namespace Tests
