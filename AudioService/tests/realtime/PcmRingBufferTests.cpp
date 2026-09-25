#include "TestHarness.hpp"
#include "realtime/PcmRingBuffer.hpp"
#include "realtime/RealtimeInstrumentation.hpp"

#include <chrono>
#include <thread>
#include <vector>

namespace Tests {
void pcmRingPreservesPcm() {
    PcmRingBuffer ring{8, 2};
    const std::vector<float> input{1, 2, 3, 4, 5, 6, 7, 8};
    std::vector<float> output(8);

    expect(ring.push(input, 4), "ring accepts bounded block");
    expect(ring.peek(output, 4) == 4 && ring.availableFrames() == 4, "peek does not consume");
    expect(ring.pop(output, 4) == 4 && output == input, "ring preserves PCM");

    for (const auto channels : {1U, 3U, 8U}) {
        PcmRingBuffer wrapped{7, channels};
        std::vector<float> samples(5 * channels), received(samples.size());
        for (std::uint32_t block = 0; block < 20; ++block) {
            for (std::size_t index = 0; index < samples.size(); ++index)
                samples[index] = static_cast<float>(index + block * samples.size());
            expect(wrapped.push(samples, 5) && wrapped.pop(received, 5) == 5 && received == samples,
                   "ring wrap preserves every interleaved channel across non-power-of-two bounds");
        }
    }
}

void pcmRingRejectsOverflow() {
    PcmRingBuffer ring{8, 2};
    expect(!ring.push(std::vector<float>(18), 9), "ring rejects overflow");
}

void generationRingRejectsStalePcm() {
    GenerationPcmRingBuffer ring;
    ring.prepare(8, 1);
    ring.reset(SourceGenerationId{7});
    const std::vector<float> mono{1, 2};

    expect(!ring.push(SourceGenerationId{6}, mono, 2), "previous generation PCM rejected");
    expect(ring.push(SourceGenerationId{7}, mono, 2), "current generation PCM accepted");
    ring.reset(SourceGenerationId{8});
    std::vector<float> discarded(2);
    expect(ring.pop(discarded, 2) == 0, "generation reset removes stale PCM");
}

void pcmClearDrainsInFlightConsumer() {
    constexpr std::uint32_t frames = 4U * 1024U * 1024U;
    PcmRingBuffer ring{frames, 1};
    const std::vector<float> oldPcm(frames, 1.0F);
    std::vector<float> output(frames);
    const std::vector<float> freshPcm{2.0F, 3.0F};
    for (int attempt = 0; attempt < 4; ++attempt) {
        ring.clear();
        expect(ring.push(oldPcm, frames), "old generation fills the queue");
        std::atomic<bool> started{false};
        std::thread consumer([&] {
            started.store(true, std::memory_order_release);
            (void)ring.pop(output, frames);
        });
        while (!started.load(std::memory_order_acquire))
            std::this_thread::yield();
        std::this_thread::sleep_for(std::chrono::microseconds(100));
        ring.clear();
        const auto pushed = ring.push(freshPcm, 2);
        consumer.join();
        expect(pushed && ring.availableFrames() == 2,
               "old consumer must not copy overwritten PCM or discard post-clear frames");
        expect(ring.pop(output, 2) == 2 && output[0] == 2.0F && output[1] == 3.0F,
               "fresh PCM survives completion of the old consumer");
    }
}

void generationResetDrainsInFlightProducer() {
    constexpr std::uint32_t frames = 4U * 1024U * 1024U;
    GenerationPcmRingBuffer ring;
    ring.prepare(frames, 1);
    ring.reset(SourceGenerationId{1});
    const std::vector<float> oldPcm(frames, 1.0F);
    const std::vector<float> freshPcm{2.0F, 3.0F};
    std::vector<float> output(2);
    std::atomic<bool> started{false};
    std::thread producer([&] {
        started.store(true, std::memory_order_release);
        (void)ring.push(SourceGenerationId{1}, oldPcm, frames);
    });
    while (!started.load(std::memory_order_acquire))
        std::this_thread::yield();
    std::this_thread::sleep_for(std::chrono::microseconds(100));
    ring.reset(SourceGenerationId{2});
    producer.join();
    expect(ring.availableFrames() == 0, "reset drains and removes an old producer's publication");
    RealtimeInstrumentation::reset();
    bool accepted = false;
    std::uint32_t received = 0;
    {
        RealtimeScope realtime;
        accepted = ring.push(SourceGenerationId{2}, freshPcm, 2);
        received = ring.pop(output, 2);
    }
    expect(accepted && received == 2 && output == freshPcm, "new generation remains usable");
    const auto violations = RealtimeInstrumentation::snapshot();
    expect(violations.allocations == 0 && violations.deallocations == 0 &&
               violations.blockingCalls == 0,
           "PCM callbacks neither allocate nor wait for a reset");
}
} // namespace Tests
