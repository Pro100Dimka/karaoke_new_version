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

class PcmLossConcealer {
  public:
    void reset() noexcept {
        previous_.clear();
        concealedTail_.clear();
        recovering_ = false;
    }

    void remember(std::span<const float> samples, std::uint32_t channels) {
        if (channels == 0 || samples.size() < channels)
            return;
        previous_.assign(samples.end() - static_cast<std::ptrdiff_t>(
                                             std::min<std::size_t>(samples.size(), channels * 2U)),
                         samples.end());
    }

    [[nodiscard]] std::vector<float> conceal(std::uint32_t frames, std::uint32_t channels) {
        std::vector<float> output(static_cast<std::size_t>(frames) * channels, 0.0F);
        if (channels == 0 || frames == 0 || previous_.size() < channels)
            return output;
        concealedTail_.assign(channels, 0.0F);
        const auto hasSlope = previous_.size() >= channels * 2U;
        for (std::uint32_t frame = 0; frame < frames; ++frame) {
            const auto progress = static_cast<float>(frame + 1U) / static_cast<float>(frames);
            const auto fade = std::cos(progress * 1.57079632679F);
            for (std::uint32_t channel = 0; channel < channels; ++channel) {
                const auto last = previous_[previous_.size() - channels + channel];
                const auto before = hasSlope ? previous_[previous_.size() - channels * 2U + channel]
                                             : last;
                const auto slope = (last - before) * std::pow(0.98F, static_cast<float>(frame));
                const auto sample = std::clamp((last + slope * static_cast<float>(frame + 1U)) * fade,
                                               -1.0F, 1.0F);
                output[static_cast<std::size_t>(frame) * channels + channel] = sample;
                concealedTail_[channel] = sample;
            }
        }
        recovering_ = true;
        return output;
    }

    void smoothRecovery(std::span<float> samples, std::uint32_t channels) noexcept {
        if (!recovering_ || channels == 0 || concealedTail_.size() != channels)
            return;
        const auto frames = static_cast<std::uint32_t>(samples.size() / channels);
        const auto fadeFrames = std::min(16U, frames);
        for (std::uint32_t frame = 0; frame < fadeFrames; ++frame) {
            const auto mix = static_cast<float>(frame + 1U) / static_cast<float>(fadeFrames + 1U);
            for (std::uint32_t channel = 0; channel < channels; ++channel) {
                auto& sample = samples[static_cast<std::size_t>(frame) * channels + channel];
                sample = concealedTail_[channel] + (sample - concealedTail_[channel]) * mix;
            }
        }
        recovering_ = false;
    }

  private:
    std::vector<float> previous_;
    std::vector<float> concealedTail_;
    bool recovering_{false};
};
