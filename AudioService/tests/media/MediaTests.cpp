#include "TestHarness.hpp"
#include "media/MediaController.hpp"
#include "media/MediaSource.hpp"
#include "media/RateTransposeProcessor.hpp"
#include "media/WavDecoder.hpp"

#include <algorithm>
#include <atomic>
#include <cmath>
#include <memory>
#include <semaphore>
#include <vector>

namespace Tests {
namespace {
class BlockingDecoder final : public IAudioDecoder {
  public:
    DecodedAudioFormat open(const std::string&) override {
        position_.store(0, std::memory_order_relaxed);
        return {48000, 1, 10000};
    }

    std::uint32_t read(std::span<float> output, std::uint32_t maxFrames) override {
        const auto call = reads_.fetch_add(1, std::memory_order_relaxed);
        if (call == 0) {
            firstReadEntered_.release();
            allowFirstRead_.acquire();
        }
        const auto frames = std::min<std::uint32_t>(maxFrames, 512U);
        const auto value = position_.load(std::memory_order_relaxed) >= 5000 ? 0.75F : 0.25F;
        std::fill_n(output.data(), frames, value);
        position_.fetch_add(frames, std::memory_order_relaxed);
        return frames;
    }

    void seek(std::uint64_t frame) override {
        position_.store(frame, std::memory_order_relaxed);
    }
    void cancel() noexcept override {}
    void close() noexcept override {}
    void waitForFirstRead() {
        firstReadEntered_.acquire();
    }
    void releaseFirstRead() {
        allowFirstRead_.release();
    }

  private:
    std::binary_semaphore firstReadEntered_{0};
    std::binary_semaphore allowFirstRead_{0};
    std::atomic<std::uint32_t> reads_{0};
    std::atomic<std::uint64_t> position_{0};
};

std::filesystem::path mediaPath() {
    const auto path = tempRoot / "media.wav";
    makeTestWav(path, 9600);
    return path;
}
} // namespace

void wavDecoderReportsFormat() {
    WavDecoder decoder;
    const auto format = decoder.open(mediaPath().string());
    expect(format.sampleRateHz == 48000 && format.channels == 2, "WAV decoder reports format");
}

void wavDecoderSeekIsDeterministic() {
    WavDecoder decoder;
    decoder.open(mediaPath().string());
    std::vector<float> first(200), second(200);
    expect(decoder.read(first, 100) == 100, "WAV decoder reads initial frames");
    decoder.seek(0);
    expect(decoder.read(second, 100) == 100 && first == second,
           "WAV decoder seek is deterministic");
}

void slowerRateProducesMoreFrames() {
    RateTransposeProcessor processor;
    processor.prepare(48000, 48000, 1, 2048);
    processor.setRate(0.75F);
    std::vector<float> input(2048, 0.1F), output(8192);
    expect(processor.process(input, 2048, output) > 2048,
           "slower media rate produces more output frames");
}

void pitchProcessingFlushesTheFinalAudio() {
    for (const float transpose : {-12.0F, 7.0F, 12.0F}) {
        RateTransposeProcessor processor;
        processor.prepare(48000, 48000, 1, 1024);
        processor.setTranspose(transpose);
        std::vector<float> input(1024), output(processor.maximumOutputFrames());
        std::fill(input.end() - 32, input.end(), 0.5F);
        (void)processor.process(input, 1024, output);
        const auto tail = processor.process({}, 0, output);
        expect(tail > 0 && std::any_of(output.begin(), output.begin() + tail,
                                       [](float sample) { return std::abs(sample) > 0.01F; }),
               "EOF must drain delayed pitch audio instead of cutting off the final note");
        expect(tail <= processor.latencyFrames(),
               "reported pitch latency bounds the processor's delayed tail");
        expect(processor.process({}, 0, output) == 0, "pitch tail can only be drained once");
    }

    const auto path = tempRoot / "pitch-tail.wav";
    WavWriter writer;
    writer.open(path.string(), 48000, 1);
    std::vector<float> input(1024);
    std::fill(input.end() - 32, input.end(), 0.5F);
    writer.write(input);
    writer.close();
    MediaSource source{std::make_unique<WavDecoder>()};
    source.prepareOutput(48000, 1, 127);
    source.setTranspose(12);
    source.load(path.string());
    expect(source.waitUntilReady() == PlaybackState::Ready,
           "small queue preloads transposed media");
    source.play();
    std::vector<float> output(61);
    std::uint64_t rendered = 0;
    bool heardFinalNote = false;
    const auto deadline = std::chrono::steady_clock::now() + std::chrono::seconds(3);
    while (source.snapshot().state == PlaybackState::Playing &&
           std::chrono::steady_clock::now() < deadline) {
        const auto count = source.render(output, 61);
        rendered += count;
        heardFinalNote =
            heardFinalNote || std::any_of(output.begin(), output.begin() + count,
                                          [](float sample) { return std::abs(sample) > 0.01F; });
        std::this_thread::sleep_for(std::chrono::milliseconds(1));
    }
    expect(heardFinalNote && rendered == input.size() + source.processingLatencyFrames() &&
               source.snapshot().state == PlaybackState::Finished &&
               source.snapshot().sourcePositionFrames == input.size(),
           "a tail larger than the queue drains completely before Finished without advancing "
           "beyond duration");
}

void mediaResamplingPreservesEveryFrameAcrossChunks() {
    RateTransposeProcessor processor;
    processor.prepare(48000, 48000, 1, 2048);
    std::vector<float> input(2048), output(8192);
    bool exact = true;
    for (int block = 0; block < 8; ++block) {
        for (std::size_t frame = 0; frame < input.size(); ++frame)
            input[frame] = static_cast<float>(block * input.size() + frame);
        const auto count = processor.process(input, 2048, output);
        exact = exact && count == input.size() &&
                std::equal(input.begin(), input.end(), output.begin());
    }
    expect(exact, "unity-rate playback must retain the last sample of every decode block");

    struct Format {
        std::uint32_t inputRate;
        std::uint32_t outputRate;
        float speed;
    };
    for (const auto config : {Format{44100, 48000, 1}, Format{48000, 8000, 1},
                              Format{8000, 192000, 0.5F}, Format{48000, 48000, 0.75F}}) {
        RateTransposeProcessor stream;
        stream.prepare(config.inputRate, config.outputRate, 1, 64);
        stream.setRate(config.speed);
        std::vector<float> chunk(63, 0.1F), converted(8192);
        std::uint64_t total = 0;
        for (int index = 0; index < 8; ++index)
            total += stream.process(chunk, 63, converted);
        total += stream.process({}, 0, converted); // interpolation interval and delayed pitch audio
        const auto expected = static_cast<std::uint64_t>(std::ceil(
                                  8.0 * 63 * config.outputRate /
                                  (config.inputRate * static_cast<double>(config.speed)))) +
                              stream.latencyFrames();
        expect(total == expected, "runtime conversion " + std::to_string(config.inputRate) + "->" +
                                      std::to_string(config.outputRate) + " produced " +
                                      std::to_string(total) + " frames, expected " +
                                      std::to_string(expected));
    }
}

void mediaEofFinishesWithTheExactSampleCount() {
    MediaSource source{std::make_unique<WavDecoder>()};
    source.prepareOutput(48000, 2, 4096);
    source.load(mediaPath().string());
    expect(source.waitUntilReady() == PlaybackState::Ready, "file preloads before playback");
    source.play();
    std::vector<float> output(256);
    std::uint64_t total = 0;
    const auto deadline = std::chrono::steady_clock::now() + std::chrono::seconds(2);
    while (source.snapshot().state == PlaybackState::Playing &&
           std::chrono::steady_clock::now() < deadline) {
        total += source.render(output, 128);
        std::this_thread::sleep_for(std::chrono::milliseconds(1));
    }
    expect(total == 9600, "playback never loses samples between decoder blocks");
    expect(source.snapshot().state == PlaybackState::Finished,
           "draining a file transitions to Finished without waiting for nonexistent frames");
    source.seek(4800);
    source.play();
    expect(source.snapshot().sourcePositionFrames == 4800,
           "resuming at a selected position after EOF must not restart at zero");

    for (const auto rates :
         {std::pair{48000U, 44100U}, std::pair{8000U, 192000U}, std::pair{48000U, 8000U}}) {
        const auto path = tempRoot / "runtime-rate.wav";
        WavWriter writer;
        writer.open(path.string(), rates.first, 1);
        writer.write(std::vector<float>(960, 0.2F));
        writer.close();
        MediaSource converted{std::make_unique<WavDecoder>()};
        converted.prepareOutput(rates.second, 1, 257);
        converted.load(path.string());
        const auto readyDeadline = std::chrono::steady_clock::now() + std::chrono::seconds(2);
        while (converted.snapshot().state == PlaybackState::Loading &&
               std::chrono::steady_clock::now() < readyDeadline)
            std::this_thread::sleep_for(std::chrono::milliseconds(1));
        const auto ready = converted.snapshot().state == PlaybackState::Ready;
        expect(ready,
               "a decode block larger than the PCM queue still preloads without dropping data");
        if (!ready)
            continue;
        converted.play();
        const auto endDeadline = std::chrono::steady_clock::now() + std::chrono::seconds(5);
        std::uint64_t rendered = 0;
        while (converted.snapshot().state == PlaybackState::Playing &&
               std::chrono::steady_clock::now() < endDeadline) {
            rendered += converted.render(output, 127);
            std::this_thread::sleep_for(std::chrono::milliseconds(1));
        }
        const auto expected =
            static_cast<std::uint64_t>(std::ceil(960.0 * rates.second / rates.first));
        expect(
            rendered == expected && converted.snapshot().state == PlaybackState::Finished,
            "device-rate conversion drains all PCM and the interpolation tail before Finished: " +
                std::to_string(rates.first) + " -> " + std::to_string(rates.second) +
                ", rendered=" + std::to_string(rendered) +
                ", expected=" + std::to_string(expected) +
                ", state=" + std::to_string(static_cast<int>(converted.snapshot().state)));
    }
}

void changingMediaRateDoesNotMoveAlreadyRenderedPosition() {
    MediaSource source{std::make_unique<WavDecoder>()};
    source.prepareOutput(48000, 2, 4096);
    source.load(mediaPath().string());
    (void)source.waitUntilReady();
    source.play();
    std::vector<float> output(256);
    (void)source.render(output, 128);
    const auto before = source.timelineFrame();
    source.setRate(1.5F);
    expect(source.timelineFrame() == before,
           "a tempo request cannot retroactively retime samples already heard");
    const auto deadline = std::chrono::steady_clock::now() + std::chrono::seconds(2);
    while (source.snapshot().bufferFillFrames < 128 && std::chrono::steady_clock::now() < deadline)
        std::this_thread::yield();
    expect(source.render(output, 128) == 128 && source.timelineFrame() == before + 192,
           "newly rendered PCM uses the new speed without replaying old queued tempo");
}

void mediaPositionsUseTheCorrectClockDomain() {
    MediaController media;
    media.prepare(44100, 2, 4096);
    media.load(MediaSlot::Music, mediaPath().string());
    (void)media.waitUntilReady(MediaSlot::Music);
    media.play(MediaContext::Karaoke);
    std::vector<float> output(882);
    expect(media.render(MediaSlot::Music, output, 441) == 441 &&
               media.timelineFrame(MediaSlot::Music) == 441 &&
               media.snapshot(MediaSlot::Music).sourcePositionFrames == 480,
           "source position uses file frames while transport uses output-clock frames");
    media.seek(MediaContext::Karaoke, 4410);
    expect(media.snapshot(MediaSlot::Music).sourcePositionFrames == 4800 &&
               media.timelineFrame(MediaSlot::Music) == 4410,
           "transport seek converts output-clock frames to source frames");
    media.seek(MediaContext::Karaoke, UINT64_MAX);
    expect(media.snapshot(MediaSlot::Music).sourcePositionFrames == 9600 &&
               media.timelineFrame(MediaSlot::Music) == 8820,
           "seek beyond duration clamps before publishing the authoritative position");
}

void scheduledPlaybackTracksIndependentDeviceClocks() {
    constexpr std::uint32_t rate = 48000, frames = rate * 20;
    const auto path = tempRoot / "device-clock-drift.wav";
    WavWriter writer;
    writer.open(path.string(), rate, 1);
    writer.write(std::vector<float>(frames, 0.2F));
    writer.close();
    for (const double drift : {-0.0005, 0.0005}) {
        MediaSource source{std::make_unique<WavDecoder>()};
        source.prepareOutput(rate, 1, frames * 2 + 1);
        source.load(path.string());
        (void)source.waitUntilReady();
        const auto waitUntil = std::chrono::steady_clock::now() + std::chrono::seconds(3);
        while (source.snapshot().bufferFillFrames < frames &&
               std::chrono::steady_clock::now() < waitUntil)
            std::this_thread::yield();
        expect(source.snapshot().bufferFillFrames == frames, "drift test preloads all PCM");
        constexpr MonotonicTicks start = 1'000'000'000;
        source.play(start);
        std::vector<float> output(128);
        double maximumError = 0;
        bool complete = true;
        for (std::uint32_t delivered = 0; delivered < rate * 18; delivered += 128) {
            const auto at = start + static_cast<MonotonicTicks>(
                static_cast<double>(delivered) * 1e9 / (rate * (1.0 + drift)));
            complete = source.render(output, 128, at) == 128 && complete;
            const auto expected = static_cast<double>(at - start) * rate / 1e9;
            maximumError = std::max(maximumError, std::abs(
                static_cast<double>(source.presentationFrame(at)) - expected));
        }
        expect(complete, "clock correction never starves preloaded PCM");
        expect(maximumError < rate * 0.002,
               "scheduled backing remains within 2 ms despite positive or negative device drift");
    }
}

void wavDecoderHonorsDataBoundaryAndCanSeekAfterEof() {
    const auto path = mediaPath();
    {
        std::ofstream append(path, std::ios::binary | std::ios::app);
        const std::array<char, 16> chunk{'L', 'I', 'S', 'T', 8, 0, 0, 0, 'I', 'N', 'F', 'O'};
        append.write(chunk.data(), chunk.size());
    }
    {
        std::fstream header(path, std::ios::binary | std::ios::in | std::ios::out);
        header.seekp(4);
        const auto size = static_cast<std::uint32_t>(std::filesystem::file_size(path) - 8);
        header.write(reinterpret_cast<const char*>(&size), sizeof(size));
    }
    WavDecoder decoder;
    decoder.open(path.string());
    std::vector<float> output(20'000);
    expect(decoder.read(output, 10'000) == 9600,
           "trailing RIFF metadata is never decoded as audio samples");
    expect(decoder.read(output, 100) == 0, "the data chunk has an exact end");
    decoder.seek(0);
    expect(decoder.read(output, 100) == 100,
           "seek clears end-of-stream and supports repeated playback");
}

void mediaRejectsNonFiniteProcessingParameters() {
    struct Parameter {
        void (MediaSource::*sourceSetter)(float) noexcept;
        void (RateTransposeProcessor::*processorSetter)(float) noexcept;
    };
    constexpr std::array parameters{
        Parameter{&MediaSource::setRate, &RateTransposeProcessor::setRate},
        Parameter{&MediaSource::setTranspose, &RateTransposeProcessor::setTranspose},
    };
    for (const auto parameter : parameters) {
        MediaSource source{std::make_unique<WavDecoder>()};
        RateTransposeProcessor processor;
        processor.prepare(48000, 48000, 1, 64);
        (source.*parameter.sourceSetter)(std::numeric_limits<float>::quiet_NaN());
        (processor.*parameter.processorSetter)(std::numeric_limits<float>::quiet_NaN());
        const auto snapshot = source.snapshot();
        expect(snapshot.rate == 1 && snapshot.transpose == 0 && processor.latencyFrames() == 0,
               "invalid direct processing parameters preserve the previous finite configuration");
    }
}

void disablingLoopDiscardsQueuedLoopAudio() {
    MediaSource source{std::make_unique<WavDecoder>()};
    source.prepareOutput(48000, 2, 4096);
    source.load(mediaPath().string());
    (void)source.waitUntilReady();
    source.setLoop(true, 1000, 1010);
    const auto before = source.snapshot().generation;
    source.setLoop(false, 0, 0);
    expect(source.snapshot().generation != before,
           "disabling a loop invalidates PCM already decoded from repeated loop ranges");
    bool rejected = false;
    try {
        source.setLoop(true, 9601, 9800);
    } catch (const std::invalid_argument&) {
        rejected = true;
    }
    expect(rejected, "a loop cannot start beyond the source duration");
}

void wavDecoderRejectsMalformedDimensionsAndTruncation() {
    struct Corruption {
        std::size_t offset;
        std::uint16_t value;
        const char* message;
    };
    constexpr std::array cases{
        Corruption{32, 1, "WAV block alignment must match channels and sample size"},
        Corruption{16, 8, "a WAV format chunk must contain every required field"},
    };
    for (const auto& corruption : cases) {
        const auto path = mediaPath();
        {
            std::fstream file(path, std::ios::binary | std::ios::in | std::ios::out);
            file.seekp(static_cast<std::streamoff>(corruption.offset));
            file.write(reinterpret_cast<const char*>(&corruption.value), sizeof(corruption.value));
        }
        bool rejected = false;
        try {
            WavDecoder decoder;
            decoder.open(path.string());
        } catch (const std::exception&) {
            rejected = true;
        }
        expect(rejected, corruption.message);
    }
    const auto path = mediaPath();
    std::filesystem::resize_file(path, 128);
    bool rejected = false;
    try {
        WavDecoder decoder;
        decoder.open(path.string());
    } catch (const std::exception&) {
        rejected = true;
    }
    expect(rejected,
           "a truncated WAV file is reported instead of shortening the recording silently");
}

void transposeReportsLatency() {
    RateTransposeProcessor processor;
    processor.prepare(48000, 48000, 1, 2048);
    processor.setTranspose(3.0F);
    expect(processor.latencyFrames() > 0, "media transpose exposes algorithmic latency");
}

void previewLoopStaysInsideRange() {
    MediaSource source{std::make_unique<WavDecoder>()};
    source.prepareOutput(48000, 2, 4096);
    source.load(mediaPath().string());
    expect(source.waitUntilReady() == PlaybackState::Ready, "media preloads to Ready");
    source.setLoop(true, 1000, 1400);
    source.play();
    std::vector<float> render(256U * 2U);
    for (int index = 0; index < 5; ++index)
        (void)source.render(render, 256);
    const auto position = source.snapshot().sourcePositionFrames;
    expect(position >= 1000 && position < 1400, "preview loop stays inside exact source range");
}

void seekUpdatesAuthoritativePosition() {
    MediaSource source{std::make_unique<WavDecoder>()};
    source.prepareOutput(48000, 2, 4096);
    source.load(mediaPath().string());
    expect(source.waitUntilReady() == PlaybackState::Ready, "media preloads before seek");
    source.seek(2000);
    expect(source.snapshot().sourcePositionFrames >= 2000,
           "seek updates authoritative source position");
}

void unloadQuiescesDecoderWorker() {
    MediaSource source{std::make_unique<WavDecoder>()};
    source.prepareOutput(48000, 2, 4096);
    source.load(mediaPath().string());
    expect(source.waitUntilReady() == PlaybackState::Ready, "media preloads before unload");
    source.unload();
    expect(source.snapshot().state == PlaybackState::Empty, "unload quiesces decoder worker");
}

void audioReconfigurePreservesActiveKaraokeMedia() {
    MediaController media;
    media.prepare(48'000, 2, 4096);
    media.load(MediaSlot::Music, mediaPath().string());
    expect(media.waitUntilReady(MediaSlot::Music) == PlaybackState::Ready,
           "karaoke source preloads before device reconfiguration");
    media.activate(MediaContext::Karaoke);
    media.play(MediaContext::Karaoke);
    std::vector<float> render(512U * 2U);
    (void)media.render(MediaSlot::Music, render, 512);
    const auto before = media.snapshot(MediaSlot::Music);

    media.prepare(44'100, 2, 4096);
    const auto after = media.snapshot(MediaSlot::Music);
    expect(media.context() == MediaContext::Karaoke && after.state == PlaybackState::Playing &&
               after.sourcePositionFrames >= before.sourcePositionFrames,
           "changing the audio device format keeps the karaoke source and timeline active");
}

void karaokeTracksShareTransport() {
    MediaController controller;
    controller.prepare(48000, 2, 4096);
    const auto path = mediaPath().string();
    controller.load(MediaSlot::Music, path);
    controller.load(MediaSlot::ReferenceVocal, path);
    controller.load(MediaSlot::Melody, path);
    expect(controller.waitUntilReady(MediaSlot::Music) == PlaybackState::Ready &&
               controller.waitUntilReady(MediaSlot::ReferenceVocal) == PlaybackState::Ready &&
               controller.waitUntilReady(MediaSlot::Melody) == PlaybackState::Ready,
           "karaoke tracks are prepared together");
    controller.play(MediaContext::Karaoke);
    controller.pause(MediaContext::Karaoke);
    controller.play(MediaContext::Karaoke);
    expect(controller.snapshot(MediaSlot::ReferenceVocal).state == PlaybackState::Playing,
           "reference vocal follows karaoke transport");
    expect(controller.snapshot(MediaSlot::Melody).state == PlaybackState::Playing,
           "melody reference follows karaoke transport");
}

void radioStopsWhenPreviewActivates() {
    MediaController controller;
    controller.prepare(48000, 2, 4096);
    controller.load(MediaSlot::Radio, mediaPath().string());
    expect(controller.waitUntilReady(MediaSlot::Radio) == PlaybackState::Ready,
           "radio reaches Ready");
    controller.play(MediaContext::Radio);
    controller.activate(MediaContext::EditorPreview);
    expect(controller.snapshot(MediaSlot::Radio).state == PlaybackState::Ready,
           "leaving Radio stops its foreground source");
}

void staleDecodedPcmNeverLeaksAfterSeek() {
    auto decoder = std::make_unique<BlockingDecoder>();
    auto* decoderView = decoder.get();
    MediaSource source{std::move(decoder)};
    source.prepareOutput(48000, 1, 4096);
    source.load("blocking-test");
    decoderView->waitForFirstRead();
    source.seek(5000);
    decoderView->releaseFirstRead();
    expect(source.waitUntilReady() == PlaybackState::Ready,
           "seek during decode reaches Ready with new generation");
    source.play();
    std::vector<float> output(128);
    expect(source.render(output, 128) == 128, "new generation renders after concurrent seek");
    expect(std::all_of(output.begin(), output.end(),
                       [](float sample) { return std::abs(sample - 0.75F) < 0.0001F; }),
           "old decoded PCM never leaks after seek generation changes");
}
} // namespace Tests
