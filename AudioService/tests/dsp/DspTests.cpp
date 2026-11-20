#include "TestHarness.hpp"
#include "dsp/BasicProcessors.hpp"
#include "dsp/DspChain.hpp"
#include "realtime/RealtimeInstrumentation.hpp"

#include <algorithm>
#include <cmath>
#include <numbers>
#include <vector>

#if defined(_M_X64) || defined(__x86_64__)
#include <xmmintrin.h>
#endif

namespace Tests {
void dspSilenceSettlesWithoutSubnormalTails() {
#if defined(_M_X64) || defined(__x86_64__)
    DspChain chain;
    chain.prepare(48000, 128, 2);
    chain.setEnabled(true);
    std::array<float, 256> block{};
    block[0] = block[1] = 0.5F;
    constexpr auto FlushModes = 0x8040U;
    const auto callerMode = _mm_getcsr();
    const auto gradualMode = callerMode & ~FlushModes;
    _mm_setcsr(gradualMode);
    chain.process(block, 128);
    for (int index = 0; index < 1000; ++index) {
        block.fill(0.0F);
        chain.process(block, 128);
    }
    const auto restoredMode = _mm_getcsr();
    _mm_setcsr(callerMode);
    expect(std::ranges::all_of(block, [](float value) { return value == 0.0F; }),
           "silent DSP must not keep processing a permanent subnormal filter tail");
    expect(restoredMode == gradualMode,
           "DSP must restore the caller's floating-point environment");
#endif
}

void realtimeScopeRestoresFloatingPointMode() {
#if defined(_M_X64) || defined(__x86_64__)
    constexpr auto FlushModes = 0x8040U;
    const auto originalMode = _mm_getcsr();
    bool protectedScopes = true, restoredModes = true;
    for (const auto mode : {0U, 0x8000U, 0x0040U, FlushModes}) {
        const auto callerMode = (originalMode & ~FlushModes) | mode;
        _mm_setcsr(callerMode);
        {
            RealtimeScope outer;
            protectedScopes &= (_mm_getcsr() & FlushModes) == FlushModes;
            {
                RealtimeScope inner;
                protectedScopes &= (_mm_getcsr() & FlushModes) == FlushModes;
            }
            protectedScopes &= (_mm_getcsr() & FlushModes) == FlushModes;
        }
        restoredModes &= _mm_getcsr() == callerMode;
    }
    _mm_setcsr(originalMode);
    expect(protectedScopes, "nested audio callbacks must suppress subnormal arithmetic");
    expect(restoredModes, "audio callbacks must preserve every caller floating-point mode");
#endif
}

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
    expect(!chain.setParameter("autotune.scaleMask", static_cast<float>(1U << 9U)),
           "auto-tune is independent from song notes and scales");
    expect(chain.latencyFrames() <= sampleRate / 160U,
           "full hard-tune uses the extra-short robotic pitch window");

    std::vector<float> output;
    output.reserve(sampleRate * 2U);
    double phase = 0.0;
    constexpr double inputFrequency = 475.0;
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
    expect(crossings >= 420 && crossings <= 460,
           "maximum auto-tune exaggerates chromatic correction as an obvious voice effect");
    expect(peak <= 0.35F, "auto-tune keeps voice peaks bounded");
}

void autoTunePreservesReferenceWaveformAcrossSampleRates() {
    struct Fixture {
        std::uint32_t rate;
        float amount;
        std::array<float, 4> expected;
    };
    // Samples from the scalar energy sums, including both sides of the hard-tune boundary.
    constexpr Fixture fixtures[]{
        {48000, 0.4F, {-0.324342429638F, -0.326173186302F, -0.32071185112F, -0.307548135519F}},
        {48000, 0.999F, {0.0164111405611F, 0.000229462981224F, -0.0131914913654F, -0.0234304144979F}},
        {48000, 1.0F, {0.0173852965236F, -0.000503875315189F, -0.0157357156277F, -0.0279369279742F}},
        {192000, 0.4F, {-0.0571190901101F, -0.048242110759F, -0.0393341556191F, -0.0304085016251F}},
        {192000, 0.999F, {0.00522119551897F, 0.000388592481613F, -0.00457359105349F, -0.00965368002653F}},
        {192000, 1.0F, {0.0559961274266F, 0.0521260872483F, 0.0480947196484F, 0.0439057424664F}},
    };
    for (const auto& fixture : fixtures) {
        const auto frames = fixture.rate / 10U;
        std::vector<float> samples(frames);
        for (std::uint32_t frame = 0; frame < frames; ++frame) {
            const auto phase = 2 * std::numbers::pi * 475 * frame / fixture.rate;
            samples[frame] = static_cast<float>(0.3 * std::sin(phase) + 0.08 * std::sin(phase * 2));
        }
        PitchShiftProcessor processor;
        processor.prepare(fixture.rate, 128, 1);
        processor.setShortDelay(true);
        processor.setAutoTuneAmount(fixture.amount);
        for (std::uint32_t from = 0; from < frames; from += 128U) {
            const auto count = std::min(128U, frames - from);
            processor.process(std::span<float>{samples}.subspan(from, count), count);
        }
        for (std::size_t index = 0; index < fixture.expected.size(); ++index)
            expect(std::abs(samples[frames - 8U + index * 2U] - fixture.expected[index]) < 0.00001F,
                   "auto-tune retains the scalar waveform at normal and high device rates");
    }
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
    expect(echo.setParameter("delay.mix", 0.0F), "delay can stay off beside active echo");
    expect(echo.setParameter("delay.ms", 320.0F), "delay timing is independent from echo");
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

    DspChain delay;
    delay.prepare(48000, 256, 1);
    delay.setEnabled(true);
    expect(delay.setParameter("delay.mix", 0.5F), "delay amount is accepted");
    expect(delay.setParameter("delay.ms", 320.0F), "delay time is accepted");
    expect(delay.setParameter("echo.amount", 0.0F), "echo can stay off beside active delay");
    std::fill(block.begin(), block.end(), 0.0F);
    block.front() = 1.0F;
    delay.process(block, 256);
    tailPeak = 0.0F;
    for (int index = 0; index < 64; ++index) {
        std::fill(block.begin(), block.end(), 0.0F);
        delay.process(block, 256);
        tailPeak = std::max(tailPeak, *std::max_element(block.begin(), block.end()));
    }
    expect(tailPeak > 0.1F, "delay produces its tail with echo disabled");

    DspChain noise;
    noise.prepare(48000, 256, 1);
    noise.setEnabled(true);
    expect(noise.setParameter("noise.amount", 1.0F),
           "the room noise knob configures threshold and reduction together");
    std::fill(block.begin(), block.end(), 0.005F);
    for (int index = 0; index < 64; ++index)
        noise.process(block, 256);
    expect(std::abs(block.back()) < 0.001F,
           "maximum room noise suppression attenuates quiet noise");
}

void noiseSuppressionPreservesVoicedWaveform() {
    NoiseProcessor noise;
    noise.prepare(48000, 4096, 1);
    noise.setThreshold(0.03F);
    noise.setReduction(0.25F);
    std::vector<float> samples(4096);
    constexpr float Pi = 3.14159265358979323846F;
    for (std::size_t index = 0; index < samples.size(); ++index)
        samples[index] =
            0.08F * std::sin(2.0F * Pi * 220.0F * static_cast<float>(index) / 48000.0F);
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
