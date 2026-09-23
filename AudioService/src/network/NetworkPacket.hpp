#pragma once

#include <algorithm>
#include <array>
#include <cmath>
#include <cstddef>
#include <cstdint>
#include <cstdlib>
#include <span>
#include <vector>

constexpr std::uint32_t AudioPacketMagic = 0x32445541U;
constexpr std::uint16_t AudioPacketVersion = 1;
constexpr std::size_t AudioPacketHeaderBytes = 36;
constexpr std::uint64_t SharedAudioTimelineFlag = std::uint64_t{1} << 63U;

struct AudioPacketHeader {
    std::uint32_t sequence{0};
    std::uint32_t participantKey{0};
    std::uint64_t sessionToken{0};
    std::uint64_t timestampFrame{0};
    std::uint16_t channels{0};
    std::uint16_t frames{0};
};

struct AudioTimelineAlignment {
    std::uint32_t silenceFrames{0};
    std::uint32_t skipFrames{0};
};

struct NetworkTimingSnapshot {
    float roundTripMs{0.0F};
    float interarrivalJitterMs{0.0F};
    std::uint32_t targetDelayFrames{0};
};

[[nodiscard]] inline std::uint32_t compensatedVoiceTargetFrames(
    std::uint64_t remoteTimestampFrame, std::uint64_t localTimestampFrame,
    std::uint32_t jitterHeadroomFrames, std::uint32_t minimumDelayFrames,
    std::uint32_t maximumDelayFrames) noexcept {
    const auto lateness = localTimestampFrame > remoteTimestampFrame
                              ? localTimestampFrame - remoteTimestampFrame
                              : 0ULL;
    const auto wanted = lateness + jitterHeadroomFrames;
    return static_cast<std::uint32_t>(std::clamp<std::uint64_t>(
        wanted, minimumDelayFrames, maximumDelayFrames));
}

[[nodiscard]] inline AudioTimelineAlignment alignSharedAudioTimeline(
    std::uint64_t remoteTimestampFrame, std::uint64_t localTimestampFrame,
    std::uint32_t commonTargetFrames) noexcept {
    const auto playoutFrame = remoteTimestampFrame + commonTargetFrames;
    if (playoutFrame >= localTimestampFrame) {
        return {static_cast<std::uint32_t>(std::min<std::uint64_t>(
                    playoutFrame - localTimestampFrame, UINT32_MAX)),
                0};
    }
    return {0, static_cast<std::uint32_t>(std::min<std::uint64_t>(
                   localTimestampFrame - playoutFrame, UINT32_MAX))};
}

[[nodiscard]] inline std::uint32_t additionalCompensationFrames(
    std::uint32_t previousTargetFrames, std::uint32_t nextTargetFrames) noexcept {
    return nextTargetFrames > previousTargetFrames ? nextTargetFrames - previousTargetFrames : 0U;
}

[[nodiscard]] inline std::uint32_t sharedCompensationTargetFrames(
    std::uint32_t currentTargetFrames, std::uint32_t measuredCandidateFrames,
    bool timelineInitialized) noexcept {
    return timelineInitialized ? currentTargetFrames
                               : std::max(currentTargetFrames, measuredCandidateFrames);
}

[[nodiscard]] inline std::uint32_t maximumRoomCompensationFrames(
    std::uint32_t sampleRateHz) noexcept {
    return sampleRateHz * 80U / 1000U;
}

class NetworkTimingEstimator {
  public:
    void reset() noexcept { *this = {}; }

    void noteRoundTrip(float milliseconds) noexcept {
        if (!(milliseconds > 0.0F))
            return;
        roundTripMs_ = roundTripMs_ == 0.0F ? milliseconds
                                            : roundTripMs_ + (milliseconds - roundTripMs_) * 0.125F;
    }

    void noteArrival(std::uint64_t senderFrame, std::uint64_t arrivalMicros,
                     std::uint32_t sampleRateHz) noexcept {
        if (sampleRateHz == 0)
            return;
        const auto senderMicros = senderFrame * 1'000'000ULL / sampleRateHz;
        const auto transit = static_cast<std::int64_t>(arrivalMicros) -
                             static_cast<std::int64_t>(senderMicros);
        if (hasTransit_) {
            const auto delta = std::llabs(transit - previousTransitMicros_);
            jitterMicros_ += (static_cast<float>(delta) - jitterMicros_) * 0.0625F;
        }
        previousTransitMicros_ = transit;
        hasTransit_ = true;
    }

    [[nodiscard]] NetworkTimingSnapshot snapshot(std::uint32_t minimumDelayFrames,
                                                   std::uint32_t maximumDelayFrames,
                                                   std::uint32_t sampleRateHz) const noexcept {
        const auto jitterMs = jitterMicros_ / 1000.0F;
        const auto jitterFrames = static_cast<std::uint32_t>(
            std::ceil(jitterMs * static_cast<float>(sampleRateHz) * 4.0F / 1000.0F));
        return {roundTripMs_, jitterMs,
                std::clamp(minimumDelayFrames + jitterFrames, minimumDelayFrames,
                           maximumDelayFrames)};
    }

  private:
    float roundTripMs_{0.0F};
    float jitterMicros_{0.0F};
    std::int64_t previousTransitMicros_{0};
    bool hasTransit_{false};
};

[[nodiscard]] inline std::vector<float>
retimeInterleavedLinear(std::span<const float> input, std::uint32_t channels,
                        std::uint32_t outputFrames) {
    if (channels == 0 || input.empty() || outputFrames == 0)
        return {};
    const auto inputFrames = static_cast<std::uint32_t>(input.size() / channels);
    if (inputFrames == 0)
        return {};
    std::vector<float> output(static_cast<std::size_t>(outputFrames) * channels);
    for (std::uint32_t frame = 0; frame < outputFrames; ++frame) {
        const auto position = outputFrames == 1 || inputFrames == 1
                                  ? 0.0F
                                  : static_cast<float>(frame) * (inputFrames - 1U) /
                                        static_cast<float>(outputFrames - 1U);
        const auto left = static_cast<std::uint32_t>(position);
        const auto right = std::min(left + 1U, inputFrames - 1U);
        const auto fraction = position - static_cast<float>(left);
        for (std::uint32_t channel = 0; channel < channels; ++channel) {
            const auto a = input[static_cast<std::size_t>(left) * channels + channel];
            const auto b = input[static_cast<std::size_t>(right) * channels + channel];
            output[static_cast<std::size_t>(frame) * channels + channel] =
                a + (b - a) * fraction;
        }
    }
    return output;
}

[[nodiscard]] inline AudioTimelineAlignment
stabilizeRemoteQueue(std::uint32_t fillFrames, std::uint32_t targetFrames,
                     std::uint32_t packetFrames) noexcept {
    const auto correction = std::max(1U, packetFrames / 100U);
    if (fillFrames + packetFrames < targetFrames)
        return {correction, 0};
    if (fillFrames > targetFrames + packetFrames * 2U)
        return {0, correction};
    return {};
}

[[nodiscard]] inline AudioTimelineAlignment
alignAudioPacketTimeline(std::uint64_t remoteTimestampFrame, std::uint64_t localTimestampFrame,
                         std::uint32_t playoutDelayFrames, std::uint32_t packetFrames) noexcept {
    // timestampFrame is relative to the sender's media process. Two computers do not share that
    // origin, so comparing their absolute frame counters creates arbitrary multi-second gaps or
    // discards. Sequence numbers preserve order; the receiver establishes its own bounded playout
    // point and keeps subsequent packets continuous from there.
    (void)remoteTimestampFrame;
    (void)localTimestampFrame;
    (void)packetFrames;
    return {playoutDelayFrames, 0};
}

namespace AudioPacketWire {
template <typename T>
inline void write(std::span<std::byte> bytes, std::size_t offset, T value) noexcept {
    for (std::size_t index = 0; index < sizeof(T); ++index)
        bytes[offset + index] = std::byte{static_cast<unsigned char>(value >> (index * 8U))};
}

template <typename T>
[[nodiscard]] inline T read(std::span<const std::byte> bytes, std::size_t offset) noexcept {
    T value{0};
    for (std::size_t index = 0; index < sizeof(T); ++index)
        value |= static_cast<T>(std::to_integer<unsigned char>(bytes[offset + index])) <<
                 (index * 8U);
    return value;
}
} // namespace AudioPacketWire

[[nodiscard]] inline std::array<std::byte, AudioPacketHeaderBytes>
encodeAudioPacketHeader(const AudioPacketHeader& header) noexcept {
    std::array<std::byte, AudioPacketHeaderBytes> bytes{};
    AudioPacketWire::write<std::uint32_t>(bytes, 0, AudioPacketMagic);
    AudioPacketWire::write<std::uint16_t>(bytes, 4, AudioPacketVersion);
    AudioPacketWire::write<std::uint16_t>(bytes, 6,
                                          static_cast<std::uint16_t>(AudioPacketHeaderBytes));
    AudioPacketWire::write<std::uint32_t>(bytes, 8, header.sequence);
    AudioPacketWire::write<std::uint32_t>(bytes, 12, header.participantKey);
    AudioPacketWire::write<std::uint64_t>(bytes, 16, header.sessionToken);
    AudioPacketWire::write<std::uint64_t>(bytes, 24, header.timestampFrame);
    AudioPacketWire::write<std::uint16_t>(bytes, 32, header.channels);
    AudioPacketWire::write<std::uint16_t>(bytes, 34, header.frames);
    return bytes;
}

[[nodiscard]] inline bool decodeAudioPacketHeader(std::span<const std::byte> bytes,
                                                  AudioPacketHeader& header) noexcept {
    if (bytes.size() < AudioPacketHeaderBytes ||
        AudioPacketWire::read<std::uint32_t>(bytes, 0) != AudioPacketMagic ||
        AudioPacketWire::read<std::uint16_t>(bytes, 4) != AudioPacketVersion ||
        AudioPacketWire::read<std::uint16_t>(bytes, 6) != AudioPacketHeaderBytes)
        return false;
    header.sequence = AudioPacketWire::read<std::uint32_t>(bytes, 8);
    header.participantKey = AudioPacketWire::read<std::uint32_t>(bytes, 12);
    header.sessionToken = AudioPacketWire::read<std::uint64_t>(bytes, 16);
    header.timestampFrame = AudioPacketWire::read<std::uint64_t>(bytes, 24);
    header.channels = AudioPacketWire::read<std::uint16_t>(bytes, 32);
    header.frames = AudioPacketWire::read<std::uint16_t>(bytes, 34);
    return true;
}
