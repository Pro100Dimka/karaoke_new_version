#pragma once
#include "common/Types.hpp"
#include <cstdint>
#include <span>

struct AudioBlock {
    SequenceNumber sequence{0};
    GenerationId generationId{0};
    SessionFrame sessionFrame{0};
    std::uint32_t frameCount{0};
    std::uint32_t sampleRateHz{0};
    std::uint32_t channelCount{0};
    std::int64_t devicePosition{0};
    MonotonicTicks timestamp{0};
    std::uint32_t flags{0};
    std::span<float> samples{};
};
