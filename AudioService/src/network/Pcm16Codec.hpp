#pragma once

#include <cstddef>
#include <cstdint>
#include <span>
#include <vector>

class Pcm16Codec {
  public:
    [[nodiscard]] std::vector<std::byte> encode(std::span<const float> samples) const;
    [[nodiscard]] std::vector<float> decode(std::span<const std::byte> bytes) const;
};
