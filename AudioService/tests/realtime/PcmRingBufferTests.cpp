#include "TestHarness.hpp"
#include "realtime/PcmRingBuffer.hpp"

#include <vector>

namespace Tests {
void pcmRingPreservesPcm() {
    PcmRingBuffer ring{8, 2};
    const std::vector<float> input{1, 2, 3, 4, 5, 6, 7, 8};
    std::vector<float> output(8);

    expect(ring.push(input, 4), "ring accepts bounded block");
    expect(ring.peek(output, 4) == 4 && ring.availableFrames() == 4, "peek does not consume");
    expect(ring.pop(output, 4) == 4 && output == input, "ring preserves PCM");
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
} // namespace Tests
