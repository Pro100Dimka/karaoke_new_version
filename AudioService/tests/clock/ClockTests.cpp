#include "TestHarness.hpp"
#include "clock/ClockBridge.hpp"
#include "clock/ClockSynchronizer.hpp"

#include <atomic>
#include <cmath>
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
    bridge.prepare(64, 32, 1, 48000);
    std::atomic<bool> finished{false};
    std::thread producer([&] {
        std::array<float, 128> block{};
        for (int iteration = 0; iteration < 10000; ++iteration) {
            (void)bridge.push(block, 128);     // deliberately oversized packet
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
        expect(captureFrames > 48000 ? sync.correctionRatio() > 1.0 : sync.correctionRatio() < 1.0,
               "a faster capture clock must consume more input per output frame, not less");
    }
}

void clockBridgeHonorsDeviceRateRatiosOutsideTwoToOne() {
    for (const double ratio : {1.0 / 6.0, 4.0, 6.0}) {
        ClockBridge bridge;
        bridge.prepare(8192, 128, 1, 48000);
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

void clockRecoversFromAStationaryStartupClock() {
    for (const std::uint32_t captureRate : {44100U, 48000U, 96000U}) {
        for (const double driftPpm : {-100.0, 0.0, 100.0}) {
            ClockSynchronizer sync;
            sync.prepare(captureRate, 48000);
            sync.observe({0, 0, 1'000'000, 1'000'000, true});
            const auto capturePeriod = captureRate / 100;
            // The endpoint clock has not started advancing during the first engine pass.
            sync.observe({capturePeriod, 1, 1'100'000, 1'100'000, true});
            for (std::int64_t block = 1; block <= 30'000; ++block) {
                const auto captured = static_cast<std::int64_t>(std::llround(
                    static_cast<double>(block) * capturePeriod * (1.0 + driftPpm / 1'000'000.0)));
                sync.observe({capturePeriod + captured, 1 + block * 480,
                              1'100'000 + block * 100'000, 1'100'000 + block * 100'000, true});
            }
            expect(sync.rejectedObservations() > 0, "stationary startup clock is rejected");
            expect(std::abs(sync.driftPpm() - driftPpm) < 0.5 &&
                       std::abs((sync.correctionRatio() - 1.0) * 1'000'000.0 - driftPpm) < 0.5,
                   "startup offsets must be discarded while real device drift remains compensated; " +
                       std::to_string(driftPpm) + " -> " + std::to_string(sync.driftPpm()));
        }
    }
}

void clockRecoversAfterOneRenderClockPause() {
    ClockSynchronizer sync;
    sync.prepare(48000, 48000);
    sync.observe({0, 0, 1'000'000, 1'000'000, true});
    for (std::int64_t block = 1; block <= 18'000; ++block) {
        // At one minute the render clock pauses for 200 ms, then resumes at its old rate.
        const auto renderBlock = block <= 6'000 ? block : std::max<std::int64_t>(6'000, block - 20);
        const auto at = 1'000'000 + block * 100'000;
        sync.observe({block * 480, renderBlock * 480, at, at, true});
    }
    expect(sync.rejectedObservations() >= 20,
           "stationary render-clock observations are rejected");
    expect(std::abs(sync.driftPpm()) < 100.0 &&
               std::abs((sync.correctionRatio() - 1.0) * 1'000'000.0) < 100.0,
           "a one-time render-clock pause must not bias steady-state drift for minutes");
}

void clockWindowRetainsLongRunDrift() {
    for (const double driftPpm : {-100.0, 100.0}) {
        ClockSynchronizer sync;
        sync.prepare(44100, 48000);
        sync.observe({0, 0, 1'000'000, 1'000'000, true});
        for (std::int64_t block = 1; block <= 180'000; ++block) {
            const auto capture = static_cast<std::int64_t>(std::llround(
                block * 441.0 * (1.0 + driftPpm / 1'000'000.0)));
            const auto at = 1'000'000 + block * 100'000;
            sync.observe({capture, block * 480, at, at, true});
        }
        expect(std::abs(sync.driftPpm() - driftPpm) < 0.5 &&
                   std::abs((sync.correctionRatio() - 1.0) * 1'000'000.0 - driftPpm) < 0.5,
               "thirty minutes of real 44.1/48 kHz drift remains compensated");
    }
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
    bridge.prepare(4096, 128, 2, 48000);
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

void clockBridgeDoesNotDelayUnityRateBlocks() {
    for (const auto channels : {1U, 2U, 6U}) {
        ClockBridge bridge;
        constexpr std::uint32_t frames = 480;
        bridge.prepare(frames * 8, frames, channels, 48000);
        std::vector<float> input(frames * channels, 0.25F), output(input.size());
        expect(bridge.push(input, frames), "one complete capture packet is available");
        expect(bridge.pull(output, frames, 1.0) == frames && output == input,
               "unity-rate capture needs no lookahead sample from the next capture packet");
        expect(bridge.snapshot().fillFrames == 0 && bridge.snapshot().underruns == 0,
               "unity-rate monitoring must neither retain a sample nor report a false underrun");
    }
}

void clockBridgeDiagnosticsRetainDemandHistoryWithoutChangingPolicy() {
    ClockBridge bridge;
    bridge.prepare(4096, 48, 1, 48000);
    std::vector<float> input(2048, 0.25F), output(480);
    expect(bridge.push(input, 2048), "bridge diagnostic fixture has capture data");
    expect(bridge.pull(output, 128, 1.00005) == 128, "normal render demand is satisfied");
    expect(bridge.pull(output, 480, 1.00005) == 480, "one burst demand is satisfied");
    expect(bridge.pull(output, 128, 1.00005) == 128, "normal demand resumes");
    expect(bridge.snapshot().fillBeforePullP50Frames == 0,
           "render-thread snapshot does not sort diagnostic fill samples");
    const auto state = bridge.diagnosticSnapshot();
    expect(state.currentDemandFrames >= 128 && state.currentDemandFrames < 129 &&
               state.largestDemandFrames >= 480 && state.largestDemandFrames < 481 &&
               state.fillBeforePullP50Frames > 0 && state.fillBeforePullMaximumFrames >=
                   state.fillBeforePullP50Frames,
           "bounded bridge diagnostics expose current demand, max-ever demand and fill spread");
}

void clockBridgeOneBurstDoesNotRaiseSustainedFill() {
    const auto run = [](bool burst) {
        ClockBridge bridge;
        bridge.prepare(4096, 48, 1, 48000);
        std::vector<float> input(480, 0.25F), output(480);
        (void)bridge.push(input, 128);
        for (unsigned block = 0; block < 48'000U * 30U / 128U; ++block) {
            const auto frames = burst && block == 1000 ? 480U : 128U;
            (void)bridge.push(input, frames);
            (void)bridge.pull(output, frames, 1.00005);
        }
        return bridge.diagnosticSnapshot();
    };
    const auto normal = run(false);
    const auto once = run(true);
    expect(normal.underruns == 0 && once.underruns == 0,
           "burst comparison must have continuous bridge output");
    expect(once.droppedFrames == 0,
           "removing an obsolete demand reserve must not discard captured PCM; dropped=" +
               std::to_string(once.droppedFrames));
    expect(once.fillBeforePullP50Frames <= normal.fillBeforePullP50Frames + 128,
           "one recovered render burst must not retain more than one extra period of fill; "
           "normal=" + std::to_string(normal.fillBeforePullP50Frames) +
               " burst=" + std::to_string(once.fillBeforePullP50Frames));
}

void clockBridgeTypicalCapacityDoesNotIncreaseTarget() {
    const auto small = ClockBridge::recommendedTargetFrames(1024, 44100);
    const auto large = ClockBridge::recommendedTargetFrames(3584, 44100);
    expect(small == 45 && large == small,
           "observed endpoint capacities change ring headroom without raising the target reserve");
}

void clockBridgeRecoversFromAnExtraCapturePacket() {
    for (const auto frames : {128U, 480U, 960U}) {
        ClockBridge bridge;
        bridge.prepare(frames * 8, 48, 1, 48000);
        std::vector<float> input(frames, 0.25F), output(frames);
        expect(bridge.push(input, frames), "a delayed callback leaves one extra packet queued");
        bool continuous = true;
        for (unsigned block = 0; block < 48000U * 30U / frames; ++block) {
            continuous = bridge.push(input, frames) && continuous;
            continuous = bridge.pull(output, frames, 1.0) == frames && continuous;
            continuous =
                std::all_of(output.begin(), output.end(),
                            [](float sample) { return std::abs(sample - 0.25F) < 1.e-6F; }) &&
                continuous;
        }
        const auto state = bridge.snapshot();
        expect(continuous && state.overruns == 0 && state.underruns == 0,
               "backlog recovery must not drop packets or insert silence");
        expect(state.fillFrames >= 32 && state.fillFrames <= 64,
               "an extra capture packet must converge to the small target, not remain forever");
    }
}

void clockBridgeDropsABacklogLeftByARenderStall() {
    // The render side stalled for most of the bridge while capture went on (a device switch):
    // the speed change alone would keep the voice that much late for over a minute.
    ClockBridge bridge;
    bridge.prepare(3528, 45, 1, 44100);
    std::vector<float> input(441, 0.25F), output(441);
    for (unsigned block = 0; block < 7; ++block)
        (void)bridge.push(input, 441);
    for (unsigned block = 0; block < 100; ++block) {
        (void)bridge.push(input, 441);
        (void)bridge.pull(output, 441, 1.0);
    }
    const auto state = bridge.snapshot();
    expect(state.fillFrames <= 45 + 441 && state.droppedFrames > 0 && state.underruns == 0,
           "a stale microphone backlog is dropped within one second, without inserting silence");
}

void clockBridgeKeepsAReserveForARenderSideThatPullsTwoPackets() {
    // A late render wake-up takes two packets at once; the bridge must still have them. The
    // clocks differ slightly, so the fill is regulated as on real devices.
    ClockBridge bridge;
    bridge.prepare(3528, 45, 1, 44100);
    std::vector<float> input(441, 0.25F), output(882);
    std::uint64_t underrunsAfterWarmup = 0;
    for (unsigned second = 0; second < 30; ++second) {
        if (second == 5)
            underrunsAfterWarmup = bridge.snapshot().underruns;
        for (unsigned block = 0; block < 50; ++block) {
            // Once in two seconds the render wake-up comes late, just before the second capture:
            // rarer than the fill window, so only a remembered reserve covers it.
            (void)bridge.push(input, 441);
            if (block == 0 && second % 2 == 0) {
                (void)bridge.pull(output, 882, 1.00005);
                (void)bridge.push(input, 441);
            } else {
                (void)bridge.pull(output, 441, 1.00005);
                (void)bridge.push(input, 441);
                (void)bridge.pull(output, 441, 1.00005);
            }
        }
    }
    const auto state = bridge.snapshot();
    expect(state.underruns == underrunsAfterWarmup && state.droppedFrames == 0,
           "double pulls find their audio and no microphone audio is thrown away");
    expect(state.fillFrames <= 882 + 441 + 45,
           "the reserve is one extra pull, not a growing backlog");
}

void clockBridgeBoundsResidualRateError() {
    for (const auto ratio : {0.9995, 1.0005}) {
        ClockBridge bridge;
        bridge.prepare(3840, 48, 1, 48000);
        std::vector<float> input(480, 0.25F), output(480), reserve(48, 0.25F);
        (void)bridge.push(reserve, 48);
        bool continuous = true;
        for (unsigned block = 0; block < 180'000; ++block) {
            continuous = bridge.push(input, 480) && continuous;
            continuous = bridge.pull(output, 480, ratio) == 480 && continuous;
        }
        const auto state = bridge.snapshot();
        expect(continuous && state.overruns == 0 && state.underruns == 0,
               "thirty minutes of residual rate error must not empty or overflow the bridge");
        expect(state.fillFrames < 128,
               "residual rate error must not accumulate monitoring latency");
    }
}

void clockBridgeRegulatesDifferentPacketClocks() {
    struct Configuration {
        unsigned inputRate, outputRate, inputPacket, outputPacket, channels;
    };
    for (const auto config :
         {Configuration{44100, 48000, 441, 480, 1}, Configuration{48000, 44100, 128, 256, 2},
          Configuration{96000, 48000, 960, 192, 6}}) {
        ClockBridge bridge;
        const auto target = config.inputRate / 1000;
        bridge.prepare(16384, target, config.channels, config.inputRate);
        const auto ratio = static_cast<double>(config.inputRate) / config.outputRate;
        std::vector<float> input(config.inputPacket * config.channels);
        std::vector<float> output(config.outputPacket * config.channels);
        std::uint64_t captured = 0;
        const auto pushPacket = [&] {
            for (unsigned frame = 0; frame < config.inputPacket; ++frame) {
                const auto value =
                    0.25F * static_cast<float>(std::sin(2.0 * 3.141592653589793 * 997.0 *
                                                        static_cast<double>(captured + frame) /
                                                        config.inputRate));
                for (unsigned channel = 0; channel < config.channels; ++channel)
                    input[frame * config.channels + channel] = value;
            }
            captured += config.inputPacket;
            return bridge.push(input, config.inputPacket);
        };
        bool continuous = pushPacket() && pushPacket();
        const auto initialFrames = captured;
        float previous = 0.0F;
        for (std::uint64_t block = 0; block < config.outputRate * 60U / config.outputPacket;
             ++block) {
            const auto due = initialFrames + (block + 1) * config.outputPacket * config.inputRate /
                                                 config.outputRate;
            while (captured + config.inputPacket <= due)
                continuous = pushPacket() && continuous;
            continuous = bridge.pull(output, config.outputPacket, ratio) == config.outputPacket &&
                         continuous;
            for (unsigned frame = 0; frame < config.outputPacket; ++frame) {
                const auto sample = output[frame * config.channels];
                continuous = continuous &&
                             std::abs(sample - previous) <=
                                 0.25 * 2.0 * 3.141592653589793 * 997.0 / config.outputRate * 1.002;
                previous = sample;
            }
        }
        const auto state = bridge.snapshot();
        expect(continuous && state.underruns == 0 && state.overruns == 0,
               "different clocks and packet sizes must remain continuous while backlog drains");
        expect(state.fillFrames <= target + config.inputPacket + 16,
               "normal packet batching must not become permanent extra latency");
        bridge.reset();
        expect(bridge.snapshot().fillFrames == 0 && bridge.snapshot().fillCorrectionRatio == 1.0,
               "restart discards the previous queue controller state");
    }
}
} // namespace Tests
