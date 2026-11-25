#include "TestHarness.hpp"
#include "dsp/BasicProcessors.hpp"
#include "dsp/DspChain.hpp"
#include "realtime/RealtimeInstrumentation.hpp"

#include <algorithm>
#include <cmath>
#include <chrono>
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
    // Reference samples include both sides of the hard-tune boundary and rate-normalized analysis.
    constexpr Fixture fixtures[]{
        {44100, 0.4F, {-0.327199608088F, -0.32042530179F, -0.30443662405F, -0.279156923294F}},
        {44100,
         0.999F,
         {-0.00341637432575F, -0.00709054805338F, -0.00873874686658F, -0.00917220301926F}},
        {44100,
         1.0F,
         {-0.00329625234008F, -0.00727470219135F, -0.00908411107957F, -0.00941010005772F}},
        {48000, 0.4F, {-0.324342429638F, -0.326173186302F, -0.32071185112F, -0.307548135519F}},
        {48000,
         0.999F,
         {0.0164111405611F, 0.000229462981224F, -0.0131914913654F, -0.0234304144979F}},
        {48000,
         1.0F,
         {0.0173852965236F, -0.000503875315189F, -0.0157357156277F, -0.0279369279742F}},
        {96000, 0.4F, {0.037098005414F, 0.0294650364667F, 0.022056337446F, 0.0147978868335F}},
        {96000, 0.999F, {0.0528709106147F, 0.0451261922717F, 0.0372355952859F, 0.0291596576571F}},
        {96000, 1.0F, {0.060930788517F, 0.0532048866153F, 0.04542446509F, 0.0375519953668F}},
        {192000, 0.4F, {0.260975301266F, 0.258188188076F, 0.255184233189F, 0.251975774765F}},
        {192000,
         0.999F,
         {0.130148455501F, 0.128614887595F, 0.126878559589F, 0.124938644469F}},
        {192000, 1.0F, {0.151915773749F, 0.151562809944F, 0.150995820761F, 0.150206178427F}},
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

void noiseSuppressionDoesNotChatterOnHeldVoice() {
    for (const auto rate : {44'100U, 48'000U}) {
        for (const auto frequency : {80.0, 110.0, 220.0, 440.0}) {
            NoiseProcessor noise;
            noise.prepare(rate, 1, 1);
            noise.setThreshold(0.03F);
            noise.setReduction(0.25F);
            double error = 0.0, power = 0.0;
            for (std::uint32_t frame = 0; frame < rate; ++frame) {
                const auto amplitude = frame < rate / 10U ? 0.08 : 0.031;
                const auto voice = static_cast<float>(amplitude * std::sin(
                    2.0 * std::numbers::pi * frequency * frame / rate));
                std::array sample{voice};
                noise.process(sample, 1);
                if (frame >= rate / 2U) {
                    const auto difference = sample.front() - voice;
                    error += difference * difference;
                    power += voice * voice;
                }
            }
            std::printf("HELD_VOICE_NOISE rate=%u frequency=%.0f relativeError=%g\n",
                        rate, frequency, error / power);
            expect(error / power < 0.0001,
                   "an opened noise suppressor must not repeatedly gate a held vowel near its threshold");
            std::array<float, 1> quiet{};
            for (std::uint32_t frame = 0; frame < rate; ++frame) {
                quiet.front() = 0.005F;
                noise.process(quiet, 1);
            }
            expect(quiet.front() < 0.0013F,
                   "the lower closing threshold must still attenuate noise after the vowel ends");
        }
    }
}
void noiseSuppressionPreservesQuietHeldVoiceAboveBackground() {
    for (const auto rate : {44'100U, 48'000U, 96'000U, 192'000U}) {
        for (const auto frequency : {80.0, 220.0, 440.0}) {
            NoiseProcessor noise;
            noise.prepare(rate, 1, 1);
            noise.setThreshold(0.03F);
            noise.setReduction(0.25F);
            std::uint32_t random = 12345;
            double error = 0.0, power = 0.0;
            for (std::uint32_t frame = 0; frame < rate; ++frame) {
                random = random * 1664525U + 1013904223U;
                const auto phase = 2.0 * std::numbers::pi * frequency * frame / rate;
                const auto source = static_cast<float>(0.004 * std::sin(phase) +
                    0.001 * std::sin(phase * 2) + (static_cast<double>(random) / 4294967295.0 * 2 - 1) * 0.0002);
                std::array sample{source};
                noise.process(sample, 1);
                if (frame >= rate / 2U) {
                    const auto difference = sample.front() - source;
                    error += difference * difference;
                    power += source * source;
                }
            }
            std::printf("QUIET_VOICE_NOISE rate=%u frequency=%.0f relativeError=%g\n",
                        rate, frequency, error / power);
            expect(error / power < 0.0001,
                   "a quiet held vowel clearly above background must not be gated by an absolute microphone level");
            double noiseInput = 0.0, noiseOutput = 0.0;
            float transitionError = 0.0F;
            for (std::uint32_t frame = 0; frame < rate; ++frame) {
                random = random * 1664525U + 1013904223U;
                const auto source = static_cast<float>(
                    (static_cast<double>(random) / 4294967295.0 * 2 - 1) * 0.0002);
                std::array sample{source};
                noise.process(sample, 1);
                if (frame < rate / 20U)
                    transitionError = std::max(transitionError, std::abs(sample.front() - source));
                if (frame >= rate * 3U / 4U) {
                    noiseInput += source * source;
                    noiseOutput += sample.front() * sample.front();
                }
            }
            expect(transitionError < 0.000001F,
                   "a short unvoiced transition after a vowel must not close the voice abruptly");
            expect(noiseOutput / noiseInput < 0.07,
                   "voice protection must release and still suppress background after the phrase");
        }
    }
}

void noiseSuppressionPreservesTheStartOfAQuietPhrase() {
    for (const auto rate : {44'100U, 48'000U, 96'000U, 192'000U}) {
        for (const auto& [frequency, rampSeconds] : {
                 std::pair{80.0, 0.0}, {150.0, 0.0}, {300.0, 0.0},
                 {80.0, 0.08}, {150.0, 0.08}, {300.0, 0.08}}) {
            NoiseProcessor noise;
            noise.prepare(rate, 1, 1);
            noise.setThreshold(0.03F);
            noise.setReduction(0.25F);
            std::uint32_t random = 12345;
            double input = 0.0, output = 0.0;
            const auto onset = rate / 2U;
            for (std::uint32_t frame = 0; frame < onset + rate / 50U; ++frame) {
                random = random * 1664525U + 1013904223U;
                const auto background =
                    (static_cast<double>(random) / 4294967295.0 * 2 - 1) * 0.0002;
                const auto ramp = rampSeconds > 0.0 && frame >= onset
                    ? std::min(1.0, (frame - onset) / (rate * rampSeconds)) : 1.0;
                const auto voice = frame < onset ? 0.0 : 0.014 * ramp * std::sin(
                    2.0 * std::numbers::pi * frequency * (frame - onset) / rate);
                const auto source = static_cast<float>(voice + background);
                std::array sample{source};
                noise.process(sample, 1);
                if (frame >= onset) {
                    input += source * source;
                    output += sample.front() * sample.front();
                }
            }
            const auto gain = std::sqrt(output / input);
            std::printf("VOICE_ONSET_NOISE rate=%u frequency=%.0f ramp=%.2f gain=%g\n",
                        rate, frequency, rampSeconds, gain);
            expect(gain > 0.8,
                   "the start of a clear quiet phrase must not wait for a full pitch-analysis window");
        }
    }
}

void autoTunePreservesAnInTuneLowVoiceAcrossRates() {
    for (const auto rate : {44'100U, 48'000U, 96'000U, 192'000U}) {
        constexpr std::uint32_t Block = 128;
        PitchShiftProcessor processor;
        processor.setShortDelay(true);
        processor.prepare(rate, Block, 1);
        processor.setAutoTuneAmount(1.0F);
        const auto voice = [rate](double frame) {
            return static_cast<float>(0.3 * std::sin(2.0 * std::numbers::pi * 110.0 * frame / rate));
        };
        std::array<float, Block> samples{};
        double error = 0.0, power = 0.0;
        for (std::uint32_t from = 0; from < rate; from += Block) {
            const auto count = std::min(Block, rate - from);
            for (std::uint32_t frame = 0; frame < count; ++frame)
                samples[frame] = voice(from + frame);
            processor.process(std::span{samples}.first(count), count);
            if (from < rate / 2U) continue;
            for (std::uint32_t frame = 0; frame < count; ++frame) {
                const auto expected = voice(static_cast<double>(from + frame) - processor.latencyFrames());
                const auto difference = samples[frame] - expected;
                error += difference * difference;
                power += expected * expected;
            }
        }
        std::printf("LOW_VOICE_AUTOTUNE rate=%u relativeError=%g\n", rate, error / power);
        expect(error / power < 0.001,
               "an already in-tune 110 Hz voice must not be retuned to another note at a higher device rate");
    }
}

void voiceEffectsDoNotReplayOldVoiceAfterBypass() {
    constexpr std::uint32_t Rate = 48'000, Frames = 128;
    const std::pair<std::string_view, float> effects[]{
        {"reverb.mix", 0.8F}, {"echo.amount", 0.8F}, {"delay.mix", 0.8F},
        {"pitch.semitones", 12.0F}, {"autotune.amount", 0.4F},
    };
    for (const auto& [parameter, value] : effects) {
        for (const bool wholeChain : {true, false}) {
            DspChain chain;
            chain.prepare(Rate, Frames, 1, true);
            chain.setEnabled(true);
            require(chain.setParameter("delay.ms", 20.0F), "the short delay is accepted");
            require(chain.setParameter(parameter, value), "the buffered effect is accepted");
            std::array<float, Frames> voice{}, output{};
            for (std::uint32_t frame = 0; frame < Frames; ++frame)
                voice[frame] = static_cast<float>(0.3 * std::sin(2.0 * std::numbers::pi * 220 * frame / Rate));
            for (int block = 0; block < 32; ++block) {
                output = voice;
                chain.process(output, Frames);
            }
            if (wholeChain) chain.setEnabled(false);
            else require(chain.setParameter(parameter, 0.0F), "the effect bypass is accepted");
            for (std::uint32_t frame = 0; frame < Rate; frame += Frames) {
                output.fill(0.0F);
                chain.process(output, Frames);
            }
            if (wholeChain) chain.setEnabled(true);
            else require(chain.setParameter(parameter, value), "the effect returns from bypass");
            float peak = 0.0F;
            for (std::uint32_t frame = 0; frame < Rate; frame += Frames) {
                output.fill(0.0F);
                chain.process(output, Frames);
                for (const auto sample : output) peak = std::max(peak, std::abs(sample));
            }
            std::printf("EFFECT_BYPASS parameter=%.*s wholeChain=%u peak=%g\n",
                        static_cast<int>(parameter.size()), parameter.data(), static_cast<unsigned>(wholeChain), peak);
            expect(peak < 0.00001F,
                   "re-enabling an effect after silent bypass must not replay the preceding voice");
        }
    }
}

void voiceEffectsStayRealtimeSafeWhileControlsChange() {
    using Parameter = std::pair<std::string_view, float>;
    struct Scenario {
        const char* name;
        std::initializer_list<Parameter> parameters;
    };
    const Scenario scenarios[]{
        {"base", {}},
        {"highpass", {{"highpass.cutoffHz", 300.0F}}},
        {"equalizer", {{"eq.lowGain", 2.0F}, {"eq.midGain", 0.5F}, {"eq.highGain", 2.0F}}},
        {"compressor", {{"compressor.threshold", 0.1F}, {"compressor.ratio", 10.0F}}},
        {"gate", {{"gate.threshold", 0.03F}}},
        {"noise", {{"noise.threshold", 0.03F}, {"noise.reduction", 0.25F}}},
        {"reverb", {{"reverb.mix", 1.0F}, {"reverb.decay", 0.85F}}},
        {"echo", {{"echo.amount", 0.95F}}},
        {"delay", {{"delay.mix", 1.0F}, {"delay.feedback", 0.8F}, {"delay.ms", 320.0F}}},
        {"octave", {{"pitch.semitones", 12.0F}}},
        {"autotune", {{"autotune.amount", 0.4F}}},
        {"hardtune", {{"autotune.amount", 1.0F}}},
        {"combined", {{"noise.threshold", 0.03F}, {"noise.reduction", 0.25F},
                      {"echo.amount", 0.6F}, {"reverb.mix", 0.4F},
                      {"delay.mix", 0.3F}, {"autotune.amount", 0.4F}}},
    };
    struct Format { std::uint32_t rate, frames; };
    for (const auto format : {Format{44'100, 128}, Format{44'100, 133}, Format{48'000, 120},
                              Format{96'000, 256}, Format{192'000, 512}}) {
        std::vector<float> voice(format.frames * 2U), output(voice.size());
        for (std::uint32_t frame = 0; frame < format.frames; ++frame)
            voice[frame * 2U] = voice[frame * 2U + 1U] = static_cast<float>(
                0.6 * std::sin(2.0 * std::numbers::pi * 220.0 * frame / format.rate));
        for (const auto& scenario : scenarios) {
            DspChain chain;
            chain.prepare(format.rate, format.frames, 2, true);
            chain.setEnabled(true);
            for (const auto& [parameter, value] : scenario.parameters)
                require(chain.setParameter(parameter, value), "the effect parameter is accepted");
            for (int block = 0; block < 32; ++block) {
                output = voice;
                chain.process(output, format.frames);
            }
            RealtimeInstrumentation::reset();
            std::chrono::nanoseconds elapsed{}, maximum{};
            bool finite = true;
            float peak = 0.0F;
            constexpr int Blocks = 256;
            for (int block = 0; block < Blocks; ++block) {
                std::copy(voice.begin(), voice.end(), output.begin());
                const auto start = std::chrono::steady_clock::now();
                {
                    RealtimeScope realtime;
                    if (block % 16 == 0)
                        for (const auto& [parameter, value] : scenario.parameters)
                            (void)chain.setParameter(parameter, value * (block % 32 == 0 ? 0.9F : 1.0F));
                    chain.process(output, format.frames);
                }
                const auto duration = std::chrono::steady_clock::now() - start;
                elapsed += duration;
                maximum = std::max(maximum, std::chrono::duration_cast<std::chrono::nanoseconds>(duration));
                finite &= std::ranges::all_of(output, [](float sample) { return std::isfinite(sample); });
                for (const auto sample : output) peak = std::max(peak, std::abs(sample));
            }
            const auto activity = RealtimeInstrumentation::snapshot();
            std::printf("DSP_EFFECT name=%s rate=%u frames=%u meanUs=%.3f maxUs=%.3f budgetUs=%.3f latencyFrames=%u peak=%.6f\n",
                        scenario.name, format.rate, format.frames, static_cast<double>(elapsed.count()) / (Blocks * 1000.0),
                        static_cast<double>(maximum.count()) / 1000.0, format.frames * 1'000'000.0 / format.rate,
                        chain.latencyFrames(), peak);
            expect(finite, "effect changes must keep every output sample finite");
            expect(activity.allocations == 0 && activity.deallocations == 0 && activity.blockingCalls == 0,
                   "every warmed effect and control update must avoid heap work and blocking on the audio thread");
        }
    }
}
} // namespace Tests
