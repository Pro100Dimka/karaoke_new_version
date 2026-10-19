#pragma once

#include <algorithm>
#include <array>
#include <cmath>
#include <cstddef>
#include <cstdint>
#include <span>
#include <vector>

/**
 * Uncompressed 16-bit voice has no codec delay (Opus adds 2.5 ms) or decoder state; the receiver
 * conceals missing positions separately. Room audio uses PCM; other voice transport selects it
 * on clean routes through VoiceCodecPolicy. Runs on network workers, never on the render callback.
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

/**
 * One channel's continuity, owned by one thread. Jitter concealment requires a later packet's
 * metadata; the render owner also covers complete socket silence. Receive history commits only
 * admitted real PCM; render history contains samples taken from its queue. It adds no queue
 * or latency: a short waveform continuation is attenuated and ends after 100 ms; current PCM
 * replaces it with a one-packet crossfade at its original presentation position.
 */
class PcmPlayoutConcealer {
  public:
    [[nodiscard]] std::uint32_t missingFrames() const noexcept { return missingFrames_; }
    [[nodiscard]] std::uint32_t recoveryFrames() const noexcept { return recoveryFrames_; }
    void reset() noexcept {
        written_ = available_ = missingFrames_ = periodFrames_ = recoveryFrames_ = 0;
        lastOutput_ = recoveryFrom_ = 0.0F;
    }

    // Receive-side concealment commits only a real packet admitted to its output queue.
    void remember(std::span<const float> samples, std::uint32_t stride = 1) noexcept {
        if (stride == 0)
            return;
        missingFrames_ = recoveryFrames_ = 0;
        for (std::size_t frame = 0; frame < samples.size(); frame += stride)
            rememberSample(samples[frame]);
    }

    // RT-safe: fixed history, no allocation, locks, decoder calls or changes to queue position.
    void process(std::span<float> samples, std::uint32_t receivedFrames,
                 std::uint32_t sampleRateHz, std::uint32_t stride = 1) noexcept {
        if (sampleRateHz == 0 || stride == 0)
            return;
        const auto frames = (samples.size() + stride - 1U) / stride;
        const auto received = std::min<std::size_t>(receivedFrames, frames);
        const auto recoveryLength = std::max(1U, sampleRateHz / 400U); // one 2.5 ms voice packet
        if (received != 0 && missingFrames_ != 0) {
            recoveryFrames_ = recoveryLength;
            recoveryFrom_ = lastOutput_;
            missingFrames_ = 0;
        }
        for (std::size_t frame = 0; frame < received; ++frame) {
            auto& sample = samples[frame * stride];
            if (recoveryFrames_ != 0) {
                const auto mix = static_cast<float>(recoveryLength - recoveryFrames_ + 1U) /
                                 static_cast<float>(recoveryLength);
                sample = recoveryFrom_ + (sample - recoveryFrom_) * mix;
                --recoveryFrames_;
            }
            rememberSample(sample);
        }
        if (received == frames)
            return;
        if (missingFrames_ == 0) {
            periodFrames_ = selectPeriod(sampleRateHz);
            recoveryFrames_ = 0;
        }
        // A 20 ms continuation covers a short burst; the following 80 ms smooth fade is bounded
        // damage control for a longer outage, not recovery of the missing sung phonemes.
        const auto continuationFrames = std::max(1U, sampleRateHz / 50U);
        const auto limitFrames = std::max(continuationFrames + 1U, sampleRateHz / 10U);
        for (std::size_t frame = received; frame < frames; ++frame) {
            float sample = 0.0F;
            if (periodFrames_ != 0 && missingFrames_ < limitFrames) {
                sample = history_[(written_ - periodFrames_ + missingFrames_ % periodFrames_) %
                                  HistoryFrames];
                if (missingFrames_ >= continuationFrames) {
                    const auto progress = static_cast<float>(missingFrames_ - continuationFrames) /
                                          static_cast<float>(limitFrames - continuationFrames);
                    sample *= 1.0F - progress * progress * (3.0F - 2.0F * progress);
                }
            }
            samples[frame * stride] = lastOutput_ = sample;
            if (available_ != 0) {
                missingFrames_ = std::min(missingFrames_ + 1U, limitFrames);
            }
        }
    }

  private:
    void rememberSample(float sample) noexcept {
        lastOutput_ = sample;
        history_[written_++ % HistoryFrames] = sample;
        available_ = std::min(available_ + 1U, HistoryFrames);
    }

    [[nodiscard]] std::uint32_t selectPeriod(std::uint32_t sampleRateHz) const noexcept {
        constexpr std::uint32_t ComparisonFrames = 32;
        if (available_ <= ComparisonFrames)
            return available_;
        const auto minimum = std::max(1U, sampleRateHz / 500U);
        const auto maximum = std::min(available_ - ComparisonFrames, sampleRateHz / 50U);
        if (maximum < minimum)
            return available_;
        // Search only on the first missing sample. Strided lags keep the 32-sample comparison
        // bounded at high device rates; no pitch search or history mutation follows during loss.
        const auto stride = std::max(1U, sampleRateHz / 16'000U);
        auto period = minimum;
        auto bestError = 1.0e30F;
        for (auto lag = minimum; lag <= maximum; lag += stride) {
            float error = 0.0F, power = 1.0e-12F;
            for (std::uint32_t frame = 0; frame < ComparisonFrames; ++frame) {
                const auto recent = history_[(written_ - ComparisonFrames + frame) % HistoryFrames];
                const auto previous = history_[(written_ - ComparisonFrames - lag + frame) % HistoryFrames];
                const auto difference = recent - previous;
                error += difference * difference;
                power += recent * recent + previous * previous;
            }
            const auto normalizedError = error / power;
            if (normalizedError < bestError) {
                bestError = normalizedError;
                period = lag;
            }
        }
        return period;
    }

    static constexpr std::uint32_t HistoryFrames = 2'048;
    std::array<float, HistoryFrames> history_{};
    std::uint32_t written_{0}, available_{0}, missingFrames_{0}, periodFrames_{0}, recoveryFrames_{0};
    float lastOutput_{0.0F}, recoveryFrom_{0.0F};
};

// Receive-worker state. Returned PCM keeps the existing allocating API; the continuity history
// below is separate from the render owner's state and is never reseeded with synthesized loss.
class PcmLossConcealer {
  public:
    void reset() noexcept {
        previous_.clear();
        concealedTail_.clear();
        continuations_.clear();
        recovering_ = false;
    }

    void remember(std::span<const float> samples, std::uint32_t channels) {
        if (channels == 0 || samples.size() < channels)
            return;
        if (continuations_.size() != channels) {
            continuations_.clear();
            continuations_.resize(channels);
        }
        for (std::uint32_t channel = 0; channel < channels; ++channel)
            continuations_[channel].remember(samples.subspan(channel), channels);
        previous_.assign(samples.end() - static_cast<std::ptrdiff_t>(
                                             std::min<std::size_t>(samples.size(), channels * 2U)),
                         samples.end());
        recovering_ = false;
    }

    [[nodiscard]] std::vector<float> conceal(std::uint32_t frames, std::uint32_t channels) {
        std::vector<float> output(static_cast<std::size_t>(frames) * channels, 0.0F);
        if (channels == 0 || frames == 0 || previous_.size() < channels ||
            continuations_.size() != channels)
            return output;
        concealedTail_.assign(channels, 0.0F);
        const auto hasSlope = previous_.size() >= channels * 2U;
        for (std::uint32_t channel = 0; channel < channels; ++channel) {
            // Packet PCM is normalized to the voice transport's 48 kHz before decoding.
            continuations_[channel].process(std::span<float>{output}.subspan(channel), 0,
                                            48'000, channels);
            if (!recovering_) {
                const auto last = previous_[previous_.size() - channels + channel];
                const auto before = hasSlope ? previous_[previous_.size() - channels * 2U + channel]
                                             : last;
                const auto entryFrames = std::min(16U, frames);
                for (std::uint32_t frame = 0; frame < entryFrames; ++frame) {
                    const auto slope = (last - before) * std::pow(0.98F, static_cast<float>(frame));
                    const auto continued = std::clamp(last + slope * static_cast<float>(frame + 1U),
                                                       -1.0F, 1.0F);
                    const auto mix = static_cast<float>(frame + 1U) /
                                     static_cast<float>(entryFrames + 1U);
                    auto& sample = output[static_cast<std::size_t>(frame) * channels + channel];
                    sample = continued + (sample - continued) * mix;
                }
            }
            concealedTail_[channel] = output[static_cast<std::size_t>(frames - 1U) * channels + channel];
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
    }

  private:
    std::vector<float> previous_;
    std::vector<float> concealedTail_;
    std::vector<PcmPlayoutConcealer> continuations_; // receive-owned; resized only on format change
    bool recovering_{false};
};
