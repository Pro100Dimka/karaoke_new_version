#include "network/Pcm16Codec.hpp"

#include <algorithm>
#include <cmath>
#include <cstring>

std::vector<std::byte> Pcm16Codec::encode(std::span<const float> samples) const {
    std::vector<std::byte> bytes(samples.size() * sizeof(std::int16_t));
    for (std::size_t index = 0; index < samples.size(); ++index) {
        const auto value = static_cast<std::int16_t>(
            std::lrint(std::clamp(samples[index], -1.0F, 1.0F) * 32767.0F));
        std::memcpy(bytes.data() + static_cast<std::ptrdiff_t>(index * 2U), &value, 2U);
    }
    return bytes;
}
std::vector<float> Pcm16Codec::decode(std::span<const std::byte> bytes) const {
    const auto count = bytes.size() / sizeof(std::int16_t);
    std::vector<float> samples(count);
    for (std::size_t index = 0; index < count; ++index) {
        std::int16_t value{};
        std::memcpy(&value, bytes.data() + static_cast<std::ptrdiff_t>(index * 2U), 2U);
        samples[index] = static_cast<float>(value) / 32768.0F;
    }
    return samples;
}
