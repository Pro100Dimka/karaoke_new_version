#pragma once

#include <algorithm>
#include <array>
#include <cmath>
#include <cstddef>
#include <cstdint>
#include <cstdlib>
#include <optional>
#include <span>
#include <vector>

constexpr std::uint32_t AudioPacketMagic = 0x32445541U;
constexpr std::uint16_t AudioPacketVersion = 3;
constexpr std::size_t AudioPacketHeaderBytes = 44;
constexpr std::uint64_t SharedAudioTimelineFlag = std::uint64_t{1} << 63U;

[[nodiscard]] inline std::uint64_t scaleFramePosition(std::uint64_t frames,
    std::uint32_t sourceRateHz, std::uint32_t targetRateHz) noexcept {
    if (sourceRateHz == 0 || sourceRateHz == targetRateHz) return frames;
    if (targetRateHz == 0) return 0;
    const auto whole = frames / sourceRateHz;
    if (whole > UINT64_MAX / targetRateHz) return UINT64_MAX;
    const auto remainder = ((frames % sourceRateHz) * targetRateHz + sourceRateHz / 2U) / sourceRateHz;
    const auto scaled = whole * targetRateHz;
    return scaled + std::min(remainder, UINT64_MAX - scaled);
}

class RecentAudioSequenceWindow {
  public:
    static constexpr std::size_t Capacity = 2048;

    RecentAudioSequenceWindow() noexcept { reset(); }
    void reset() noexcept { sequences_.fill(UINT32_MAX); }
    [[nodiscard]] bool isDuplicate(std::uint32_t sequence) noexcept {
        auto& stored = sequences_[static_cast<std::size_t>(sequence) % Capacity];
        if (stored == sequence)
            return true;
        stored = sequence;
        return false;
    }

  private:
    std::array<std::uint32_t, Capacity> sequences_{};
};

/**
 * Voice packets per second: 2.5 ms of audio each. A packet waits until it is full and the room
 * keeps one packet of guard, so the packet length is paid twice in every voice path.
 */
constexpr std::uint32_t VoicePacketsPerSecond = 400U;

[[nodiscard]] inline std::uint32_t deviceFramesForVoicePacket(
    std::uint64_t packetIndex, std::uint32_t deviceSampleRateHz) noexcept {
    constexpr std::uint32_t packetsPerSecond = VoicePacketsPerSecond;
    const auto wholeFrames = deviceSampleRateHz / packetsPerSecond;
    const auto remainder = deviceSampleRateHz % packetsPerSecond;
    const auto previousExtra = packetIndex * remainder / packetsPerSecond;
    const auto nextExtra = (packetIndex + 1U) * remainder / packetsPerSecond;
    return wholeFrames + static_cast<std::uint32_t>(nextExtra - previousExtra);
}

/** How a voice payload is coded. PCM saves the Opus delay; VoiceCodecPolicy picks it. */
enum class VoiceCodec : std::uint8_t { Opus = 0, Pcm16 = 1 };

struct AudioPacketHeader {
    std::uint32_t sequence{0};
    std::uint32_t participantKey{0};
    std::uint64_t sessionToken{0};
    std::uint64_t timestampFrame{0};
    std::uint16_t channels{0};
    std::uint16_t frames{0};
    // Receiver report carried by every packet, one listened-to participant at a time: how many of
    // that participant's packets this sender lost or received too late, per thousand. On the wire
    // it shares one word: the key's low 24 bits and the loss saturated at 255.
    std::uint32_t reportedParticipantKey{0};
    std::uint32_t streamEpoch{0};
    VoiceCodec codec{VoiceCodec::Opus};
    std::uint16_t reportedLossPermille{0};
};

/**
 * The version-3 wire layout is kept so the deployed relay (which checks the version and header
 * size) and older clients still carry and read these packets: the codec sits in the high byte of
 * the channel count, the report in the word older clients wrote and never read.
 */
constexpr std::uint32_t ReportKeyMask = 0x00FF'FFFFU;
constexpr std::uint32_t MaximumReportedLossPermille = 255U;

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
           header.frames <= 240 &&
           (header.codec == VoiceCodec::Opus || header.codec == VoiceCodec::Pcm16);
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

/** Signed distance "later - earlier" on the wrapped media timeline, in frames. */
[[nodiscard]] inline std::int64_t signedMediaTimelineDistance(std::uint64_t earlierFrame,
                                                              std::uint64_t laterFrame) noexcept {
    const auto forward = forwardMediaTimelineDistance(earlierFrame, laterFrame);
    return forward <= MediaTimelineHalfRange
               ? static_cast<std::int64_t>(forward)
               : -static_cast<std::int64_t>(forwardMediaTimelineDistance(laterFrame, earlierFrame));
}

/**
 * How late a remote voice reaches this receiver: its capture frame on the shared room timeline
 * against the receiver's presentation frame when the packet arrives. With synchronized room clocks
 * this covers the singer's capture path, the network and the listener's output path in one number,
 * so no separate estimate (such as half of a relay round trip) is needed. The peak decays slowly:
 * a spike widens the target for a while instead of forever.
 */
class VoiceLatenessTracker {
  public:
    void reset() noexcept { *this = {}; }

    void note(std::int64_t latenessFrames, double decayFramesPerNote) noexcept {
        const auto sample = static_cast<double>(std::max<std::int64_t>(0, latenessFrames));
        peakFrames_ = hasSample_ ? std::max(sample, peakFrames_ - decayFramesPerNote) : sample;
        latestFrames_ = latenessFrames;
        hasSample_ = true;
    }

    [[nodiscard]] bool hasSample() const noexcept { return hasSample_; }
    [[nodiscard]] std::uint32_t peakFrames() const noexcept {
        return static_cast<std::uint32_t>(std::ceil(std::max(0.0, peakFrames_)));
    }
    [[nodiscard]] std::int64_t latestFrames() const noexcept { return latestFrames_; }

  private:
    double peakFrames_{0.0};
    std::int64_t latestFrames_{0};
    bool hasSample_{false};
};

/**
 * Guard above the measured lateness peak. The peak is already taken against the next sample a
 * render will take, so the guard only covers decoding and the arrival/render race.
 */
constexpr std::uint32_t RoomPlayoutGuardMicros = 1'000U;

/**
 * Playout delay a receiver needs for one sender: the arrival lateness peak (measured against the
 * next sample a render will take) plus the guard.
 */
[[nodiscard]] inline std::uint32_t roomPlayoutTargetFrames(std::uint32_t latenessPeakFrames,
                                                           std::uint32_t guardFrames,
                                                           std::uint32_t minimumFrames,
                                                           std::uint32_t maximumFrames) noexcept {
    return static_cast<std::uint32_t>(std::clamp<std::uint64_t>(
        static_cast<std::uint64_t>(latenessPeakFrames) + guardFrames,
        minimumFrames, std::max(minimumFrames, maximumFrames)));
}

[[nodiscard]] inline std::uint32_t sharedCompensationTargetFrames(
    std::uint32_t currentTargetFrames, std::uint32_t measuredCandidateFrames,
    bool timelineInitialized) noexcept {
    return timelineInitialized ? currentTargetFrames
                               : std::max(currentTargetFrames, measuredCandidateFrames);
}

/**
 * One step of the room delay towards the measured need. It never stays below the need (that
 * would starve the voice queue), rises by at most one packet per packet so voices already
 * playing stretch instead of jumping, and releases slowly once it is more than half a packet
 * above the need, so jitter inside that band does not keep retiming the queue.
 */
[[nodiscard]] inline std::uint32_t adaptSharedCompensationFrames(
    std::uint32_t currentFrames, std::uint32_t measuredFrames,
    std::uint32_t minimumFrames, std::uint32_t maximumFrames,
    std::uint32_t packetFrames) noexcept {
    const auto current = std::clamp(currentFrames, minimumFrames, maximumFrames);
    const auto measured = std::clamp(measuredFrames, minimumFrames, maximumFrames);
    if (measured > current)
        return std::min(maximumFrames, current + std::min(packetFrames, measured - current));
    if (current > measured + std::max(1U, packetFrames / 2U)) {
        const auto release = std::max(1U, packetFrames / 8U);
        return std::max(minimumFrames, current - release);
    }
    return current;
}

/**
 * Singers hear each other closely enough to sing symmetrically while the leader's voice delay stays
 * at or below this; above it a follower shifts its song onto the leader instead.
 */
constexpr std::uint32_t DefaultRoomFollowMinimumMs = 30U;

/** Follow decision with a one-sixth release band, so a delay near the limit does not flap. */
[[nodiscard]] inline bool roomFollowEngaged(bool engaged, std::uint32_t leaderDelayFrames,
                                            std::uint32_t engageFrames) noexcept {
    const auto releaseFrames = engageFrames - engageFrames / 6U;
    return leaderDelayFrames > (engaged ? releaseFrames : engageFrames);
}

struct RoomFollowState {
    bool engaged{false};
    std::uint32_t packetsAbove{0};
};

/**
 * One packet of the follow decision: a follower engages only after the leader's delay has stayed
 * above the limit for `sustainPackets`, so a single network spike never flips the room's mode.
 */
[[nodiscard]] inline RoomFollowState stepRoomFollow(RoomFollowState state,
                                                    std::uint32_t leaderDelayFrames,
                                                    std::uint32_t engageFrames,
                                                    std::uint32_t sustainPackets) noexcept {
    if (!roomFollowEngaged(state.engaged, leaderDelayFrames, engageFrames))
        return {};
    if (state.engaged)
        return state;
    const auto packetsAbove = state.packetsAbove + 1U;
    return {packetsAbove >= sustainPackets, packetsAbove};
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
    // A room follower adds its own delay to what the others measure, hence the headroom.
    constexpr std::uint32_t MaximumInteractiveDelayMs = 160U;
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
        const auto senderMicros = scaleFramePosition(senderFrame, sampleRateHz, 1'000'000);
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
        // RFC-style jitter is already an EWMA of inter-arrival variation. One jitter width plus
        // the two-packet floor retains headroom without counting ordinary scheduler variation
        // twice in the live vocal path.
        const auto jitterFrames = static_cast<std::uint32_t>(
            std::ceil(jitterMs * static_cast<float>(sampleRateHz) / 1000.0F));
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

/**
 * On the shared room timeline the queue error is exact: fill and target are measured against the
 * same presentation frame, so arrival jitter cancels. The voice is therefore held within a fraction
 * of a packet of its room position instead of the jitter-sized band above, which let it settle up
 * to two packets late.
 */
[[nodiscard]] inline AudioTimelineAlignment
stabilizeSharedTimelineQueue(std::uint32_t fillFrames, std::uint32_t targetFrames,
                             std::uint32_t packetFrames) noexcept {
    const auto correction = std::max(1U, packetFrames / 32U);
    const auto tolerance = packetFrames / 8U;
    if (fillFrames + tolerance < targetFrames)
        return {correction, 0};
    if (fillFrames > targetFrames + tolerance)
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

/**
 * Chooses how the local voice travels. Uncompressed PCM saves the Opus codec delay but needs about
 * a megabit per listener, so it is used only after every listener has reported an almost clean
 * stream for a while. A lossy report sends the voice back to Opus, for twice as long each time,
 * so a connection that cannot carry PCM settles on Opus instead of flapping.
 */
class VoiceCodecPolicy {
  public:
    static constexpr std::uint32_t CleanLossPermille = 5;
    static constexpr std::uint32_t LossyLossPermille = 20;
    static constexpr std::uint64_t CleanSpanMicros = 3'000'000;
    static constexpr std::uint64_t FirstBackoffMicros = 30'000'000;
    static constexpr std::uint64_t MaximumBackoffMicros = 600'000'000;

    void reset() noexcept { *this = {}; }

    /** worstLossPermille: the worst current listener report; nullopt while any listener has none. */
    [[nodiscard]] VoiceCodec step(std::optional<std::uint32_t> worstLossPermille,
                                  std::uint64_t nowMicros) noexcept {
        if (!worstLossPermille) {
            cleanRunning_ = false;
            codec_ = VoiceCodec::Opus; // no evidence either way: the safe codec, without a penalty
            return codec_;
        }
        if (codec_ == VoiceCodec::Pcm16) {
            if (*worstLossPermille >= LossyLossPermille) {
                backoffMicros_ = backoffMicros_ == 0
                                     ? FirstBackoffMicros
                                     : std::min(backoffMicros_ * 2U, MaximumBackoffMicros);
                blockedUntilMicros_ = nowMicros + backoffMicros_;
                cleanRunning_ = false;
                codec_ = VoiceCodec::Opus;
            }
            return codec_;
        }
        if (*worstLossPermille > CleanLossPermille || nowMicros < blockedUntilMicros_) {
            cleanRunning_ = false;
            return codec_;
        }
        if (!cleanRunning_) {
            cleanRunning_ = true;
            cleanSinceMicros_ = nowMicros;
        }
        if (nowMicros - cleanSinceMicros_ >= CleanSpanMicros)
            codec_ = VoiceCodec::Pcm16;
        return codec_;
    }

  private:
    VoiceCodec codec_{VoiceCodec::Opus};
    bool cleanRunning_{false};
    std::uint64_t cleanSinceMicros_{0};
    std::uint64_t blockedUntilMicros_{0};
    std::uint64_t backoffMicros_{0};
};

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
    AudioPacketWire::write<std::uint8_t>(bytes, 32, static_cast<std::uint8_t>(header.channels));
    AudioPacketWire::write<std::uint8_t>(bytes, 33, static_cast<std::uint8_t>(header.codec));
    AudioPacketWire::write<std::uint16_t>(bytes, 34, header.frames);
    AudioPacketWire::write<std::uint32_t>(
        bytes, 36,
        (header.reportedParticipantKey & ReportKeyMask) |
            (std::min<std::uint32_t>(header.reportedLossPermille, MaximumReportedLossPermille)
             << 24U));
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
    header.channels = AudioPacketWire::read<std::uint8_t>(bytes, 32);
    header.codec = static_cast<VoiceCodec>(AudioPacketWire::read<std::uint8_t>(bytes, 33));
    header.frames = AudioPacketWire::read<std::uint16_t>(bytes, 34);
    const auto report = AudioPacketWire::read<std::uint32_t>(bytes, 36);
    header.reportedParticipantKey = report & ReportKeyMask;
    header.reportedLossPermille = static_cast<std::uint16_t>(report >> 24U);
    header.streamEpoch = AudioPacketWire::read<std::uint32_t>(bytes, 40);
    return true;
}
