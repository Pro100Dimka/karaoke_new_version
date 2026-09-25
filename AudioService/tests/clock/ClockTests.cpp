#include "TestHarness.hpp"
#include "clock/ClockBridge.hpp"
#include "clock/ClockSynchronizer.hpp"

#include <cmath>
#include <atomic>
#include <thread>
#include <vector>

namespace Tests {
void clockDiagnosticsRemainObservableAcrossThreads() {
    // A bounded polling reader models an independent diagnostics consumer. Plain
    // shared fields allow Release optimization to cache the first value forever.
    ClockSynchronizer sync;
    bool observed = true;
    for (int attempt = 0; attempt < 16 && observed; ++attempt) {
        sync.prepare(48000, 48000);
        sync.observe({0, 0, 1000, 1000, true});
        std::atomic<bool> started{false};
        bool updated = false;
        std::thread reader([&] {
            started.store(true, std::memory_order_release);
            for (std::uint32_t poll = 0; poll < 100'000'000; ++poll) {
                if (sync.driftPpm() > 0.0) {
                    updated = true;
                    break;
                }
            }
        });
        while (!started.load(std::memory_order_acquire))
            std::this_thread::yield();
        sync.observe({48048, 48000, 2000, 2000, true});
        reader.join();
        observed = updated;
    }
    expect(observed, "diagnostics must observe drift published by the render thread");

    ClockBridge bridge;
    bridge.prepare(64, 32, 1);
    std::atomic<bool> finished{false};
    std::thread producer([&] {
        std::array<float, 128> block{};
        for (int iteration = 0; iteration < 10000; ++iteration) {
            (void)bridge.push(block, 128); // deliberately oversized packet
            (void)bridge.pull(block, 64, 1.0); // empty capture queue
        }
        finished.store(true, std::memory_order_release);
    });
    ClockBridgeSnapshot previous{};
    bool monotonic = true;
    while (!finished.load(std::memory_order_acquire)) {
        const auto snapshot = bridge.snapshot();
        monotonic = monotonic && snapshot.overruns >= previous.overruns &&
                    snapshot.underruns >= previous.underruns;
        previous = snapshot;
    }
    producer.join();
    const auto final = bridge.snapshot();
    expect(monotonic && final.overruns == 10000 && final.underruns == 10000,
           "independent diagnostics retain monotonic and exact capture/render error counts");
}

void clockCorrectionCompensatesTheDirectionOfCaptureDrift() {
    for (const auto captureFrames : {47952, 48048}) {
        ClockSynchronizer sync;
        sync.prepare(48000, 48000);
        sync.observe({0, 0, 1000, 1000, true});
        sync.observe({captureFrames, 48000, 2000, 2000, true});
        expect(captureFrames > 48000 ? sync.correctionRatio() > 1.0
                                    : sync.correctionRatio() < 1.0,
               "a faster capture clock must consume more input per output frame, not less");
    }
}

void clockBridgeHonorsDeviceRateRatiosOutsideTwoToOne() {
    for (const double ratio : {1.0 / 6.0, 4.0, 6.0}) {
        ClockBridge bridge;
        bridge.prepare(8192, 128, 1);
        std::vector<float> input(4096), output(128);
        for (std::size_t index = 0; index < input.size(); ++index)
            input[index] = static_cast<float>(index) / 4096.0F;
        expect(bridge.push(input, 4096), "input rate conversion fixture is queued");
        expect(bridge.pull(output, 128, ratio) == 128, "device conversion supplies full block");
        expect(std::abs(output[120] - static_cast<float>(120.0 * ratio / 4096.0)) < 0.00001F,
               "conversion follows the actual device ratio rather than a two-to-one clamp");
    }
}

void clockDetectsPositiveDrift() {
    ClockSynchronizer sync;
    sync.prepare(48000, 48000);
    sync.observe({0, 0, 1'000'000, 1'000'000, true});
    sync.observe({48005, 48000, 2'000'000, 2'000'000, true});
    expect(sync.driftPpm() > 0.0, "positive capture drift detected");
}

void clockRejectsNonMonotonicTimestamp() {
    ClockSynchronizer sync;
    sync.prepare(48000, 48000);
    sync.observe({0, 0, 1'000'000, 1'000'000, true});
    sync.observe({48005, 48000, 2'000'000, 2'000'000, true});
    const auto beforeInvalid = sync.driftPpm();
    sync.observe({96010, 96000, 1'500'000, 3'000'000, true});
    expect(sync.driftPpm() == beforeInvalid,
           "non-monotonic timestamp never drives drift estimator");
}

void clockNormalizesNominalRates() {
    ClockSynchronizer sync;
    sync.prepare(44100, 48000);
    sync.observe({0, 0, 1000, 1000, true});
    sync.observe({44100, 48000, 2000, 2000, true});
    expect(std::abs(sync.driftPpm()) < 0.001,
           "different nominal sample rates are normalized before drift estimation");
}

void clockUsesDeviceTimestamps() {
    ClockSynchronizer sync;
    sync.prepare(48000, 48000);
    sync.observe({0, 0, 1000, 1000, true});
    sync.observe({48000, 48000, 2000, 2001, true});
    expect(sync.driftPpm() > 0.0, "independent device timestamps participate in drift estimation");
}

void clockBridgeDoesNotCreep() {
    ClockBridge bridge;
    bridge.prepare(4096, 128, 2);
    std::vector<float> input(1024U * 2U, 0.25F);
    std::vector<float> output(128U * 2U);
    expect(bridge.push(input, 1024), "clock bridge accepts prepared PCM");
    for (int iteration = 0; iteration < 4; ++iteration) {
        expect(bridge.pull(output, 128, 1.0) == 128, "clock bridge renders full period");
    }
    const auto fill = bridge.snapshot().fillFrames;
    expect(fill >= 510 && fill <= 514,
           "clock bridge consumes approximately exact frames without creep");
}
} // namespace Tests
