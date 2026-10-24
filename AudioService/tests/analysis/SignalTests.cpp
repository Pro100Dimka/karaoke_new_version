#include "TestHarness.hpp"
#include "analysis/AnalysisEngine.hpp"
#include "analysis/OutputSpectrum.hpp"
#include "analysis/SignalMetrics.hpp"

#include <algorithm>
#include <cmath>
#include <numbers>
#include <thread>
#include <vector>

struct AnalysisTestAccess {
    static void wake(AnalysisEngine& engine) {
        engine.wakeWorker();
    }
    static void stop(AnalysisEngine& engine) {
        engine.stopWorker();
    }
};

namespace {
void waitForProcessedFrames(AnalysisEngine& analysis, std::uint64_t frames) {
    for (int attempt = 0; attempt < 100 && analysis.snapshot().processedFrames < frames; ++attempt)
        std::this_thread::sleep_for(std::chrono::milliseconds(2));
}

float sineAtFrame(float frequencyHz, std::size_t frame, std::uint32_t sampleRateHz) {
    return std::sin(2.0F * std::numbers::pi_v<float> * frequencyHz * static_cast<float>(frame) /
                    static_cast<float>(sampleRateHz));
}
} // namespace

namespace Tests {
void analysisRetainsCaptureTimesAcrossPollingAndRejectsOldGeneration() {
    constexpr std::uint32_t rate = 48000, window = 2048;
    constexpr MonotonicTicks firstAt = 2'000'000'000;
    AnalysisEngine analysis;
    analysis.prepare(1, rate, rate, GenerationId{9});
    std::vector<float> samples(window);
    for (std::uint32_t block = 0; block < 3; ++block) {
        for (std::uint32_t frame = 0; frame < window; ++frame)
            samples[frame] = 0.5F * sineAtFrame(220.0F, frame, rate);
        analysis.push(GenerationId{9}, samples, window,
                      firstAt + static_cast<MonotonicTicks>(block * window) * 1'000'000'000 / rate);
    }
    waitForProcessedFrames(analysis, window * 3);
    const auto history = analysis.pitchHistory();
    expect(history.size() == 3, "a slow UI poll retains every measured pitch window");
    for (std::size_t index = 0; index < history.size(); ++index) {
        const auto centre = firstAt + static_cast<MonotonicTicks>(index * window + window / 2) * 1'000'000'000 / rate;
        expect(std::abs(history[index].capturedAt - centre) <= 1 &&
                   std::abs(history[index].pitchHz - 220) < 3 && history[index].audioActive,
               "pitch belongs to the capture window centre, independent of worker delay");
    }
    analysis.setGeneration(GenerationId{10});
    expect(analysis.pitchHistory().empty(), "reconfiguration discards old pitch evidence");
}

void analysisStopNeverLosesTheWorkerWakeup() {
    AnalysisEngine analysis;
    std::atomic<std::uint32_t> progress{0}, rescued{0};
    std::atomic<bool> finished{false};
    std::thread watchdog([&] {
        auto previous = progress.load();
        while (!finished.load()) {
            std::this_thread::sleep_for(std::chrono::milliseconds(100));
            const auto current = progress.load();
            if (current == previous && !finished.load()) {
                ++rescued;
                AnalysisTestAccess::wake(analysis);
            }
            previous = current;
        }
    });
    for (std::uint32_t cycle = 0; cycle < 30'000; ++cycle) {
        analysis.prepare(1, 48000, 32, GenerationId{cycle + 1});
        const auto stopAt =
            std::chrono::steady_clock::now() + std::chrono::microseconds(cycle % 80);
        while (std::chrono::steady_clock::now() < stopAt)
            std::this_thread::yield();
        AnalysisTestAccess::stop(analysis);
        ++progress;
    }
    finished.store(true);
    watchdog.join();
    expect(rescued.load() == 0,
           "analysis worker stop must complete without a replacement notification");
}

void signalMeasuresPeakAndRms() {
    SignalMetrics metrics;
    const std::vector<float> samples{0.0F, 0.5F, -1.0F, 0.25F};
    metrics.observe(samples);
    const auto snapshot = metrics.snapshot();
    expect(snapshot.peak == 1.0F && snapshot.rms > 0.0F && snapshot.rms <= 1.0F,
           "input peak and RMS are measured and bounded");
}

void spectrumRespondsToTheFrequencyPlayed() {
    constexpr std::uint32_t rate = 48000;
    OutputSpectrum spectrum;
    spectrum.prepare(rate);
    std::vector<float> stereo(rate * 2U);
    for (std::size_t frame = 0; frame < rate; ++frame) {
        const auto sample = 0.5F * sineAtFrame(100.0F, frame, rate);
        stereo[frame * 2U] = sample;
        stereo[frame * 2U + 1U] = sample;
    }
    spectrum.observe(stereo, 2);
    const auto levels = spectrum.snapshot();
    const auto loudest =
        static_cast<std::size_t>(std::ranges::max_element(levels) - levels.begin());
    expect(loudest <= 3 && levels[loudest] > 0.5F, "a 100 Hz tone lights a low band");
    expect(levels.back() < 0.2F, "the highest band stays quiet for a low tone");
}

void spectrumHonorsSourceGain() {
    OutputSpectrum spectrum;
    spectrum.prepare(48000);
    const std::vector<float> muted(2048, 0.8F);
    spectrum.observe(muted, 2, 0.0F);
    const auto levels = spectrum.snapshot();
    expect(std::ranges::max(levels) == 0.0F, "a muted source cannot drive its visual spectrum");
}

void signalCountsClipping() {
    SignalMetrics metrics;
    metrics.observe(std::vector<float>{0.0F, 0.5F, -1.0F, 0.25F});
    const auto snapshot = metrics.snapshot();
    expect(snapshot.clipping && snapshot.clipCount == 1, "clipping counted");
}

void analysisRejectsStaleGeneration() {
    AnalysisEngine analysis;
    analysis.prepare(1, 48000, 512, GenerationId{2});
    const std::vector<float> samples(64, 0.25F);
    analysis.push(GenerationId{1}, samples, 64);
    expect(analysis.snapshot().staleFrames == 64, "analysis rejects stale generation work");
}

void analysisPrepareResetsSignalMetrics() {
    AnalysisEngine analysis;
    analysis.prepare(1, 48000, 4096, GenerationId{1});
    const std::vector<float> quiet(2048, 0.01F);
    const std::vector<float> clipped(2048, 1.0F);
    analysis.push(GenerationId{1}, quiet, static_cast<std::uint32_t>(quiet.size()));
    analysis.push(GenerationId{1}, clipped, static_cast<std::uint32_t>(clipped.size()));
    waitForProcessedFrames(analysis, 4096);
    const auto before = analysis.snapshot();
    expect(before.signal.clipping && before.signal.clipCount == clipped.size() &&
               before.signal.noiseFloor > 0.0F,
           "first analysis session measures clipping and noise before they are reset");

    analysis.prepare(1, 48000, 4096, GenerationId{2});
    const auto after = analysis.snapshot();
    expect(after.signal.peak == 0.0F && after.signal.rms == 0.0F &&
               after.signal.noiseFloor == 0.0F && !after.signal.signalPresent &&
               !after.signal.clipping && after.signal.clipCount == 0,
           "new analysis session starts without the previous session's signal metrics");
}

void analysisDetectsLivePitch() {
    constexpr std::uint32_t rate = 48000;
    AnalysisEngine analysis;
    analysis.prepare(1, rate, rate, GenerationId{3});
    std::vector<float> samples(4096);
    for (std::size_t frame = 0; frame < samples.size(); ++frame)
        samples[frame] = 0.5F * sineAtFrame(440.0F, frame, rate);
    analysis.push(GenerationId{3}, samples, static_cast<std::uint32_t>(samples.size()));
    waitForProcessedFrames(analysis, 2048);
    const auto pitch = analysis.snapshot().pitchHz;
    expect(std::abs(pitch - 440.0F) < 3.0F, "analysis publishes detected microphone pitch");
}

void analysisAccumulatesDeviceSizedBlocksForPitch() {
    constexpr std::uint32_t rate = 48000;
    constexpr std::uint32_t period = 256;
    constexpr float expectedPitch = 220.0F;
    AnalysisEngine analysis;
    analysis.prepare(1, rate, rate, GenerationId{4});
    std::vector<float> samples(period);
    for (std::uint32_t block = 0; block < 8; ++block) {
        for (std::uint32_t frame = 0; frame < period; ++frame) {
            const auto timelineFrame = block * period + frame;
            samples[frame] = 0.5F * sineAtFrame(expectedPitch, timelineFrame, rate);
        }
        analysis.push(GenerationId{4}, samples, period);
        std::this_thread::sleep_for(std::chrono::milliseconds(2));
    }
    waitForProcessedFrames(analysis, 2048);
    expect(std::abs(analysis.snapshot().pitchHz - expectedPitch) < 3.0F,
           "device-period microphone blocks are accumulated before pitch estimation");
}

void analysisPrefersFundamentalOverStrongerHarmonic() {
    constexpr std::uint32_t rate = 48000;
    constexpr float fundamental = 220.0F;
    AnalysisEngine analysis;
    analysis.prepare(1, rate, rate, GenerationId{5});
    std::vector<float> samples(2048);
    for (std::size_t frame = 0; frame < samples.size(); ++frame) {
        const auto phase =
            2.0F * std::numbers::pi_v<float> * static_cast<float>(frame) / static_cast<float>(rate);
        samples[frame] =
            0.22F * std::sin(phase * fundamental) + 0.5F * std::sin(phase * fundamental * 2.0F);
    }
    analysis.push(GenerationId{5}, samples, static_cast<std::uint32_t>(samples.size()));
    waitForProcessedFrames(analysis, 2048);
    expect(std::abs(analysis.snapshot().pitchHz - fundamental) < 4.0F,
           "pitch detection follows the sung fundamental instead of a stronger octave harmonic");
}

void analysisRejectsUnpitchedNoise() {
    AnalysisEngine analysis;
    analysis.prepare(1, 48000, 48000, GenerationId{6});
    std::vector<float> samples(2048);
    std::uint32_t state = 12345;
    for (auto& sample : samples) {
        state = state * 1664525U + 1013904223U;
        sample = (static_cast<float>(state >> 8U) / 8388607.5F - 1.0F) * 0.35F;
    }
    analysis.push(GenerationId{6}, samples, static_cast<std::uint32_t>(samples.size()));
    waitForProcessedFrames(analysis, 2048);
    expect(analysis.snapshot().pitchHz == 0.0F,
           "unpitched microphone noise cannot light arbitrary karaoke notes");
}

void analysisRejectsLowFrequencyDrift() {
    for (const auto frequency : {3.0F, 20.0F, 40.0F}) {
        AnalysisEngine analysis;
        analysis.prepare(1, 48000, 48000, GenerationId{7});
        std::vector<float> samples(2048);
        for (std::size_t frame = 0; frame < samples.size(); ++frame)
            samples[frame] = 0.1F * sineAtFrame(frequency, frame, 48000);
        analysis.push(GenerationId{7}, samples, static_cast<std::uint32_t>(samples.size()));
        waitForProcessedFrames(analysis, 2048);
        expect(analysis.snapshot().pitchHz == 0.0F,
               "low-frequency drift must not become a fictitious 1200 Hz sung note");
    }
}

void analysisPreservesLowVoiceAcrossSampleRates() {
    for (const auto rate : {44100U, 48000U, 96000U, 192000U}) {
        AnalysisEngine analysis;
        analysis.prepare(1, rate, rate, GenerationId{8});
        const auto frames = static_cast<std::uint32_t>(std::ceil(2048.0 * rate / 48000));
        std::vector<float> samples(256);
        for (std::uint32_t from = 0; from < frames; from += 256) {
            for (std::uint32_t frame = 0; frame < samples.size(); ++frame)
                samples[frame] = 0.3F * sineAtFrame(80.0F, from + frame, rate);
            analysis.push(GenerationId{8}, samples, 256);
        }
        waitForProcessedFrames(analysis, frames);
        expect(std::abs(analysis.snapshot().pitchHz - 80.0F) < 2.0F,
               "a low voice keeps its pitch and analysis-window duration on high-rate devices");
    }
}

void analysisDetectsBreathyVoiceAboveBackgroundNoise() {
    AnalysisEngine analysis;
    analysis.prepare(1, 48000, 48000, GenerationId{11});
    std::vector<float> samples(2048);
    std::uint32_t noise = 12345;
    for (std::size_t frame = 0; frame < samples.size(); ++frame) {
        noise = noise * 1664525U + 1013904223U;
        const auto breath = (static_cast<float>(noise >> 8U) / 8388607.5F - 1.0F) * 0.25F;
        samples[frame] = 0.18F * sineAtFrame(220, frame, 48000) + breath;
    }
    analysis.push(GenerationId{11}, samples, static_cast<std::uint32_t>(samples.size()));
    waitForProcessedFrames(analysis, 2048);
    expect(std::abs(analysis.snapshot().pitchHz - 220) < 6,
           "audible breathy singing is measurable even below the old periodicity cutoff");
}

void analysisPitchDoesNotDependOnMicrophoneSensitivity() {
    for (const auto level : {0.5F, 0.005F, 0.0005F}) {
        AnalysisEngine analysis;
        analysis.prepare(1, 48000, 48000, GenerationId{12});
        std::vector<float> samples(2048);
        for (std::size_t frame = 0; frame < samples.size(); ++frame)
            samples[frame] = level * sineAtFrame(220, frame, 48000);
        analysis.push(GenerationId{12}, samples, static_cast<std::uint32_t>(samples.size()));
        waitForProcessedFrames(analysis, 2048);
        expect(std::abs(analysis.snapshot().pitchHz - 220) < 3,
               "a clean quiet microphone must not become a missed note before the user's gain knob");
    }
}

void analysisIgnoresQuietBleedAfterAudibleSinging() {
    AnalysisEngine analysis;
    analysis.prepare(1, 48000, 48000, GenerationId{13});
    std::vector<float> samples(2048);
    for (const auto level : {0.5F, 0.0005F}) {
        for (std::size_t frame = 0; frame < samples.size(); ++frame)
            samples[frame] = level * sineAtFrame(220, frame, 48000);
        const auto submitted = analysis.snapshot().processedFrames + samples.size();
        analysis.push(GenerationId{13}, samples, static_cast<std::uint32_t>(samples.size()),
                      2'000'000'000 + static_cast<MonotonicTicks>(submitted) * 1'000'000'000 / 48000);
        waitForProcessedFrames(analysis, submitted);
    }
    const auto history = analysis.pitchHistory();
    expect(history.size() == 2 && history.front().audioActive && !history.back().audioActive &&
               history.back().pitchHz == 0,
           "residual periodic bleed below the singer's audible range is neither a note nor an entry");
}

void analysisKeepsUnpitchedConsonantsAfterQuietSinging() {
    AnalysisEngine analysis;
    analysis.prepare(1, 48000, 48000, GenerationId{14});
    std::vector<float> samples(2048);
    std::uint32_t noise = 12345;
    for (std::uint32_t block = 0; block <= 80; ++block) {
        for (std::size_t frame = 0; frame < samples.size(); ++frame) {
            noise = noise * 1664525U + 1013904223U;
            samples[frame] = block < 80 ? 0.02F * sineAtFrame(220, frame, 48000)
                : (static_cast<float>(noise >> 8U) / 8388607.5F - 1.0F) * 0.008F;
        }
        const auto submitted = static_cast<std::uint64_t>(block + 1) * samples.size();
        analysis.push(GenerationId{14}, samples, static_cast<std::uint32_t>(samples.size()),
                      2'000'000'000 + static_cast<MonotonicTicks>(block) * 2048 * 1'000'000'000 / 48000);
        waitForProcessedFrames(analysis, submitted);
    }
    const auto history = analysis.pitchHistory();
    expect(!history.empty() && history.back().pitchHz == 0 && history.back().audioActive,
           "sustained quiet singing cannot become the noise floor and erase subsequent consonants");
}

void analysisSeparatesVoicePitchFromOutOfRangeNoise() {
    for (const auto rate : {44100U, 48000U, 96000U}) {
        AnalysisEngine analysis;
        analysis.prepare(1, rate, rate, GenerationId{15});
        const auto frames = static_cast<std::uint32_t>(std::ceil(2048.0 * rate / 48000));
        std::vector<float> samples(frames);
        for (std::size_t frame = 0; frame < samples.size(); ++frame)
            samples[frame] = 0.05F * sineAtFrame(220, frame, rate) + 0.3F * sineAtFrame(6000, frame, rate);
        analysis.push(GenerationId{15}, samples, frames);
        waitForProcessedFrames(analysis, frames);
        expect(std::abs(analysis.snapshot().pitchHz - 220) < 6,
               "high-frequency breath and device noise cannot replace the singer's fundamental");
    }
}
} // namespace Tests
