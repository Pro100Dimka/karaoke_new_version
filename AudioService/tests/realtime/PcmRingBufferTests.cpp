#include "TestHarness.hpp"
#include "realtime/PcmRingBuffer.hpp"
#include "realtime/RealtimeInstrumentation.hpp"

#include <chrono>
#include <array>
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

void pcmRingKeepsSourceTagsAlignedAcrossWrapAndReset() {
    PcmRingBuffer ring;
    ring.prepare(5, 1, true);
    const std::array first{1.0F, 2.0F, 3.0F}, wrapped{6.0F, 7.0F, 8.0F};
    const std::array second{4.0F, 5.0F};
    std::array<float, 4> output{};
    std::array<std::uint8_t, 4> tags{9, 9, 9, 9};
    expect(ring.push(first, 3, 0) && ring.push(second, 2, 1) && ring.pop(output, 4, tags) == 4 &&
               output == std::array{1.0F, 2.0F, 3.0F, 4.0F} &&
               tags == std::array<std::uint8_t, 4>{0, 0, 0, 1},
           "source tags and PCM are published and consumed at the same frame positions");
    expect(ring.push(wrapped, 3, 2) && ring.pop(output, 4, tags) == 4 &&
               output == std::array{5.0F, 6.0F, 7.0F, 8.0F} &&
               tags == std::array<std::uint8_t, 4>{1, 2, 2, 2},
           "tagged wrap retains the exact source of every copied PCM frame");
    expect(ring.push(first, 3, 0) && !ring.push(wrapped, 3, 2),
           "tagged overflow rejects PCM and its tags together");
    ring.clear();
    expect(ring.push(second, 2, 1) && ring.pop(output, 4, tags) == 2 &&
               output[0] == 4.0F && output[1] == 5.0F && tags[0] == 1 && tags[1] == 1,
           "queue reset cannot leak earlier concealment tags into new PCM");
}

void pcmRingSourceTagsFollowPartialMultichannelOperations() {
    enum class Operation { Push, Pop, Discard, Clear, Prepare };
    struct Step {
        Operation operation;
        std::uint32_t frames;
        std::uint32_t firstFrame;
        std::uint8_t tag;
        std::uint32_t result;
        std::uint32_t remaining;
        const char* message;
        std::uint32_t sampleFrames = 12;
        std::uint32_t tagFrames = 12;
    };
    constexpr std::array steps{
        Step{Operation::Push, 4, 0, 0, 1, 4, "initial concealed frames are accepted"},
        Step{Operation::Pop, 2, 0, 0, 2, 2, "partial pop consumes one tag per frame"},
        Step{Operation::Push, 5, 4, 1, 1, 7, "real frames wrap behind the concealed remainder"},
        Step{Operation::Push, 1, 9, 2, 0, 7, "full queue rejects PCM and tags atomically"},
        Step{Operation::Pop, 3, 2, 0, 3, 4, "partial pop crosses the concealed to real boundary"},
        Step{Operation::Discard, 1, 0, 0, 1, 3, "discard advances PCM and tags together"},
        Step{Operation::Push, 2, 9, 2, 1, 5, "another source wraps after discard"},
        Step{Operation::Pop, 3, 0, 0, 0, 5, "short PCM output rejects the entire pop", 2},
        Step{Operation::Pop, 3, 0, 0, 0, 5, "short tag output rejects the entire pop", 12, 2},
        Step{Operation::Push, 2, 9, 2, 0, 5, "short PCM input cannot publish tags alone", 1},
        Step{Operation::Pop, 6, 6, 0, 5, 0, "underfill copies only the available PCM and tags"},
        Step{Operation::Push, 3, 0, 0, 1, 3, "old concealed frames precede clear"},
        Step{Operation::Clear, 0, 0, 0, 0, 0, "clear removes all old frames"},
        Step{Operation::Push, 2, 9, 2, 1, 2, "fresh frames are accepted after clear"},
        Step{Operation::Pop, 4, 9, 0, 2, 0, "clear cannot leak earlier PCM or tags"},
        Step{Operation::Push, 2, 0, 0, 1, 2, "old concealed frames precede prepare"},
        Step{Operation::Prepare, 0, 0, 0, 0, 0, "prepare resets the tagged queue"},
        Step{Operation::Push, 2, 4, 1, 1, 2, "real frames are accepted after prepare"},
        Step{Operation::Pop, 4, 4, 0, 2, 0, "prepare cannot leak earlier PCM or tags"},
    };
    for (const auto channels : {1U, 2U, 6U}) {
        PcmRingBuffer ring;
        ring.prepare(7, channels, true);
        std::vector<float> input(24U * channels), output(12U * channels);
        std::array<std::uint8_t, 12> tags{};
        for (std::size_t sample = 0; sample < input.size(); ++sample)
            input[sample] = static_cast<float>(sample + 1U);
        for (const auto& step : steps) {
            std::fill(output.begin(), output.end(), -1.0F);
            tags.fill(9);
            std::uint32_t result = 0;
            switch (step.operation) {
            case Operation::Push:
                result = ring.push(std::span{input}.subspan(step.firstFrame * channels,
                                                           step.sampleFrames * channels),
                                   step.frames, step.tag);
                break;
            case Operation::Pop:
                result = ring.pop(std::span{output}.first(step.sampleFrames * channels),
                                  step.frames, std::span{tags}.first(step.tagFrames));
                break;
            case Operation::Discard:
                result = ring.discard(step.frames);
                break;
            case Operation::Clear:
                ring.clear();
                break;
            case Operation::Prepare:
                ring.prepare(7, channels, true);
                break;
            }
            bool aligned = result == step.result && ring.availableFrames() == step.remaining &&
                           ring.freeFrames() == ring.capacityFrames() - step.remaining;
            if (step.operation == Operation::Pop) {
                for (std::uint32_t frame = 0; frame < tags.size(); ++frame) {
                    const auto sourceFrame = step.firstFrame + frame;
                    const auto expectedTag = sourceFrame < 4U ? 0U : sourceFrame < 9U ? 1U : 2U;
                    aligned = aligned && tags[frame] == (frame < result ? expectedTag : 9U);
                    for (std::uint32_t channel = 0; channel < channels; ++channel) {
                        const auto sample = frame * channels + channel;
                        aligned = aligned && output[sample] ==
                            (frame < result ? input[sourceFrame * channels + channel] : -1.0F);
                    }
                }
            }
            expect(aligned, step.message);
        }
    }
}

void pcmRingSourceTagsPublishWithPcmAcrossThreads() {
    constexpr std::uint32_t Channels = 3, PacketFrames = 7, PacketCount = 10'000;
    constexpr auto TotalFrames = PacketFrames * PacketCount;
    PcmRingBuffer ring;
    ring.prepare(17, Channels, true);
    std::atomic<bool> valid{true}, writerFinished{false};
    std::atomic<std::uint32_t> consumedFrames{0};
    RealtimeInstrumentation::reset();
    std::thread producer([&] {
        std::array<float, PacketFrames * Channels> samples{};
        for (std::uint32_t packet = 0; packet < PacketCount && valid.load(); ++packet) {
            for (std::uint32_t sample = 0; sample < samples.size(); ++sample)
                samples[sample] = static_cast<float>(packet * samples.size() + sample + 1U);
            bool pushed = false;
            while (!pushed && valid.load()) {
                {
                    RealtimeScope realtime;
                    pushed = ring.push(samples, PacketFrames, static_cast<std::uint8_t>(packet % 3U));
                }
                if (!pushed)
                    std::this_thread::yield();
            }
        }
        writerFinished.store(true, std::memory_order_release);
    });
    std::thread consumer([&] {
        std::array<float, 9U * Channels> samples{};
        std::array<std::uint8_t, 9> tags{};
        std::uint32_t consumed = 0;
        while (consumed < TotalFrames && valid.load()) {
            std::uint32_t read = 0;
            {
                RealtimeScope realtime;
                read = ring.pop(samples, 1U + consumed % 9U, tags);
            }
            if (read == 0) {
                if (writerFinished.load(std::memory_order_acquire) && ring.availableFrames() == 0)
                    break;
                std::this_thread::yield();
                continue;
            }
            bool aligned = true;
            for (std::uint32_t frame = 0; frame < read; ++frame) {
                const auto sourceFrame = consumed + frame;
                aligned = aligned && tags[frame] == sourceFrame / PacketFrames % 3U;
                for (std::uint32_t channel = 0; channel < Channels; ++channel)
                    aligned = aligned && samples[frame * Channels + channel] ==
                        static_cast<float>(sourceFrame * Channels + channel + 1U);
            }
            valid.store(aligned);
            consumed += read;
        }
        consumedFrames.store(consumed);
    });
    producer.join();
    consumer.join();
    const auto violations = RealtimeInstrumentation::snapshot();
    expect(valid.load() && consumedFrames.load() == TotalFrames && ring.availableFrames() == 0,
           "partial SPSC reads observe matching PCM and frame tags through every wrap");
    expect(violations.allocations == 0 && violations.deallocations == 0 &&
               violations.blockingCalls == 0,
           "publishing and consuming frame provenance adds no realtime allocation or wait");
}

void pcmRingTransfersIdentifyExactQueueSpans() {
    enum class Operation { Push, Pop, Discard, Clear, Prepare };
    struct Step {
        Operation operation;
        std::uint32_t frames, result, remaining;
        std::uint64_t firstFrame;
        const char* message;
        std::uint64_t epochOffset = 0;
        bool valid = true;
        std::uint32_t sampleFrames = 5;
        std::uint32_t tagFrames = 5;
    };
    constexpr std::array steps{
        Step{Operation::Push, 4, 1, 4, 0, "first admission reports its absolute write span"},
        Step{Operation::Pop, 2, 2, 2, 0, "partial render reports only the consumed prefix"},
        Step{Operation::Push, 3, 1, 5, 4, "wrapped admission retains the absolute cursor"},
        Step{Operation::Push, 1, 0, 5, 0, "overflow cannot report an admitted span", 0, false},
        Step{Operation::Pop, 3, 3, 2, 2, "cross-wrap render joins two admitted spans"},
        Step{Operation::Discard, 1, 1, 1, 0, "discard advances the next reported read cursor"},
        Step{Operation::Pop, 4, 1, 0, 6, "underfill reports its exact remaining frame"},
        Step{Operation::Pop, 4, 0, 0, 7, "starvation retains a valid empty read cursor"},
        Step{Operation::Push, 3, 1, 3, 7, "admission resumes without resetting its cursor"},
        Step{Operation::Clear, 0, 0, 0, 0, "clear drains the current epoch", 1},
        Step{Operation::Pop, 4, 0, 0, 10, "clear changes epoch but retains the write cursor", 1},
        Step{Operation::Push, 2, 1, 2, 10, "post-clear admission belongs to the new epoch", 1},
        Step{Operation::Pop, 2, 0, 2, 0, "short tag output has no render span", 1, false, 5, 1},
        Step{Operation::Pop, 2, 0, 2, 0, "short PCM output has no render span", 1, false, 1},
        Step{Operation::Push, 2, 0, 2, 0, "short PCM input has no admission span", 1, false, 1},
        Step{Operation::Pop, 2, 2, 0, 10, "rejected calls leave the next real read unchanged", 1},
        Step{Operation::Prepare, 0, 0, 0, 0, "prepare replaces storage and epoch", 2},
        Step{Operation::Pop, 4, 0, 0, 0, "prepared storage starts at a new empty origin", 2},
        Step{Operation::Push, 2, 1, 2, 0, "prepared admission starts at frame zero", 2},
        Step{Operation::Pop, 2, 2, 0, 0, "prepared render joins only the new epoch", 2},
        Step{Operation::Push, 0, 1, 0, 2, "zero-frame admission cannot advance the cursor", 2},
        Step{Operation::Pop, 0, 0, 0, 2, "zero-frame read cannot advance the cursor", 2},
    };
    PcmRingBuffer ring;
    ring.prepare(5, 1, true);
    const auto initialEpoch = ring.epoch();
    const std::array input{1.0F, 2.0F, 3.0F, 4.0F, 5.0F};
    std::array<float, 5> output{};
    std::array<std::uint8_t, 5> tags{};
    for (const auto& step : steps) {
        PcmRingBuffer::Transfer transfer{999, 999, 999, true};
        std::uint32_t result = 0;
        switch (step.operation) {
        case Operation::Push:
            result = ring.push(std::span{input}.first(step.sampleFrames), step.frames, 1, &transfer);
            break;
        case Operation::Pop:
            result = ring.pop(std::span{output}.first(step.sampleFrames), step.frames,
                              std::span{tags}.first(step.tagFrames), &transfer);
            break;
        case Operation::Discard:
            result = ring.discard(step.frames);
            break;
        case Operation::Clear:
            ring.clear();
            break;
        case Operation::Prepare:
            ring.prepare(5, 1, true);
            break;
        }
        bool exact = result == step.result && ring.availableFrames() == step.remaining;
        if (step.operation == Operation::Push || step.operation == Operation::Pop) {
            const auto transferred = step.operation == Operation::Push ? step.frames : step.result;
            exact = exact && transfer.valid == step.valid &&
                    transfer.epoch == (step.valid ? initialEpoch + step.epochOffset : 0) &&
                    transfer.firstFrame == (step.valid ? step.firstFrame : 0) &&
                    transfer.frames == (step.valid ? transferred : 0);
        }
        expect(exact, step.message);
    }
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
