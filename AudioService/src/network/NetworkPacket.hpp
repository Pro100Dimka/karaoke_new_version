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
constexpr std::uint16_t AudioPacketVersion = 3;
constexpr std::size_t AudioPacketHeaderBytes = 44;
constexpr std::uint64_t SharedAudioTimelineFlag = std::uint64_t{1} << 63U;

[[nodiscard]] inline std::uint32_t deviceFramesForVoicePacket(
    std::uint64_t packetIndex, std::uint32_t deviceSampleRateHz) noexcept {
    constexpr std::uint32_t packetsPerSecond = 200U;
    const auto wholeFrames = deviceSampleRateHz / packetsPerSecond;
    const auto remainder = deviceSampleRateHz % packetsPerSecond;
    const auto previousExtra = packetIndex * remainder / packetsPerSecond;
    const auto nextExtra = (packetIndex + 1U) * remainder / packetsPerSecond;
    return wholeFrames + static_cast<std::uint32_t>(nextExtra - previousExtra);
}

struct AudioPacketHeader {
    std::uint32_t sequence{0};
    std::uint32_t participantKey{0};
    std::uint64_t sessionToken{0};
    std::uint64_t timestampFrame{0};
    std::uint16_t channels{0};
    std::uint16_t frames{0};
    std::uint32_t sharedTargetDelayFrames{0};
    std::uint32_t streamEpoch{0};
};

struct AudioTimelineAlignment {
    std::uint32_t silenceFrames{0};
    std::uint32_t skipFrames{0};
};

struct NetworkTimingSnapshot {
    float roundTripMs{0.0F};
    float interarrivalJitterMs{0.0F};
    float clockOffsetMs{0.0F};
    float clockDriftPpm{0.0F};
    std::uint32_t targetDelayFrames{0};
};

constexpr std::uint64_t MediaTimelineMask = SharedAudioTimelineFlag - 1U;
constexpr std::uint64_t MediaTimelineHalfRange = SharedAudioTimelineFlag >> 1U;

[[nodiscard]] inline std::uint64_t addMediaTimelineFrames(std::uint64_t frame,
                                                          std::uint64_t delta) noexcept {
    return ((frame & MediaTimelineMask) + delta) & MediaTimelineMask;
}

[[nodiscard]] inline std::uint64_t forwardMediaTimelineDistance(
    std::uint64_t fromFrame, std::uint64_t toFrame) noexcept {
    return ((toFrame & MediaTimelineMask) - (fromFrame & MediaTimelineMask)) &
           MediaTimelineMask;
}

[[nodiscard]] inline bool audioPacketBelongsToSession(
    const AudioPacketHeader& header, std::uint64_t expectedToken,
    std::uint32_t expectedChannels) noexcept {
    return header.sessionToken == expectedToken && header.participantKey != 0 &&
           header.channels == expectedChannels && header.frames != 0 &&
           header.frames <= 240;
}

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
    const auto playoutFrame = addMediaTimelineFrames(remoteTimestampFrame, commonTargetFrames);
    const auto forward = forwardMediaTimelineDistance(localTimestampFrame, playoutFrame);
    if (forward <= MediaTimelineHalfRange) {
        return {static_cast<std::uint32_t>(std::min<std::uint64_t>(
                    forward, UINT32_MAX)),
                0};
    }
    return {0, static_cast<std::uint32_t>(std::min<std::uint64_t>(
                   forwardMediaTimelineDistance(playoutFrame, localTimestampFrame), UINT32_MAX))};
}

[[nodiscard]] inline std::uint32_t sharedTimelineQueueTargetFrames(
    std::uint64_t remoteTimestampFrame, std::uint64_t localTimestampFrame,
    std::uint32_t commonTargetFrames) noexcept {
    const auto playoutFrame = addMediaTimelineFrames(remoteTimestampFrame, commonTargetFrames);
    const auto forward = forwardMediaTimelineDistance(localTimestampFrame, playoutFrame);
    return forward <= MediaTimelineHalfRange
               ? static_cast<std::uint32_t>(
                     std::min<std::uint64_t>(forward, UINT32_MAX))
               : 0U;
}

[[nodiscard]] inline std::uint32_t quantizeRoomDelayFrames(
    std::uint32_t candidateFrames, std::uint32_t maximumFrames,
    std::uint32_t packetFrames) noexcept {
    const auto quantum = std::max(1U, packetFrames * 4U);
    const auto rounded =
        (static_cast<std::uint64_t>(candidateFrames) + quantum - 1U) / quantum * quantum;
    return static_cast<std::uint32_t>(std::min<std::uint64_t>(rounded, maximumFrames));
}

[[nodiscard]] inline std::uint32_t sharedCompensationTargetFrames(
    std::uint32_t currentTargetFrames, std::uint32_t measuredCandidateFrames,
    bool timelineInitialized) noexcept {
    return timelineInitialized ? currentTargetFrames
                               : std::max(currentTargetFrames, measuredCandidateFrames);
}

[[nodiscard]] inline std::uint32_t adaptSharedCompensationFrames(
    std::uint32_t currentFrames, std::uint32_t measuredFrames,
    std::uint32_t minimumFrames, std::uint32_t maximumFrames,
    std::uint32_t packetFrames) noexcept {
    const auto current = std::clamp(currentFrames, minimumFrames, maximumFrames);
    const auto measured = std::clamp(measuredFrames, minimumFrames, maximumFrames);
    const auto hysteresis = std::max(1U, packetFrames / 2U);
    if (measured > current + hysteresis)
        return std::min(maximumFrames, current + std::min(packetFrames, measured - current));
    if (current > measured + packetFrames * 2U) {
        const auto release = std::max(1U, packetFrames / 8U);
        return std::max(minimumFrames, current - release);
    }
    return current;
}

[[nodiscard]] inline std::uint32_t maximumRoomCompensationFrames(
    std::uint32_t queueCapacityFrames, std::uint32_t packetFrames) noexcept {
    // Reserve one complete packet so the bounded queue can accept the next decode while the
    // remaining capacity is available to align unusually slow peers.
    return queueCapacityFrames > packetFrames ? queueCapacityFrames - packetFrames : 0U;
}

[[nodiscard]] inline std::uint32_t maximumInteractiveRoomDelayFrames(
    std::uint32_t queueCapacityFrames, std::uint32_t packetFrames,
    std::uint32_t sampleRateHz, std::uint32_t minimumFrames) noexcept {
    // Below this ceiling ordinary routes stay close to their measured target. Pathological
    // routes remain bounded instead of turning a recovered room into a permanent half-second echo.
    constexpr std::uint32_t MaximumInteractiveDelayMs = 450U;
    const auto interactiveLimit = sampleRateHz * MaximumInteractiveDelayMs / 1'000U;
    return std::max(minimumFrames,
                    std::min(maximumRoomCompensationFrames(queueCapacityFrames, packetFrames),
                             interactiveLimit));
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
        if (hasTransit_ && std::llabs(transit - previousTransitMicros_) > 50'000) {
            // A route switch or a large latency stage is not device clock drift. Start a fresh
            // regression window so the reported ppm converges again after the network stabilizes.
            firstSenderMicros_ = senderMicros;
            firstArrivalMicros_ = arrivalMicros;
            regressionSamples_ = 1;
            meanSenderElapsed_ = 0.0;
            meanArrivalElapsed_ = 0.0;
            senderVariance_ = 0.0;
            senderArrivalCovariance_ = 0.0;
            clockDriftPpm_ = 0.0F;
        }
        if (!hasClockReference_) {
            firstSenderMicros_ = senderMicros;
            firstArrivalMicros_ = arrivalMicros;
            minimumTransitMicros_ = transit;
            regressionSamples_ = 1;
            hasClockReference_ = true;
        } else {
            minimumTransitMicros_ = std::min(minimumTransitMicros_, transit);
            const auto senderElapsed = static_cast<double>(
                static_cast<std::int64_t>(senderMicros) -
                static_cast<std::int64_t>(firstSenderMicros_));
            const auto arrivalElapsed = static_cast<double>(
                static_cast<std::int64_t>(arrivalMicros) -
                static_cast<std::int64_t>(firstArrivalMicros_));
            ++regressionSamples_;
            const auto sampleCount = static_cast<double>(regressionSamples_);
            const auto senderDelta = senderElapsed - meanSenderElapsed_;
            meanSenderElapsed_ += senderDelta / sampleCount;
            const auto arrivalDelta = arrivalElapsed - meanArrivalElapsed_;
            meanArrivalElapsed_ += arrivalDelta / sampleCount;
            senderVariance_ += senderDelta * (senderElapsed - meanSenderElapsed_);
            senderArrivalCovariance_ +=
                senderDelta * (arrivalElapsed - meanArrivalElapsed_);
            // Short windows turn scheduler quantisation and one jitter spike into thousands of
            // fictitious ppm. Keep the metric neutral until five seconds of the current stable
            // route are available.
            if (senderElapsed >= 5'000'000.0 && senderVariance_ > 0.0) {
                const auto slope = senderArrivalCovariance_ / senderVariance_;
                clockDriftPpm_ = static_cast<float>(
                    std::clamp((slope - 1.0) * 1'000'000.0, -2'000.0, 2'000.0));
            }
        }
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
        const auto boundedMaximumFrames = std::max(minimumDelayFrames, maximumDelayFrames);
        return {roundTripMs_, jitterMs,
                hasClockReference_ ? static_cast<float>(minimumTransitMicros_) / 1000.0F : 0.0F,
                clockDriftPpm_,
                std::clamp(minimumDelayFrames + jitterFrames, minimumDelayFrames,
                           boundedMaximumFrames)};
    }

  private:
    float roundTripMs_{0.0F};
    float jitterMicros_{0.0F};
    std::int64_t previousTransitMicros_{0};
    bool hasTransit_{false};
    std::uint64_t firstSenderMicros_{0};
    std::uint64_t firstArrivalMicros_{0};
    std::int64_t minimumTransitMicros_{0};
    float clockDriftPpm_{0.0F};
    std::uint64_t regressionSamples_{0};
    double meanSenderElapsed_{0.0};
    double meanArrivalElapsed_{0.0};
    double senderVariance_{0.0};
    double senderArrivalCovariance_{0.0};
    bool hasClockReference_{false};
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
    // Converge within roughly one second after a route change/rejoin. Two frames per 5 ms packet
    // needed more than two seconds to remove a single 20 ms consensus step, leaving an audible
    // double voice in the post-reconnect evidence. The bounded ~3% retime remains gradual.
    const auto correction = std::max(1U, packetFrames / 32U);
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
    AudioPacketWire::write<std::uint32_t>(bytes, 36, header.sharedTargetDelayFrames);
    AudioPacketWire::write<std::uint32_t>(bytes, 40, header.streamEpoch);
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
    header.sharedTargetDelayFrames = AudioPacketWire::read<std::uint32_t>(bytes, 36);
    header.streamEpoch = AudioPacketWire::read<std::uint32_t>(bytes, 40);
    return true;
}
