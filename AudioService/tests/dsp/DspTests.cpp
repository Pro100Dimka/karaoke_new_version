#include "TestHarness.hpp"
#include "dsp/DspChain.hpp"

#include <algorithm>
#include <cmath>
#include <vector>

namespace Tests {
void disabledDspIsExactBypass() {
    DspChain chain;
    chain.prepare(48000, 256, 2);
    std::vector<float> samples(512, 0.25F);
    const auto original = samples;
    chain.process(samples, 256);
    expect(samples == original, "disabled DSP is exact bypass");
}

void dspParametersAreValidated() {
    DspChain chain;
    chain.prepare(48000, 256, 2);
    chain.setEnabled(true);
    expect(chain.setParameter("pitch.semitones", 2.0F), "pitch parameter accepted");
    expect(chain.setParameter("reverb.mix", 0.2F), "reverb parameter accepted");
    expect(!chain.setParameter("unknown", 1.0F), "unknown DSP parameter rejected");
}

void activePitchReportsLatency() {
    DspChain chain;
    chain.prepare(48000, 256, 2);
    chain.setEnabled(true);
    expect(chain.setParameter("pitch.semitones", 2.0F), "pitch parameter accepted");
    expect(chain.latencyFrames() > 0, "active pitch reports DSP latency");
}

void autoTuneCorrectsAStableVoiceWithoutClipping() {
    DspChain chain;
    constexpr std::uint32_t sampleRate = 48000;
    constexpr std::uint32_t frames = 256;
    chain.prepare(sampleRate, frames, 1);
    chain.setEnabled(true);
    expect(chain.setParameter("autotune.amount", 1.0F), "auto-tune amount is accepted");
    expect(chain.setParameter("autotune.scaleMask", static_cast<float>(1U << 9U)),
           "auto-tune accepts the song's allowed pitch classes");

    std::vector<float> output;
    output.reserve(sampleRate * 2U);
    double phase = 0.0;
    constexpr double inputFrequency = 480.0;
    constexpr double twoPi = 6.28318530717958647692;
    for (std::uint32_t block = 0; block < sampleRate * 2U / frames; ++block) {
        std::vector<float> samples(frames);
        for (auto& sample : samples) {
            sample = 0.3F * static_cast<float>(std::sin(phase));
            phase += twoPi * inputFrequency / sampleRate;
        }
        chain.process(samples, frames);
        output.insert(output.end(), samples.begin(), samples.end());
    }

    const auto begin = output.size() - sampleRate;
    std::uint32_t crossings = 0;
    float peak = 0.0F;
    for (std::size_t index = begin + 1; index < output.size(); ++index) {
        peak = std::max(peak, std::abs(output[index]));
        if (output[index - 1] <= 0.0F && output[index] > 0.0F)
            ++crossings;
    }
    expect(crossings >= 435 && crossings <= 445,
           "hard auto-tune audibly pulls a 480 Hz voice to the song's allowed A4");
    expect(peak <= 0.35F, "auto-tune keeps voice peaks bounded");
}

void dspOutputRemainsFinite() {
    DspChain chain;
    chain.prepare(48000, 256, 2);
    chain.setEnabled(true);
    expect(chain.setParameter("reverb.mix", 0.2F), "reverb parameter accepted");
    std::vector<float> samples(512, 0.25F);
    chain.process(samples, 256);
    expect(std::all_of(
               samples.begin(), samples.end(),
               [](float value) { return value == value && value >= -10.0F && value <= 10.0F; }),
           "DSP output remains finite and bounded");
}

void roomVoiceEffectAmountsDriveWetProcessing() {
    DspChain echo;
    echo.prepare(48000, 256, 1);
    echo.setEnabled(true);
    expect(echo.setParameter("echo.amount", 0.8F),
           "the room echo amount configures a complete audible effect");
    std::vector<float> block(256, 0.0F);
    block.front() = 1.0F;
    echo.process(block, 256);
    float tailPeak = 0.0F;
    for (int index = 0; index < 32; ++index) {
        std::fill(block.begin(), block.end(), 0.0F);
        echo.process(block, 256);
        tailPeak = std::max(tailPeak, *std::max_element(block.begin(), block.end()));
    }
    expect(tailPeak > 0.1F, "room echo produces an audible delayed tail");

    DspChain noise;
    noise.prepare(48000, 256, 1);
    noise.setEnabled(true);
    expect(noise.setParameter("noise.amount", 1.0F),
           "the room noise knob configures threshold and reduction together");
    std::fill(block.begin(), block.end(), 0.005F);
    for (int index = 0; index < 64; ++index)
        noise.process(block, 256);
    expect(std::abs(block.back()) < 0.001F, "maximum room noise suppression attenuates quiet noise");
}

void noiseSuppressionPreservesVoicedWaveform() {
    NoiseProcessor noise;
    noise.prepare(48000, 4096, 1);
    noise.setThreshold(0.03F);
    noise.setReduction(0.25F);
    std::vector<float> samples(4096);
    constexpr float Pi = 3.14159265358979323846F;
    for (std::size_t index = 0; index < samples.size(); ++index)
        samples[index] = 0.08F * std::sin(2.0F * Pi * 220.0F * static_cast<float>(index) / 48000.0F);
    const auto original = samples;

    noise.process(samples, static_cast<std::uint32_t>(samples.size()));

    float error = 0.0F;
    float signal = 0.0F;
    for (std::size_t index = 512; index < samples.size(); ++index) {
        const auto difference = samples[index] - original[index];
        error += difference * difference;
        signal += original[index] * original[index];
    }
    expect(error / signal < 0.0001F,
           "noise suppression does not reshape voiced waveform zero crossings");
}
} // namespace Tests
