#include "TestHarness.hpp"
#include "diagnostics/AcousticLatencyMeter.hpp"
#include "diagnostics/LatencyRegistry.hpp"
#include "diagnostics/TraceBuffer.hpp"

#include <deque>
#include <vector>

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
    constexpr std::array offsets{0.0, 0.33, 0.71};
    constexpr std::uint32_t shift = 1'234;
    for (const auto offset : offsets) {
        const auto start = shift + static_cast<std::uint32_t>(offset * rate);
        for (std::size_t index = 0; index < chirp.size(); ++index)
            recorded[start + index] += chirp[index] * 0.1F;
    }
    const auto found = AcousticLatencyMeter::locate(recorded, chirp, rate);
    expect(found && found->first == shift, "the chirp train is found at its exact frame offset");
}

namespace {
// Plays the meter's output into a simulated room: the microphone hears whatever was presented
// `acousticFrames` earlier, and the device stamps each captured block with its capture time.
AcousticLatencyMeter::State simulateAcousticRoom(AcousticLatencyMeter& meter,
                                                 std::uint32_t acousticFrames, float loopGain,
                                                 AcousticLatencyMeter::Result& result) {
    constexpr std::uint32_t rate = 48'000;
    constexpr std::uint32_t block = 480;
    constexpr MonotonicTicks start = 1'000'000'000'000;
    constexpr MonotonicTicks blockNs = 10'000'000;
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
    AcousticLatencyMeter meter;
    AcousticLatencyMeter::Result result;
    const auto state = simulateAcousticRoom(meter, 1'440, 0.3F, result); // 30 ms hidden path
    expect(state == AcousticLatencyMeter::State::Done &&
               std::llabs(result.hiddenLatencyNs - 30'000'000) < 100'000,
           "the hidden speaker-to-microphone latency is measured to a fraction of a millisecond");
}

void acousticLatencyRefusesAMissingLoop() {
    AcousticLatencyMeter meter;
    AcousticLatencyMeter::Result result;
    expect(simulateAcousticRoom(meter, 1'440, 0.0F, result) == AcousticLatencyMeter::State::Failed,
           "a microphone that does not hear the speaker fails instead of reporting a number");
}
void traceBufferKeepsOnlyLastEvents() {
    TraceBuffer trace;
    for (std::uint32_t value = 0; value < 40; ++value)
        trace.push(
            {static_cast<MonotonicTicks>(value), SessionFrame{value}, GenerationId{1}, 1, value});
    const auto snapshot = trace.snapshot();
    expect(snapshot.events.size() == TraceBuffer::Capacity &&
               snapshot.events.front().payload == 8 && snapshot.events.back().payload == 39,
           "trace buffer keeps exactly the last bounded events");
}

void traceBufferCountsOverwrittenEvents() {
    TraceBuffer trace;
    for (std::uint32_t value = 0; value < 40; ++value)
        trace.push(
            {static_cast<MonotonicTicks>(value), SessionFrame{value}, GenerationId{1}, 1, value});
    expect(trace.snapshot().overwritten == 8, "trace buffer reports overwritten event count");
}

} // namespace Tests
