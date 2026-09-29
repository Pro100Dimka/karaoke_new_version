#include "TestHarness.hpp"
#include "app/AudioService.hpp"
#include "backend/fake/FakeAudioBackend.hpp"
#include "media/WavDecoder.hpp"
#include "recording/PerformanceAligner.hpp"
#include "recording/RecordingEngine.hpp"

#include <algorithm>
#include <cfenv>
#include <chrono>
#include <filesystem>
#include <limits>
#include <ranges>
#include <thread>
#include <vector>

// Fault injection exercises disk/RIFF failures without filling the machine's disk.
struct RecordingTestAccess {
    static bool fileOpen(const RecordingEngine& recording) {
        return recording.writer_.open();
    }
    static void failOutput(WavWriter& writer) {
        writer.file_.setstate(std::ios::badbit);
    }
    static void failOutput(RecordingEngine& recording) {
        failOutput(recording.writer_);
    }
    static void nearRiffLimit(WavWriter& writer) {
        writer.dataBytes_ = 0xFFFFFFFFULL - 37U;
    }
};

namespace Tests {
void performanceAlignerPlacesVoiceOnTheMusicItWasSungTo() {
    constexpr std::uint32_t lead = 100;
    constexpr std::uint32_t block = 10;
    constexpr std::uint32_t voiceLate = 30;
    PerformanceAligner aligner;
    aligner.prepare(1, lead, block);
    std::vector<float> music(block, 0.0F), voice(block, 0.0F), out(block, 0.0F);
    std::vector<float> aligned;
    for (std::uint32_t index = 0; index < 30; ++index) {
        std::ranges::fill(music, 0.0F);
        std::ranges::fill(voice, 0.0F);
        if (index == 0)
            music[0] = 1.0F; // the beat
        if (index * block == voiceLate)
            voice[0] = 0.5F; // the singer's note on that beat arrives 30 frames later
        aligner.add(music, block, 1.0F, 0);
        aligner.add(voice, block, 1.0F, voiceLate);
        aligner.read(out, block);
        aligned.insert(aligned.end(), out.begin(), out.end());
    }
    expect(aligned[lead] == 1.5F &&
               std::count_if(aligned.begin(), aligned.end(), [](float v) { return v != 0.0F; }) == 1,
           "the late voice lands exactly on its beat, one alignment lead after the music");
}

void recordingLeadInKeepsTheFirstRecordedFrameOnItsSongPosition() {
    RecordingEngine recording;
    const auto path = (tempRoot / "lead-in.wav").string();
    recording.prepare("lead-in", path, 48000, 1, RecordingTap::RawInput, 4096);
    recording.setGeneration(GenerationId{0});
    recording.start(SessionFrame{0}, 1'000, 50);
    std::vector<float> ramp(80);
    for (std::size_t index = 0; index < ramp.size(); ++index)
        ramp[index] = static_cast<float>(index) / 100.0F;
    recording.push(GenerationId{0}, RecordingTap::RawInput, SessionFrame{0}, ramp, 80);
    const auto result = recording.stop(SessionFrame{80});
    WavDecoder decoder;
    decoder.open(path);
    std::vector<float> recorded(80);
    const auto frames = decoder.read(recorded, 80);
    expect(frames == 30 && std::abs(recorded[0] - 0.5F) < 1e-4F &&
               result.startPlaybackPosition == 1'000,
           "the alignment lead is dropped, so the first recorded frame is the start position");
}

void recordingPrepareFailureReleasesFileAndCanRetry() {
    RecordingEngine recording;
    const auto path = (tempRoot / "allocation-failure.wav").string();
    failNextAllocationOfSize(997 * sizeof(float));
    bool failed = false;
    try {
        recording.prepare("allocation", path, 48000, 1, RecordingTap::RawInput, 997);
    } catch (const std::bad_alloc&) {
        failed = true;
    }
    failNextAllocationOfSize(0);
    expect(failed && !RecordingTestAccess::fileOpen(recording) &&
               recording.state() == RecordingState::Failed,
           "failed queue allocation releases the opened WAV and publishes a failed preparation");
    recording.prepare("retry", path, 48000, 1, RecordingTap::RawInput, 997);
    recording.start(SessionFrame{0}, 0);
    expect(recording.stop(SessionFrame{0}).finalized, "a failed preparation permits a clean retry");
}

void wavWriterReportsFinalizationAndRiffFailures() {
    WavWriter writer;
    writer.open((tempRoot / "header-failure.wav").string(), 48000, 1);
    RecordingTestAccess::failOutput(writer);
    bool rejected = false;
    try {
        writer.close();
    } catch (const std::runtime_error&) {
        rejected = true;
    }
    expect(rejected, "a failed header rewrite or flush cannot be reported as a finalized WAV");
    writer.abandon();
    writer.open((tempRoot / "riff-limit.wav").string(), 48000, 1);
    RecordingTestAccess::nearRiffLimit(writer);
    rejected = false;
    try {
        writer.write(std::array<float, 2>{0.1F, 0.2F});
    } catch (const std::length_error&) {
        rejected = true;
    }
    expect(rejected, "RIFF length includes its 36-byte header overhead and must not wrap");
    writer.abandon();
}

void stopRecordingReportsWriterFailure() {
    AudioService service{std::make_unique<FakeAudioBackend>()};
    service.start();
    auto& recording = service.recording();
    recording.prepare("failed", (tempRoot / "disk-failure.wav").string(), 48000, 1,
                      RecordingTap::RawInput, 4096);
    RecordingTestAccess::failOutput(recording);
    recording.start(SessionFrame{0}, 0);
    recording.push(GenerationId{0}, RecordingTap::RawInput, SessionFrame{0},
                   std::array<float, 1>{0.2F}, 1);
    const auto deadline = std::chrono::steady_clock::now() + std::chrono::seconds(2);
    while (recording.state() != RecordingState::Failed &&
           std::chrono::steady_clock::now() < deadline)
        std::this_thread::yield();
    expect(recording.state() == RecordingState::Failed,
           "the disk fault reaches the recording state");
    const auto reply = service.handleLine("1|StopRecording");
    expect(reply.status == ControlStatus::Failed && !reply.text.empty(),
           "IPC must report a failed writer instead of returning a successful recording path");
}

void wavWriterRejectsUnrepresentableFormatsAndPartialFrames() {
    for (const auto [rate, channels] : {std::pair{48000U, 65536U}, std::pair{48000U, 32768U},
                                        std::pair{std::numeric_limits<std::uint32_t>::max(), 2U}}) {
        WavWriter writer;
        bool rejected = false;
        try {
            writer.open((tempRoot / "invalid-format.wav").string(), rate, channels);
        } catch (const std::invalid_argument&) {
            rejected = true;
        }
        expect(rejected,
               "WAV fields must represent channel count, block alignment and byte rate exactly");
    }
    WavWriter writer;
    writer.open((tempRoot / "partial-frame.wav").string(), 48000, 2);
    bool rejected = false;
    try {
        writer.write(std::array<float, 3>{0.1F, 0.2F, 0.3F});
    } catch (const std::invalid_argument&) {
        rejected = true;
    }
    expect(rejected, "WAV cannot contain a partial interleaved frame");
    writer.close();
}

void wavWriterSanitizesNonFiniteSamples() {
    WavWriter writer;
    writer.open((tempRoot / "nonfinite.wav").string(), 48000, 1);
    std::feclearexcept(FE_ALL_EXCEPT);
    writer.write(std::array<float, 3>{std::numeric_limits<float>::quiet_NaN(),
                                      std::numeric_limits<float>::infinity(), 0.5F});
    expect((std::fetestexcept(FE_INVALID) & FE_INVALID) == 0,
           "non-finite PCM never reaches integer conversion");
    writer.close();
    WavDecoder decoder;
    decoder.open((tempRoot / "nonfinite.wav").string());
    std::array<float, 3> pcm{};
    decoder.read(pcm, 3);
    expect(pcm[0] == 0.0F && pcm[1] == 0.0F && pcm[2] > 0.49F,
           "invalid PCM becomes silence without damaging valid samples");
}

void recordingOverrunsPreserveTheAudioTimeline() {
    RecordingEngine recording;
    const auto path = tempRoot / "recording-overrun-timeline.wav";
    recording.prepare("overrun", path.string(), 48000, 1, RecordingTap::RawInput, 4);
    recording.start(SessionFrame{0}, 0);
    recording.push(GenerationId{0}, RecordingTap::RawInput, SessionFrame{0},
                   std::vector<float>(8, 0.3F), 8);
    recording.push(GenerationId{0}, RecordingTap::RawInput, SessionFrame{8},
                   std::vector<float>(4, 0.5F), 4);
    const auto result = recording.stop(SessionFrame{12});
    WavDecoder decoder;
    decoder.open(path.string());
    std::vector<float> samples(12, -1.0F);
    expect(decoder.read(samples, 12) == 12 && result.durationFrames == 12,
           "dropped PCM is silence on the original timeline, not time compression");
    expect(std::ranges::all_of(std::span{samples}.first(8),
                               [](float sample) { return sample == 0.0F; }),
           "overflow silence precedes the next accepted audio block");
    expect(samples[8] > 0.49F && result.overrunCount == 1,
           "accepted PCM and overrun diagnostics remain intact");
}

void recordingStopDrainsAnInFlightProducer() {
    for (int attempt = 0; attempt < 4; ++attempt) {
        RecordingEngine recording;
        const auto path = tempRoot / "recording-stop-race.wav";
        constexpr std::uint32_t frames = 1U << 22;
        recording.prepare("race", path.string(), 48000, 1, RecordingTap::RawInput, frames);
        recording.start(SessionFrame{0}, 0);
        const std::vector<float> block(frames, 0.2F);
        std::atomic<bool> started{false};
        std::thread producer([&] {
            started.store(true);
            recording.push(GenerationId{0}, RecordingTap::RawInput, SessionFrame{0}, block, frames);
        });
        while (!started.load())
            std::this_thread::yield();
        const auto readyAt = std::chrono::steady_clock::now() + std::chrono::microseconds(100);
        while (std::chrono::steady_clock::now() < readyAt)
            std::this_thread::yield();
        const auto result = recording.stop(SessionFrame{frames});
        producer.join();
        expect(recording.queueFillFrames() == 0,
               "finalization cannot leave a late accepted block in the queue");
        WavDecoder decoder;
        decoder.open(path.string());
        std::vector<float> scratch(2048);
        std::uint64_t actualFrames = 0;
        while (const auto read = decoder.read(scratch, 2048))
            actualFrames += read;
        expect(actualFrames == result.durationFrames,
               "finalized duration matches all PCM actually written");
    }
}

void recordingGenerationChangeFinalizesTheExistingFormat() {
    RecordingEngine recording;
    const auto path = tempRoot / "recording-generation-change.wav";
    recording.setGeneration(GenerationId{1});
    recording.prepare("generation", path.string(), 44100, 1, RecordingTap::RawInput, 4096);
    recording.start(SessionFrame{0}, 0);
    recording.push(GenerationId{1}, RecordingTap::RawInput, SessionFrame{0},
                   std::vector<float>(100, 0.2F), 100);
    recording.setGeneration(GenerationId{2});
    recording.push(GenerationId{2}, RecordingTap::RawInput, SessionFrame{0},
                   std::vector<float>(200, 0.4F), 200);
    const auto result = recording.stop(SessionFrame{200});
    expect(result.stopSessionFrame == SessionFrame{100},
           "a new device timeline cannot overwrite the old recording's end frame");
    expect(result.finalized && result.durationFrames == 100,
           "device changes finalize the old recording without mixing formats");
    WavDecoder decoder;
    decoder.open(path.string());
    std::vector<float> samples(300);
    expect(decoder.read(samples, 300) == 100,
           "accepted old-generation PCM is drained instead of cleared");
}

void recordingShutdownFinalizesAcceptedPcm() {
    const auto path = tempRoot / "recording-shutdown.wav";
    {
        RecordingEngine recording;
        recording.prepare("shutdown", path.string(), 48000, 1, RecordingTap::RawInput, 4096);
        recording.start(SessionFrame{0}, 0);
        recording.push(GenerationId{0}, RecordingTap::RawInput, SessionFrame{0},
                       std::vector<float>(128, 0.2F), 128);
    }
    WavDecoder decoder;
    decoder.open(path.string());
    std::vector<float> samples(128);
    expect(decoder.read(samples, 128) == 128,
           "shutdown drains audio and publishes a valid WAV header");
}

void rawRecordingUsesTheNegotiatedInternalTimeline() {
    for (const auto inputRate : {24000U, 44100U, 96000U}) {
        FakeBackendSettings settings;
        settings.runtime.inputSampleRateHz = inputRate;
        settings.runtime.outputSampleRateHz = 48000;
        settings.runtime.inputPeriodFrames = inputRate / 100U;
        settings.runtime.outputPeriodFrames = 480;
        settings.runtime.clockRelationship = ClockRelationship::Independent;
        auto backend = std::make_unique<FakeAudioBackend>(settings);
        auto* fake = backend.get();
        AudioService service{std::move(backend)};
        service.start();
        service.session().prepare(RequestedConfiguration{});
        service.session().start();
        const auto path = tempRoot / ("raw-rate-" + std::to_string(inputRate) + ".wav");
        expect(service.handleLine("1|PrepareRecording|id=raw|path=" + path.string() + "|tap=raw")
                       .status == ControlStatus::Ok,
               "raw tap is prepared using negotiated configuration");
        service.recording().start(SessionFrame{0}, 0);
        std::vector<float> capture(inputRate / 100U, 0.2F), render(960, 0.0F);
        for (std::int64_t block = 0; block < 100; ++block)
            fake->pump(capture, 1, render, 2, block * (inputRate / 100U), block * 480);
        const auto result = service.recording().stop(service.realtime().sessionFrame());
        expect(result.sampleRateHz == 48000 && result.durationFrames == 48000,
               "one second of raw input is recorded on the internal clock after conversion");
        expect(std::abs(result.durationSeconds - 1.0) < 0.00001,
               "raw recording duration does not depend on the input device sample rate");
    }
}

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

    const auto response =
        service.handleLine("1|PrepareRecording|id=mix|path=" + path.string() + "|tap=performance");

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
    // The aligned performance trails the music by its lead (250 ms), so pump past it.
    constexpr std::int64_t blocks = 200;
    std::vector<float> capture(128, 0.25F), render(256, 0.0F);
    for (std::int64_t block = 0; block < blocks; ++block)
        fake->pump(capture, 1, render, 2, block * 128, block * 128);
    service.recording().stop(service.realtime().sessionFrame());

    WavDecoder decoder;
    decoder.open(path.string());
    std::vector<float> recorded(static_cast<std::size_t>(blocks) * 128U * 2U);
    const auto frames = decoder.read(recorded, static_cast<std::uint32_t>(blocks) * 128U);
    const auto loudest = *std::max_element(recorded.begin(), recorded.begin() + frames * 2U);
    expect(loudest > 0.01F,
           "performance mix contains configured microphone when monitoring is off");
    expect(std::ranges::all_of(render, [](float sample) { return sample == 0.0F; }),
           "recording the voice does not force microphone monitoring into the speakers");
}

void performanceMixContainsConfiguredAutoTune() {
    auto backend = std::make_unique<FakeAudioBackend>();
    auto* fake = backend.get();
    AudioService service{std::move(backend)};
    service.start();
    service.session().prepare(RequestedConfiguration{});
    service.session().start();
    service.realtime().setDspEnabled(true);
    expect(service.realtime().setDspParameter("autotune.amount", 1.0F),
           "performance recording accepts full hard-tune");
    const auto musicPath = tempRoot / "recording-autotune-silent-music.wav";
    WavWriter silentMusic;
    silentMusic.open(musicPath.string(), 48000, 2);
    silentMusic.write(std::vector<float>(48000 * 4U * 2U, 0.0F));
    silentMusic.close();
    service.media().load(MediaSlot::Music, musicPath.string());
    expect(service.media().waitUntilReady(MediaSlot::Music) == PlaybackState::Ready,
           "silent backing is ready for the karaoke performance recording");
    service.media().play(MediaContext::Karaoke);
    const auto path = tempRoot / "recording-performance-autotune.wav";
    service.recording().prepare("performance-autotune", path.string(), 48000, 2,
                                RecordingTap::PerformanceMix, 48000 * 3U);
    service.recording().start(SessionFrame{0}, 0);
    constexpr std::uint32_t rate = 48'000, frames = 128;
    constexpr double inputFrequency = 448.0;
    constexpr double twoPi = 6.28318530717958647692;
    std::vector<float> capture(frames), render(frames * 2U);
    double phase = 0.0;
    for (std::uint32_t block = 0; block < rate * 3U / frames; ++block) {
        for (auto& sample : capture) {
            sample = 0.3F * static_cast<float>(std::sin(phase));
            phase += twoPi * inputFrequency / rate;
        }
        fake->pump(capture, 1, render, 2, block * frames, block * frames);
    }
    service.recording().stop(service.realtime().sessionFrame());

    WavDecoder decoder;
    decoder.open(path.string());
    std::vector<float> recorded(rate * 3U * 2U);
    const auto recordedFrames = decoder.read(recorded, rate * 3U);
    const auto first = (recordedFrames - rate) * 2U;
    std::uint32_t crossings = 0;
    for (std::size_t index = first + 2U; index < recordedFrames * 2U; index += 2U)
        if (recorded[index - 2U] <= 0.0F && recorded[index] > 0.0F)
            ++crossings;
    expect(crossings >= 380 && crossings <= 430,
           "performance mix records the exaggerated auto-tune instead of a dry microphone");
}

namespace {
struct FollowRun {
    std::int64_t firstSoundFrame{-1};
    std::uint32_t followFrames{0};
    std::uint64_t reportedFrame{0};
    std::uint64_t reportedAtStartFrame{0}; // just after the room start, before a follower sounds
};

// Plays a scheduled room song and reports when it became audible and where it claims to be.
// `followAtBlock` < 0 follows from before the start; otherwise following is requested mid-song.
FollowRun runRoomSong(bool follow, std::int64_t followAtBlock = -1) {
    constexpr std::uint32_t block = 128, rate = 48'000, startBlock = 20, blocks = 120;
    const auto musicPath = tempRoot / "room-follow-music.wav";
    makeTestWav(musicPath, rate);
    auto backend = std::make_unique<FakeAudioBackend>();
    auto* fake = backend.get();
    AudioService service{std::move(backend)};
    service.start();
    service.session().prepare(RequestedConfiguration{});
    service.session().start();
    service.network().setSharedTimeline(true);
    // Minimum 0: this checks the follow mechanics, not when the room decides to follow.
    service.network().setFollowedParticipant(follow && followAtBlock < 0 ? "leader" : "", 0);
    service.media().load(MediaSlot::Music, musicPath.string());
    (void)service.media().waitUntilReady(MediaSlot::Music);
    // The whole run must come from decoded PCM: a busy machine must not turn into an underrun.
    const auto filledBy = std::chrono::steady_clock::now() + std::chrono::seconds(3);
    while (service.media().snapshot(MediaSlot::Music).bufferFillFrames < blocks * block &&
           std::chrono::steady_clock::now() < filledBy)
        std::this_thread::yield();
    const auto base = monotonicTicksNow() + 1'000'000'000;
    const auto ticksAt = [&](std::int64_t frame) {
        return base + frame * 1'000'000'000LL / rate;
    };
    service.media().play(MediaContext::Karaoke, ticksAt(startBlock * block));
    FollowRun run;
    std::vector<float> capture(block, 0.0F), render(block * 2U, 0.0F);
    for (std::int64_t index = 0; index < blocks; ++index) {
        const auto frame = index * block;
        std::ranges::fill(render, 0.0F);
        if (follow && index == followAtBlock)
            service.network().setFollowedParticipant("leader", 0);
        fake->pump(capture, 1, render, 2, frame, frame, ticksAt(frame));
        if (index == startBlock + 1)
            run.reportedAtStartFrame = service.roomPlaybackFrame(ticksAt(frame + block));
        const auto sound = std::ranges::find_if(render, [](float s) { return std::abs(s) > 1e-4F; });
        if (run.firstSoundFrame < 0 && sound != render.end())
            run.firstSoundFrame = frame + (sound - render.begin()) / 2;
    }
    run.followFrames = service.realtime().roomFollowFrames();
    run.reportedFrame = service.roomPlaybackFrame(ticksAt(blocks * block - block));
    service.media().stop(MediaContext::Karaoke);
    return run;
}
} // namespace

void roomFollowNeverStartsWhileTheSongIsSounding() {
    const auto leader = runRoomSong(false);
    const auto lateFollower = runRoomSong(true, 60);
    expect(lateFollower.followFrames == 0 && lateFollower.reportedFrame == leader.reportedFrame,
           "following requested mid-song waits for silence instead of drifting the music");
}

void roomFollowDelaysTheSongButKeepsTheRoomPosition() {
    const auto leader = runRoomSong(false);
    const auto follower = runRoomSong(true);
    expect(leader.followFrames == 0 && follower.followFrames > 0,
           "only a follower delays its song, by the room playout delay");
    expect(std::llabs(follower.firstSoundFrame - leader.firstSoundFrame -
                      static_cast<std::int64_t>(follower.followFrames)) <= 2,
           "the follower hears the song exactly one room playout delay later");
    expect(std::llabs(static_cast<std::int64_t>(follower.reportedFrame) -
                      static_cast<std::int64_t>(leader.reportedFrame)) <= 2,
           "the follower still reports the room position, so timers stay together");
    expect(std::llabs(static_cast<std::int64_t>(follower.reportedAtStartFrame) -
                      static_cast<std::int64_t>(leader.reportedAtStartFrame)) <= 2,
           "before its delayed start the follower already reports the room position");
}

void captureStampsCannotClaimAudioRecordedAfterItsDelivery() {
    // The fake backend stamps a packet at its delivery, as some drivers stamp a packet's end:
    // its first frame is then placed one packet length earlier, where it was physically recorded.
    auto backend = std::make_unique<FakeAudioBackend>();
    auto* fake = backend.get();
    AudioService service{std::move(backend)};
    service.start();
    service.session().prepare(RequestedConfiguration{});
    service.session().start();
    constexpr std::uint32_t block = 480;
    std::vector<float> capture(block, 0.0F), render(block * 2U, 0.0F);
    fake->pump(capture, 1, render, 2, 0, 0);
    const auto packetNs = static_cast<MonotonicTicks>(block) * 1'000'000'000LL / 48'000;
    const auto correction = service.realtime().captureStampCorrectionNs();
    expect(correction >= packetNs && correction < packetNs + 5'000'000,
           "a stamp at the packet's end is moved back to the packet's start");
    expect(service.realtime().captureAgeNs() >= 0, "no captured audio is younger than its delivery");
}

void performanceMixFollowsMusicGain() {
    const auto musicPath = tempRoot / "performance-canonical-music.wav";
    makeTestWav(musicPath, 48000);
    auto backend = std::make_unique<FakeAudioBackend>();
    auto* fake = backend.get();
    AudioService service{std::move(backend)};
    service.start();
    service.session().prepare(RequestedConfiguration{});
    service.session().start();
    service.network().setSharedTimeline(true);
    service.media().load(MediaSlot::Music, musicPath.string());
    expect(service.media().waitUntilReady(MediaSlot::Music) == PlaybackState::Ready,
           "backing track is ready for canonical room recording");
    service.realtime().setMixerGains(MixerGains{.microphone = 0.0F, .music = 0.0F});
    service.media().play(MediaContext::Karaoke);
    const auto path = tempRoot / "performance-canonical-mix.wav";
    service.recording().prepare("canonical", path.string(), 48000, 2, RecordingTap::PerformanceMix,
                                48000);
    service.recording().start(SessionFrame{0}, 0);
    std::vector<float> capture(128, 0.0F), render(256, 0.0F);
    for (std::int64_t block = 0; block < 100; ++block)
        fake->pump(capture, 1, render, 2, block * 128, block * 128);
    service.recording().stop(service.realtime().sessionFrame());
    WavDecoder decoder;
    decoder.open(path.string());
    std::vector<float> recorded(32768);
    const auto frames = decoder.read(recorded, 16384);
    const auto peak = *std::max_element(recorded.begin(), recorded.begin() + frames * 2U);
    const auto delayedPrefixPeak =
        *std::max_element(recorded.begin(), recorded.begin() + 480U * 2U);
    expect(peak < 0.001F, "performance mix mutes the backing track when the music knob is muted");
    expect(delayedPrefixPeak < 0.001F,
           "room backing track is delayed by the already-warmed shared voice target");
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

void roomMediaRendersWithoutDelayOrStretching() {
    const auto musicPath = tempRoot / "silent-room-guide-music.wav";
    const auto vocalPath = tempRoot / "delayed-room-guide-vocal.wav";
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
    service.network().setSharedTimeline(true);
    service.media().load(MediaSlot::Music, musicPath.string());
    service.media().load(MediaSlot::ReferenceVocal, vocalPath.string());
    expect(service.media().waitUntilReady(MediaSlot::Music) == PlaybackState::Ready &&
               service.media().waitUntilReady(MediaSlot::ReferenceVocal) == PlaybackState::Ready,
           "room guide tracks are ready for shared-delay verification");
    service.realtime().setMixerGains(
        MixerGains{.microphone = 0.0F, .music = 0.0F, .reference = 1.0F});
    service.media().play(MediaContext::Karaoke);

    std::vector<float> capture(128, 0.0F), render(256, 0.0F);
    float prefixPeak = 0.0F;
    float laterPeak = 0.0F;
    for (std::int64_t block = 0; block < 12; ++block) {
        fake->pump(capture, 1, render, 2, block * 128, block * 128);
        const auto peak = std::ranges::max(render);
        if (block < 3)
            prefixPeak = std::max(prefixPeak, peak);
        else
            laterPeak = std::max(laterPeak, peak);
    }
    expect(prefixPeak > 0.01F && laterPeak > 0.01F,
           "room audio begins unmodified; compensation is applied only to the scheduled start");
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
    service.realtime().setMixerGains(MixerGains{.microphone = 0.0F, .music = 1.0F, .melody = 1.0F});
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
