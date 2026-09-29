#include "TestHarness.hpp"
#include "dsp/KWeighting.hpp"
#include "media/MediaSource.hpp"
#include "media/WavDecoder.hpp"
#include "recording/WavWriter.hpp"
#include "realtime/VoiceLoudness.hpp"

#include <chrono>
#include <cmath>
#include <thread>
#include <vector>

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
} // namespace

namespace Tests {
void loudnessWeightingFollowsHearing() {
    expect(weightedGain(1'000.0) > 0.95 && weightedGain(1'000.0) < 1.15,
           "K weighting leaves a 1 kHz tone about as loud as it is");
    expect(weightedGain(20.0) < 0.3, "K weighting discounts rumble the ear barely hears");
    expect(weightedGain(4'000.0) > 1.3, "K weighting counts the presence band the ear favours");
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
    expect(std::abs(voice.rms() - static_cast<float>(0.2 / std::sqrt(2.0) * weightedGain(1'000.0))) < 0.01F,
           "the voice level is its weighted RMS while it sounds");
}

void musicStartsAsLoudAsTheQuietestVoice() {
    expect(std::abs(musicAutoTrim(0.05F, 0.2F, 0.5F) - 0.5F) < 1e-6F,
           "the backing track is brought exactly to the quietest voice");
    expect(musicAutoTrim(0.5F, 0.1F, 1.0F) == 1.0F, "a quiet song is never boosted");
    expect(musicAutoTrim(0.001F, 0.3F, 1.0F) == 0.1F, "a nearly silent microphone cannot mute the song");
    expect(musicAutoTrim(0.0F, 0.3F, 1.0F) == 1.0F && musicAutoTrim(0.1F, 0.0F, 1.0F) == 1.0F,
           "nothing changes while a level is still unknown");
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
