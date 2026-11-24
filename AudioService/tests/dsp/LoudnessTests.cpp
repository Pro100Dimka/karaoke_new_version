#include "TestHarness.hpp"
#include "dsp/KWeighting.hpp"
#include "media/MediaSource.hpp"
#include "media/WavDecoder.hpp"
#include "realtime/VoiceLoudness.hpp"
#include "recording/WavWriter.hpp"

#include <algorithm>
#include <atomic>
#include <chrono>
#include <cmath>
#include <condition_variable>
#include <mutex>
#include <optional>
#include <semaphore>
#include <thread>
#include <vector>

#if defined(_M_X64) || defined(__x86_64__)
#include <xmmintrin.h>
#endif

namespace {
constexpr std::uint32_t Rate = 48'000;
constexpr double Pi = 3.14159265358979323846;

std::vector<float> tone(double hz, float amplitude, std::uint32_t frames) {
    std::vector<float> samples(frames);
    for (std::uint32_t frame = 0; frame < frames; ++frame)
        samples[frame] = amplitude * static_cast<float>(std::sin(2.0 * Pi * hz * frame / Rate));
    return samples;
}

double weightedGain(double hz) {
    KWeighting weighting;
    weighting.prepare(Rate);
    double in = 0.0, out = 0.0;
    const auto samples = tone(hz, 0.5F, Rate);
    for (std::size_t index = Rate / 2U; index < samples.size(); ++index) { // settled half
        const auto weighted = weighting.process(samples[index]);
        in += static_cast<double>(samples[index]) * samples[index];
        out += weighted * weighted;
    }
    return std::sqrt(out / in);
}

class CancelledScanDecoder final : public IAudioDecoder {
  public:
    DecodedAudioFormat open(const std::string&) override {
        std::lock_guard lock(mutex_);
        cancelled_ = false;
        return {Rate, 1, Rate};
    }
    std::uint32_t read(std::span<float>, std::uint32_t) override {
        std::unique_lock lock(mutex_);
        entered_.release();
        (void)cancelledWake_.wait_for(lock, std::chrono::seconds(2), [this] { return cancelled_; });
        return 0;
    }
    void seek(std::uint64_t) override { ++rewinds; }
    void cancel() noexcept override {
        std::lock_guard lock(mutex_);
        cancelled_ = true;
        cancelledWake_.notify_one();
    }
    void close() noexcept override {}
    bool waitForScan() { return entered_.try_acquire_for(std::chrono::seconds(2)); }

    unsigned rewinds{0};

  private:
    std::binary_semaphore entered_{0};
    std::mutex mutex_;
    std::condition_variable cancelledWake_;
    bool cancelled_{false};
};

#if defined(_M_X64) || defined(__x86_64__)
struct LoudnessScanModes {
    bool denormalOperand{false};
    bool playbackUsesCallerMode{false};
};

class SilentTailDecoder final : public IAudioDecoder {
  public:
    explicit SilentTailDecoder(LoudnessScanModes& modes) : modes_(modes) {}
    DecodedAudioFormat open(const std::string&) override {
        previousMode_ = _mm_getcsr();
        _mm_setcsr(*previousMode_ & ~(FlushModes | 0x3fU));
        return {Rate, 1, TotalFrames};
    }
    std::uint32_t read(std::span<float> output, std::uint32_t maxFrames) override {
        if (scanning_)
            modes_.denormalOperand |= (_mm_getcsr() & (1U << 1U)) != 0;
        else
            modes_.playbackUsesCallerMode = (_mm_getcsr() & FlushModes) == 0;
        const auto frames = static_cast<std::uint32_t>(
            std::min<std::uint64_t>({maxFrames, output.size(), TotalFrames - position_}));
        std::fill_n(output.data(), frames, 0.0F);
        if (position_ == 0 && frames != 0)
            output[0] = 0.5F;
        position_ += frames;
        return frames;
    }
    void seek(std::uint64_t frame) override {
        position_ = frame;
        scanning_ = false;
    }
    void cancel() noexcept override {}
    void close() noexcept override {
        if (previousMode_) {
            _mm_setcsr(*previousMode_);
            previousMode_.reset();
        }
    }

  private:
    static constexpr unsigned FlushModes = 0x8040U;
    static constexpr std::uint64_t TotalFrames = Rate * 4U;
    LoudnessScanModes& modes_;
    std::optional<unsigned> previousMode_;
    std::uint64_t position_{0};
    bool scanning_{true};
};
#endif
} // namespace

namespace Tests {
void cancelledSongLoudnessScanDoesNotRewindDecoder() {
    auto decoder = std::make_unique<CancelledScanDecoder>();
    auto& scanning = *decoder;
    MediaSource source{std::move(decoder), true};
    source.prepareOutput(Rate, 1, Rate / 2U);
    source.load("cancelled-scan");
    expect(scanning.waitForScan(), "the decoder starts scanning before cancellation");
    source.unload();
    expect(scanning.rewinds == 0,
           "unloading does not restart cancelled decoder I/O just to rewind a discarded scan");
    expect(source.snapshot().state == PlaybackState::Empty,
           "cancelled loading returns the source to Empty");
}

void songLoudnessScanDoesNotProcessSubnormalTails() {
#if defined(_M_X64) || defined(__x86_64__)
    LoudnessScanModes modes;
    {
        MediaSource source{std::make_unique<SilentTailDecoder>(modes), true};
        source.prepareOutput(Rate, 1, Rate / 2U);
        source.load("impulse-and-silence");
        expect(source.waitUntilReady() == PlaybackState::Ready,
               "a song with a silent tail completes loudness analysis");
    }
    expect(!modes.denormalOperand,
           "loudness scanning does not spend CPU on inaudible subnormal filter tails");
    expect(modes.playbackUsesCallerMode,
           "loudness scanning restores the decoder worker's floating-point mode");
#endif
}

void loudnessWeightingFollowsHearing() {
    expect(weightedGain(1'000.0) > 0.95 && weightedGain(1'000.0) < 1.15,
           "K weighting leaves a 1 kHz tone about as loud as it is");
    expect(weightedGain(20.0) < 0.3, "K weighting discounts rumble the ear barely hears");
    expect(weightedGain(4'000.0) > 1.3, "K weighting counts the presence band the ear favours");
}

void aQuietMicrophoneIsMeasuredAboveItsOwnNoise() {
    // An interface microphone without automatic gain: noise at -80 dB, singing at -48 dB. An
    // absolute gate (-45 dB) never heard this voice.
    VoiceLoudness voice;
    voice.prepare(Rate);
    const auto noise = tone(1'000.0, 0.0001F, 480), singing = tone(1'000.0, 0.0056F, 480);
    for (int block = 0; block < 1'000; ++block)
        voice.note(block % 4 == 0 ? noise : singing, 1, 480);
    expect(voice.rms() > 0.0F, "a quiet microphone's voice is measured against its own noise");
}

void voiceLoudnessIgnoresRoomNoiseAndNeedsTwoSeconds() {
    VoiceLoudness voice;
    voice.prepare(Rate);
    const auto noise = tone(1'000.0, 0.002F, 480);
    for (int block = 0; block < 400; ++block)
        voice.note(noise, 1, 480);
    expect(voice.rms() == 0.0F, "room noise below the gate is not a voice");
    const auto singing = tone(1'000.0, 0.2F, 480);
    for (int block = 0; block < 150; ++block)
        voice.note(singing, 1, 480);
    expect(voice.rms() == 0.0F, "a level waits for two seconds of voice");
    for (int block = 0; block < 100; ++block)
        voice.note(singing, 1, 480);
    expect(std::abs(voice.rms() -
                    static_cast<float>(0.2 / std::sqrt(2.0) * weightedGain(1'000.0))) < 0.01F,
           "the voice level is its weighted RMS while it sounds");
}

void songsPlayAsLoudAsStreamingNotLouder() {
    // A backing track mastered at about -8 LUFS comes down 6 dB to the -14 LUFS other apps play at.
    const auto loudSong = static_cast<float>(std::pow(10.0, (-8.0 + 0.691) / 20.0));
    expect(std::abs(20.0F * std::log10(streamingLoudnessGain(loudSong)) + 6.0F) < 0.01F,
           "a loud master is brought to the streaming loudness");
    const auto quietSong = static_cast<float>(std::pow(10.0, (-20.0 + 0.691) / 20.0));
    expect(streamingLoudnessGain(quietSong) == 1.0F && streamingLoudnessGain(0.0F) == 1.0F,
           "a quiet or unmeasured song is never boosted");
}

void songLoudnessIsMeasuredOnLoadIgnoringSilence() {
    const auto path = tempRoot / "loudness-song.wav";
    {
        WavWriter writer;
        writer.open(path.string(), Rate, 1);
        writer.write(std::vector<float>(Rate, 0.0F)); // a silent intro must not lower the result
        writer.write(tone(1'000.0, 0.4F, Rate * 2U));
        writer.close();
    }
    MediaSource source{std::make_unique<WavDecoder>(), true};
    source.prepareOutput(Rate, 1, Rate / 2U);
    source.load(path.string());
    (void)source.waitUntilReady();
    const auto expected = static_cast<float>(0.4 / std::sqrt(2.0) * weightedGain(1'000.0));
    expect(std::abs(source.snapshot().loudnessRms - expected) < 0.02F,
           "each song's loudness is measured on load, as heard, without its silences");
}
} // namespace Tests
