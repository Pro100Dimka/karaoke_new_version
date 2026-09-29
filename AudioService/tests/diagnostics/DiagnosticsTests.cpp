#include "TestHarness.hpp"
#include "diagnostics/AcousticLatencyMeter.hpp"
#include "diagnostics/LatencyRegistry.hpp"
#include "diagnostics/PassiveLatencyEstimator.hpp"
#include "diagnostics/TraceBuffer.hpp"

#include <chrono>
#include <cmath>
#include <deque>
#include <random>
#include <thread>
#include <vector>

namespace {
// A song stand-in: noise has energy across the whole band the speakers and microphones share.
std::vector<float> songNoise(std::size_t count, std::uint32_t seed) {
    std::mt19937 random(seed);
    std::normal_distribution<float> sample(0.0F, 0.2F);
    std::vector<float> out(count);
    for (auto& value : out)
        value = sample(random);
    return out;
}
} // namespace

namespace Tests {
void passiveLatencyFindsTheSongInTheMicrophoneUnderSinging() {
    constexpr double rate = 8'000.0, lead = 0.050, hidden = 0.036;
    const auto song = songNoise(16'000, 1);
    const auto singing = songNoise(16'000, 2);
    const auto lag = static_cast<std::size_t>(std::lround((lead + hidden) * rate));
    std::vector<float> microphone(song.size());
    // The speakers reach the microphone weakly; the singer is louder than the song there.
    for (std::size_t index = 0; index < microphone.size(); ++index)
        microphone[index] = (index >= lag ? 0.1F * song[index - lag] : 0.0F) + 0.3F * singing[index];
    const auto found = PassiveLatencyEstimator::locate(
        std::span<const float>{song.data(), 8'000}, microphone, lead, rate);
    expect(found.has_value() && std::abs(found->hiddenSeconds - hidden) < 0.0005,
           "the hidden delay is found from the song itself, even under a louder voice");
    const auto unrelated = songNoise(16'000, 3);
    expect(!PassiveLatencyEstimator::locate(std::span<const float>{song.data(), 8'000}, unrelated,
                                            lead, rate),
           "a microphone that does not hear the speakers (headphones) gives no estimate");
}

void passiveLatencyIsAcceptedFromRenderBlocksOnlyWhenWindowsAgree() {
    constexpr std::uint32_t rate = 48'000, channels = 2, block = 480;
    constexpr MonotonicTicks lead = 40'000'000, hidden = 30'000'000, blockNs = 10'000'000;
    constexpr auto delayFrames = static_cast<std::size_t>((lead + hidden) * rate / 1'000'000'000);
    const auto song = songNoise(static_cast<std::size_t>(rate) * 8, 4);
    PassiveLatencyEstimator estimator;
    estimator.prepare(rate);
    std::vector<float> speaker(block * channels), microphone(block * channels);
    for (std::size_t start = 0; start + block <= song.size(); start += block) {
        for (std::size_t frame = 0; frame < block; ++frame) {
            const auto index = start + frame;
            const auto heard = index >= delayFrames ? 0.1F * song[index - delayFrames] : 0.0F;
            for (std::uint32_t channel = 0; channel < channels; ++channel) {
                speaker[frame * channels + channel] = song[index];
                microphone[frame * channels + channel] = heard;
            }
        }
        const auto capturedAt = 1'000'000'000 + static_cast<MonotonicTicks>(start / block) * blockNs;
        estimator.observe(speaker, microphone, block, channels, capturedAt + lead, capturedAt);
        // The worker keeps up with real time; the test feeds faster, so every half second of
        // audio it lets the bounded queue drain.
        if ((start / block) % 50 == 49)
            std::this_thread::sleep_for(std::chrono::milliseconds(20));
    }
    for (int attempt = 0; attempt < 200 && estimator.snapshot().accepted == 0; ++attempt)
        std::this_thread::sleep_for(std::chrono::milliseconds(10));
    const auto state = estimator.snapshot();
    expect(state.accepted > 0 && std::llabs(state.hiddenLatencyNs - hidden) < 500'000,
           "agreeing windows of real render blocks yield the hidden delay");
}


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
