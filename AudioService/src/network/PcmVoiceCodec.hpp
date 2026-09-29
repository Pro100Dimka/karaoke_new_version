#pragma once

#include <algorithm>
#include <cmath>
#include <cstddef>
#include <cstdint>
#include <span>
#include <vector>

/**
 * Uncompressed 16-bit voice. It has no codec delay (Opus adds 2.5 ms) and no state, so a lost
 * packet is simply silence. Used only while the listeners report a clean stream; see
 * VoiceCodecPolicy. Runs on the send and receive threads, never on the realtime callback.
 */
namespace PcmVoiceCodec {
constexpr std::size_t BytesPerSample = 2;
constexpr float FullScale = 32767.0F;

[[nodiscard]] inline std::vector<std::byte> encode(std::span<const float> samples) {
    std::vector<std::byte> bytes(samples.size() * BytesPerSample);
    for (std::size_t index = 0; index < samples.size(); ++index) {
        const auto value = static_cast<std::int16_t>(
            std::lround(std::clamp(samples[index], -1.0F, 1.0F) * FullScale));
        const auto bits = static_cast<std::uint16_t>(value);
        bytes[index * BytesPerSample] = std::byte{static_cast<unsigned char>(bits & 0xFFU)};
        bytes[index * BytesPerSample + 1U] = std::byte{static_cast<unsigned char>(bits >> 8U)};
    }
    return bytes;
}

/** Decodes `samples` values; an empty result when the payload does not hold exactly that many. */
[[nodiscard]] inline std::vector<float> decode(std::span<const std::byte> payload,
                                               std::size_t samples) {
    if (payload.size() != samples * BytesPerSample)
        return {};
    std::vector<float> out(samples);
    for (std::size_t index = 0; index < samples; ++index) {
        const auto bits = static_cast<std::uint16_t>(
            std::to_integer<unsigned>(payload[index * BytesPerSample]) |
            (std::to_integer<unsigned>(payload[index * BytesPerSample + 1U]) << 8U));
        out[index] = static_cast<float>(static_cast<std::int16_t>(bits)) / FullScale;
    }
    return out;
}
} // namespace PcmVoiceCodec
