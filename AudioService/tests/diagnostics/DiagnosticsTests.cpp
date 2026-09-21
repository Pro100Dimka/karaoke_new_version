#include "TestHarness.hpp"
#include "diagnostics/LatencyMeasurement.hpp"
#include "diagnostics/LatencyRegistry.hpp"
#include "diagnostics/TraceBuffer.hpp"

#include <vector>

namespace Tests {
void latencyRegistrySumsStages() {
    LatencyRegistry registry;
    registry.set(LatencyRegistry::Stage::ClockBridge, 512, 0, 128);
    registry.set(LatencyRegistry::Stage::Dsp, 0, 64, 0);
    expect(registry.totalFrames() == 192,
           "latency registry sums actual fill and algorithmic latency");
}

void impulseLatencyFindsFrameOffset() {
    std::vector<float> reference(256, 0.0F), captured(512, 0.0F);
    reference[10] = 1.0F;
    captured[74] = 1.0F;
    const auto latency = measureImpulseLatency(reference, captured, 256);
    expect(latency.found && latency.latencyFrames == 64,
           "impulse latency measurement finds frame offset");
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
