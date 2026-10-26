#include "TestHarness.hpp"
#include "diagnostics/AcousticLatencyMeter.hpp"
#include "diagnostics/LatencyRegistry.hpp"
#include "diagnostics/TraceBuffer.hpp"

#include <algorithm>
#include <array>
#include <cmath>
#include <deque>
#include <new>
#include <span>
#include <utility>
#include <vector>

namespace {
void fillTraceBuffer(TraceBuffer& trace) {
    for (std::uint32_t value = 0; value < 40; ++value)
        trace.push(
            {static_cast<MonotonicTicks>(value), SessionFrame{value}, GenerationId{1}, 1, value});
}

void addChirpTrain(std::span<float> recorded, std::span<const float> chirp, std::uint32_t rateHz,
                   std::uint32_t shift, float gain) {
    for (const auto offset : std::array{0.0, 0.33, 0.71}) {
        const auto start = shift + static_cast<std::uint32_t>(offset * rateHz);
        for (std::size_t index = 0; index < chirp.size(); ++index)
            recorded[start + index] += chirp[index] * gain;
    }
}
} // namespace

namespace Tests {
void latencyRegistrySumsStages() {
    LatencyRegistry registry;
    registry.set(LatencyRegistry::Stage::ClockBridge, 512, 0, 128);
    registry.set(LatencyRegistry::Stage::Dsp, 0, 64, 0);
    expect(registry.totalFrames() == 192,
           "latency registry sums actual fill and algorithmic latency");
}

void monitoringLatencyExcludesUnrelatedRoutesAndSaturates() {
    LatencyRegistry registry;
    registry.set(LatencyRegistry::Stage::Capture, 0, 0, 48);
    registry.set(LatencyRegistry::Stage::OutputDriver, 0, 0, 96);
    for (const auto stage :
         {LatencyRegistry::Stage::MediaDecoder, LatencyRegistry::Stage::MediaPitch,
          LatencyRegistry::Stage::RecordingQueue, LatencyRegistry::Stage::NetworkSend,
          LatencyRegistry::Stage::NetworkJitter})
        registry.set(stage, 1000, 200, 500);
    expect(registry.totalFrames() == 144,
           "media, recording and network queues do not delay local monitoring");
    registry.set(LatencyRegistry::Stage::Dsp, 0, UINT32_MAX, 1);
    expect(registry.totalFrames() == UINT32_MAX,
           "latency sums saturate without overflowing individual stages");
}

void acousticLatencyLocatesChirpTrainOffset() {
    constexpr std::uint32_t rate = 48'000;
    const auto chirp = AcousticLatencyMeter::chirp(rate);
    std::vector<float> recorded(rate * 2U, 0.0F);
    constexpr std::uint32_t shift = 1'234;
    addChirpTrain(recorded, chirp, rate, shift, 0.1F);
    const auto found = AcousticLatencyMeter::locate(recorded, chirp, rate);
    expect(found && found->first == shift, "the chirp train is found at its exact frame offset");
}

namespace {
// Plays the meter's output into a simulated room: the microphone hears whatever was presented
// `acousticFrames` earlier, and the device stamps each captured block with its capture time.
AcousticLatencyMeter::State simulateAcousticRoom(AcousticLatencyMeter& meter,
                                                 std::uint32_t acousticFrames, float loopGain,
                                                 AcousticLatencyMeter::Result& result,
                                                 bool prepare = true) {
    constexpr std::uint32_t rate = 48'000;
    constexpr std::uint32_t block = 480;
    constexpr MonotonicTicks start = 1'000'000'000'000;
    constexpr MonotonicTicks blockNs = 10'000'000;
    if (prepare)
        meter.prepare(rate, rate);
    (void)meter.start();
    std::deque<float> air(acousticFrames, 0.0F);
    std::vector<float> output(block), microphone(block);
    for (std::uint32_t index = 0; index < 250; ++index) {
        const auto presentedAt = start + static_cast<MonotonicTicks>(index) * blockNs;
        std::ranges::fill(output, 0.0F);
        meter.render(output, block, 1, presentedAt);
        for (std::uint32_t frame = 0; frame < block; ++frame) {
            air.push_back(output[frame] * loopGain);
            microphone[frame] = air.front();
            air.pop_front();
        }
        meter.capture(microphone, block, 1, presentedAt);
    }
    return meter.poll(result);
}
} // namespace

void acousticLatencyMeasuresTheUnreportedRoundTrip() {
    for (const auto polarity : std::array{0.3F, -0.3F}) {
        AcousticLatencyMeter meter;
        AcousticLatencyMeter::Result result;
        const auto state = simulateAcousticRoom(meter, 1'440, polarity, result);
        expect(state == AcousticLatencyMeter::State::Done &&
                   std::llabs(result.hiddenLatencyNs - 30'000'000) < 100'000,
               "the measured delay is independent of microphone polarity");
    }
}

void acousticLatencyRefusesAMissingLoop() {
    AcousticLatencyMeter meter;
    AcousticLatencyMeter::Result result;
    expect(simulateAcousticRoom(meter, 1'440, 0.0F, result) == AcousticLatencyMeter::State::Failed,
           "a microphone that does not hear the speaker fails instead of reporting a number");
}
void acousticLatencyRejectsAmbiguousPaths() {
    constexpr std::uint32_t rate = 48'000;
    const auto chirp = AcousticLatencyMeter::chirp(rate);
    std::vector<float> recorded(rate * 2U, 0.0F);
    for (const auto [shift, gain] : std::array{std::pair{480U, 0.08F}, std::pair{2'880U, 0.30F}})
        addChirpTrain(recorded, chirp, rate, shift, gain);
    expect(!AcousticLatencyMeter::locate(recorded, chirp, rate),
           "a stronger echo must not become an apparently certain calibration");
}

void acousticLatencyRejectsBrokenTimelines() {
    constexpr std::uint32_t rate = 48'000, block = 480;
    constexpr MonotonicTicks start = 1'000'000'000'000;
    // Same PCM, different kinds of broken timing: capture clock, output clock, device
    // position, and an explicit backend timestamp error.
    for (const auto fault : std::array{0, 1, 2, 3}) {
        AcousticLatencyMeter meter;
        meter.prepare(rate, rate);
        (void)meter.start();
        std::vector<float> output(block);
        for (std::uint32_t i = 0; i < 180; ++i) {
            const auto at = start + static_cast<MonotonicTicks>(i) * 10'000'000;
            const auto jump = i >= 2 ? 10'000'000 : 0;
            std::ranges::fill(output, 0.0F);
            if (fault == 3 && i == 2)
                meter.invalidateTiming();
            meter.render(output, block, 1, at + (fault == 1 ? jump : 0));
            meter.capture(output, block, 1, at + (fault == 0 ? jump : 0),
                          static_cast<std::int64_t>(i) * block +
                              (fault == 2 && i >= 2 ? block : 0));
        }
        AcousticLatencyMeter::Result result;
        expect(meter.poll(result) == AcousticLatencyMeter::State::Failed,
               "a discontinuous capture or render timeline must invalidate calibration");
    }
}
void acousticLatencyCancelStopsTheChirpForGood() {
    constexpr std::uint32_t rate = 48'000, block = 480;
    constexpr MonotonicTicks start = 1'000'000'000'000;
    AcousticLatencyMeter meter;
    meter.prepare(rate, rate);
    (void)meter.start();
    std::vector<float> output(block, 0.0F);
    meter.render(output, block, 1, start);
    expect(std::ranges::any_of(output, [](float value) { return value != 0.0F; }),
           "a started measurement renders its first chirp");
    meter.cancel();
    bool silent = true;
    for (std::uint32_t i = 1; i < 250; ++i) {
        const auto at = start + static_cast<MonotonicTicks>(i) * 10'000'000;
        std::ranges::fill(output, 0.0F);
        meter.render(output, block, 1, at);
        silent = silent && std::ranges::all_of(output, [](float value) { return value == 0.0F; });
        meter.capture(output, block, 1, at);
    }
    AcousticLatencyMeter::Result result;
    expect(silent, "no chirp sample is rendered after the measurement is cancelled");
    expect(meter.poll(result) == AcousticLatencyMeter::State::Failed && meter.cancelled(),
           "a cancelled measurement stays cancelled and never completes from later capture");
    (void)meter.start();
    expect(!meter.cancelled(), "a new deliberate measurement starts clean");
}
void acousticCalibrationRequiresAgreementInTheCurrentSession() {
    AcousticLatencyMeter meter;
    AcousticLatencyMeter::Result result;
    meter.prepare(48'000, 48'000);
    for (const auto [frames, accepted] :
         std::array{std::pair{1'440U, false}, std::pair{1'488U, true}, std::pair{9'600U, true}}) {
        (void)simulateAcousticRoom(meter, frames, 0.3F, result, false);
        expect(meter.acceptsCalibration(30'000'000) == accepted,
               "two agreeing valid runs allow calibration even if the third is an outlier");
    }
    expect(!meter.acceptsCalibration(200'000'000), "an outlier cannot overwrite calibration");
    meter.prepare(48'000, 48'000);
    expect(!meter.acceptsCalibration(30'000'000) && meter.lastResult().confidence == 0.0,
           "opening new streams invalidates measurements from the previous session");
}
void traceBufferKeepsOnlyLastEvents() {
    TraceBuffer trace;
    fillTraceBuffer(trace);
    const auto snapshot = trace.snapshot();
    expect(snapshot.events.size() == TraceBuffer::Capacity &&
               snapshot.events.front().payload == 8 && snapshot.events.back().payload == 39,
           "trace buffer keeps exactly the last bounded events");
}

void traceBufferCountsOverwrittenEvents() {
    TraceBuffer trace;
    fillTraceBuffer(trace);
    expect(trace.snapshot().overwritten == 8, "trace buffer reports overwritten event count");
}

void traceBufferRecoversAfterSnapshotAllocationFails() {
    TraceBuffer trace;
    trace.push({1, SessionFrame{1}, GenerationId{1}, 1, 1});
    failNextAllocationOfSize(TraceBuffer::Capacity * sizeof(TraceEvent));
    bool allocationFailed = false;
    try {
        (void)trace.snapshot();
    } catch (const std::bad_alloc&) {
        allocationFailed = true;
    }
    failNextAllocationOfSize(0);
    trace.push({2, SessionFrame{2}, GenerationId{1}, 1, 2});
    expect(allocationFailed && trace.size() == 2,
           "a failed snapshot allocation must release the trace write gate");
}

} // namespace Tests
