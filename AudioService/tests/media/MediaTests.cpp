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
