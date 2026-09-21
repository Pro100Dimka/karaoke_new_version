#include "TestHarness.hpp"
#include "clock/ClockBridge.hpp"
#include "clock/ClockSynchronizer.hpp"

#include <cmath>
#include <vector>

namespace Tests {
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
