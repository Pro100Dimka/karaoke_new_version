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

namespace Tests {
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
        const auto sample = 0.5F * std::sin(2.0F * std::numbers::pi_v<float> * 100.0F *
                                            static_cast<float>(frame) / static_cast<float>(rate));
        stereo[frame * 2U] = sample;
        stereo[frame * 2U + 1U] = sample;
    }
    spectrum.observe(stereo, 2);
    const auto levels = spectrum.snapshot();
    const auto loudest = static_cast<std::size_t>(std::ranges::max_element(levels) - levels.begin());
    expect(loudest <= 3 && levels[loudest] > 0.5F, "a 100 Hz tone lights a low band");
    expect(levels.back() < 0.2F, "the highest band stays quiet for a low tone");
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

void analysisDetectsLivePitch() {
    constexpr std::uint32_t rate = 48000;
    AnalysisEngine analysis;
    analysis.prepare(1, rate, rate, GenerationId{3});
    std::vector<float> samples(4096);
    for (std::size_t frame = 0; frame < samples.size(); ++frame)
        samples[frame] = 0.5F * std::sin(2.0F * std::numbers::pi_v<float> * 440.0F *
                                         static_cast<float>(frame) / static_cast<float>(rate));
    analysis.push(GenerationId{3}, samples, static_cast<std::uint32_t>(samples.size()));
    for (int attempt = 0; attempt < 100 && analysis.snapshot().processedFrames == 0; ++attempt)
        std::this_thread::sleep_for(std::chrono::milliseconds(2));
    const auto pitch = analysis.snapshot().pitchHz;
    expect(std::abs(pitch - 440.0F) < 3.0F, "analysis publishes detected microphone pitch");
}
} // namespace Tests
