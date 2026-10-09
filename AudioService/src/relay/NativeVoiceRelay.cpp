#include "relay/NativeVoiceRelay.hpp"

#include "network/NetworkPacket.hpp"

#include <algorithm>
#include <cmath>
#include <limits>
#include <utility>

namespace {
constexpr double RelayPacingIntervalSeconds =
    room_audio_contract::RelaySendPacingMilliseconds / 1'000.0;
constexpr double RoomPacketSeconds = VoicePacketSeconds;
constexpr double ProtocolRate = VoiceProtocolSampleRateHz;

constexpr std::string_view ServerMixParticipant = "__room_server_mix__";
constexpr std::uint64_t TimelineRestartFrames = VoiceProtocolSampleRateHz; // a >1 s rewind
constexpr std::uint32_t ExclusionMisses = 3;
constexpr double ExclusionGraceSeconds = 0.5;
constexpr std::uint32_t RecoveryPackets = 200;

std::vector<std::int16_t> decodePcm(std::span<const std::byte> bytes,
                                    std::uint16_t frames) {
    std::vector<std::int16_t> result(frames);
    for (std::size_t frame = 0; frame < frames; ++frame) {
        const auto offset = AudioPacketHeaderBytes + frame * 2U;
        const auto low = std::to_integer<std::uint16_t>(bytes[offset]);
        const auto high = std::to_integer<std::uint16_t>(bytes[offset + 1U]);
        result[frame] = static_cast<std::int16_t>(low | (high << 8U));
    }
    return result;
}

void appendPcm(std::vector<std::byte>& bytes, std::span<const std::int16_t> samples) {
    bytes.reserve(bytes.size() + samples.size() * 2U);
    for (const auto sample : samples) {
        const auto value = static_cast<std::uint16_t>(sample);
        bytes.push_back(static_cast<std::byte>(value & 0xFFU));
        bytes.push_back(static_cast<std::byte>((value >> 8U) & 0xFFU));
    }
}
double mediaSeconds(std::uint64_t timestampFrame) noexcept {
    return static_cast<double>(timestampFrame & ~SharedAudioTimelineFlag) / ProtocolRate;
}

std::uint32_t protocolFrames(double seconds) noexcept {
    return static_cast<std::uint32_t>(std::lround(std::clamp(seconds, 0.0, 1'000.0) * ProtocolRate));
}
} // namespace

void RelayDeadlineSlack::note(double slackMs) noexcept {
    const auto offset = std::floor(slackMs / BinMilliseconds) + static_cast<double>(BinCount / 2U);
    const auto bin = static_cast<std::size_t>(
        std::clamp(offset, 0.0, static_cast<double>(BinCount - 1U)));
    ++bins[bin];
    ++packets;
    negativePackets += static_cast<std::uint64_t>(slackMs < 0.0);
    minimumMs = std::min(minimumMs, slackMs);
}

double RelayDeadlineSlack::quantileMs(std::uint32_t permille) const noexcept {
    if (packets == 0)
        return 0.0;
    const auto rank = packets * permille / 1'000U;
    std::uint64_t seen = 0;
    for (std::size_t bin = 0; bin < BinCount; ++bin) {
        seen += bins[bin];
        if (seen > rank)
            return (static_cast<double>(bin) - static_cast<double>(BinCount / 2U)) *
                   BinMilliseconds;
    }
    return (static_cast<double>(BinCount / 2U) - 1.0) * BinMilliseconds;
}

NativeVoiceRelay::NativeVoiceRelay(double collectionWindowMilliseconds)
    : collectionWindowSeconds_(std::max(0.0, collectionWindowMilliseconds / 1'000.0)) {}

std::uint32_t NativeVoiceRelay::participantKey(std::string_view participant) noexcept {
    std::uint32_t value = 2'166'136'261U;
    for (const auto character : participant) {
        value ^= static_cast<unsigned char>(character);
        value *= 16'777'619U;
    }
    return value == 0 ? 1U : value;
}

bool NativeVoiceRelay::expect(std::string room, std::string participant, std::uint64_t token) {
    const auto key = participantKey(participant);
    forget(participant);
    const auto existing = rooms_.find(room);
    if (participants_.contains(token) ||
        (existing != rooms_.end() && existing->second.members.contains(key)))
        return false;
    Participant value{room, std::move(participant), key, token};
    participants_.emplace(token, std::move(value));
    rooms_[room].members.emplace(key, token);
    return true;
}

const NativeVoiceRelay::Participant* NativeVoiceRelay::member(const Room& room,
                                                              std::uint32_t key) const {
    const auto token = room.members.find(key);
    if (token == room.members.end())
        return nullptr;
    const auto found = participants_.find(token->second);
    return found == participants_.end() ? nullptr : &found->second;
}

void NativeVoiceRelay::forget(std::string_view participant) {
    const auto found = std::ranges::find_if(
        participants_, [participant](const auto& entry) { return entry.second.id == participant; });
    if (found == participants_.end())
        return;
    const auto key = found->second.key;
    auto room = rooms_.find(found->second.room);
    if (room != rooms_.end()) {
        room->second.members.erase(key);
        room->second.started.erase(key);
        room->second.excluded.erase(key);
        room->second.consecutiveMisses.erase(key);
        room->second.missStartedMonotonic.erase(key);
        room->second.recoveryPackets.erase(key);
        room->second.recoveryNextFrame.erase(key);
        for (auto& [position, pending] : room->second.pending) {
            (void)position;
            pending.inputs.erase(key);
        }
        for (auto gain = room->second.gains.begin(); gain != room->second.gains.end();) {
            if (gain->first.first == key || gain->first.second == key)
                gain = room->second.gains.erase(gain);
            else
                ++gain;
        }
    }
    participants_.erase(found);
}

void NativeVoiceRelay::setEligibleParticipants(
    std::string_view room, std::span<const std::string_view> participants) {
    auto& destination = rooms_[std::string(room)].eligible;
    destination.clear();
    for (const auto participant : participants)
        destination.insert(participantKey(participant));
}

void NativeVoiceRelay::setRecipientSourceGain(std::string_view room,
                                               std::string_view recipient,
                                               std::string_view source, float gain) {
    rooms_[std::string(room)].gains.insert_or_assign(
        {participantKey(recipient), participantKey(source)}, std::clamp(gain, 0.0F, 2.0F));
}

void NativeVoiceRelay::setRoomPlayoutDelay(std::string_view room, double milliseconds,
                                           double returnReserveMilliseconds) {
    auto& state = rooms_[std::string(room)];
    const auto seconds = std::max(0.0, milliseconds / 1'000.0);
    const auto reserve = std::max(0.0, returnReserveMilliseconds / 1'000.0);
    if (state.playoutDelaySeconds == seconds && state.returnReserveSeconds == reserve)
        return;
    const auto deadlineChanged = state.playoutDelaySeconds != seconds;
    state.playoutDelaySeconds = seconds;
    state.returnReserveSeconds = reserve;
    if (deadlineChanged)
        resetTimeline(state, false);
}

double NativeVoiceRelay::collectionAllowance(const Room& room) noexcept {
    return std::max(0.0, room.playoutDelaySeconds - room.returnReserveSeconds);
}

double NativeVoiceRelay::collectionWindow(const Room& room) const noexcept {
    return room.playoutDelaySeconds * 1'000.0 > room_audio_contract::MaximumLiveDelayMilliseconds
               ? std::max(collectionWindowSeconds_,
                          room_audio_contract::ConversationCollectionBudgetMilliseconds / 1'000.0)
               : collectionWindowSeconds_;
}

double NativeVoiceRelay::noIngressWindow(const Room& room) noexcept {
    return (room.playoutDelaySeconds * 1'000.0 > room_audio_contract::MaximumLiveDelayMilliseconds
                ? room_audio_contract::ConversationNoIngressBudgetMilliseconds
                : room_audio_contract::NoIngressBudgetMilliseconds) /
           1'000.0;
}

void NativeVoiceRelay::setGeneration(std::string_view room, std::uint32_t generation) {
    auto& state = rooms_[std::string(room)];
    if (state.generation == generation)
        return;
    state.generation = generation;
    resetTimeline(state, false);
    state.sequences.clear();
}

void NativeVoiceRelay::resetTimeline(Room& room, bool newGeneration) {
    if (newGeneration) {
        room.generation = room.generation == std::numeric_limits<std::uint32_t>::max()
                              ? 1U
                              : room.generation + 1U;
        room.sequences.clear();
    }
    room.pending.clear();
    room.mixed.clear();
    room.recipientMetrics.clear();
    room.latestInputEnd = 0;
    room.nextTimelinePosition = 0;
    room.nextSendMonotonic = 0.0;
    room.nextEmptyCloseMonotonic = 0.0;
    room.completePositions = 0;
    room.partialPositions = 0;
    room.missingContributions.clear();
    room.started.clear();
    room.excluded.clear();
    room.consecutiveMisses.clear();
    room.missStartedMonotonic.clear();
    room.recoveryPackets.clear();
    room.recoveryNextFrame.clear();
}

void NativeVoiceRelay::markMixed(Room& room, const Position& position) {
    room.mixed.insert(position);
    while (room.nextTimelinePosition != 0) {
        const Position next{room.nextTimelinePosition | SharedAudioTimelineFlag,
                            static_cast<std::uint16_t>(SharedRoomPacketFrames)};
        if (room.mixed.erase(next) == 0)
            break;
        room.nextTimelinePosition += SharedRoomPacketFrames;
    }
}

std::set<std::uint32_t> NativeVoiceRelay::expected(const Room& room) {
    auto result = room.eligible;
    for (const auto participant : room.excluded)
        result.erase(participant);
    return result;
}

std::vector<RelayDatagram> NativeVoiceRelay::receive(std::span<const std::byte> bytes,
                                                     RelayEndpoint source,
                                                     double monotonicSeconds,
                                                     double wallSeconds) {
    (void)monotonicSeconds;
    (void)wallSeconds;
    AudioPacketHeader header{};
    if (!decodeAudioPacketHeader(bytes, header) || header.codec != VoiceCodec::Pcm16 ||
        header.channels != 1 || header.frames != SharedRoomPacketFrames ||
        (header.timestampFrame & SharedAudioTimelineFlag) == 0 ||
        bytes.size() != AudioPacketHeaderBytes + static_cast<std::size_t>(header.frames) * 2U)
        return {};
    auto participant = participants_.find(header.sessionToken);
    if (participant == participants_.end() || participant->second.key != header.participantKey)
        return {};
    if (!participant->second.hasEndpoint)
        participant->second.lastProbeEcho = monotonicSeconds;
    participant->second.endpoint = std::move(source);
    participant->second.hasEndpoint = true;
    participant->second.active = true;
    auto& room = rooms_[participant->second.room];
    const auto mediaStart = header.timestampFrame & ~SharedAudioTimelineFlag;
    if (room.latestInputEnd != 0 &&
        mediaStart + TimelineRestartFrames < room.latestInputEnd)
        resetTimeline(room, true);
    room.latestInputEnd = std::max(room.latestInputEnd, mediaStart + header.frames);
    const auto arrivalLateness = wallSeconds - mediaSeconds(mediaStart);
    if (room.playoutDelaySeconds > 0.0) {
        room.recipientMetrics[header.participantKey].ingressSlack.note(
            (collectionAllowance(room) - arrivalLateness) * 1'000.0);
    }
    auto output = flush(monotonicSeconds, wallSeconds);
    const auto withProbe = [&](std::vector<RelayDatagram> result) {
        // Route health is independent of whether this packet also completed a mix. Suppressing
        // the echo during healthy continuous mixing makes clients falsely reconnect after three
        // samples without an echo.
        if (monotonicSeconds - participant->second.lastProbeEcho >= 1.0) {
            result.push_back({participant->second.endpoint,
                              std::vector<std::byte>(bytes.begin(), bytes.end())});
            participant->second.lastProbeEcho = monotonicSeconds;
        }
        return result;
    };
    if (room.nextTimelinePosition == 0)
        room.nextTimelinePosition = mediaStart;
    room.started.insert(header.participantKey);
    advanceRecovery(room, header.participantKey, mediaStart, header.frames, wallSeconds);
    if (mediaStart < room.nextTimelinePosition)
        return withProbe(std::move(output));
    const Position position{header.timestampFrame, header.frames};
    if (room.mixed.contains(position))
        return withProbe(std::move(output));
    const auto [pendingIterator, created] = room.pending.try_emplace(position);
    auto& pending = pendingIterator->second;
    if (created && room.playoutDelaySeconds > 0.0) {
        const auto closeWall = mediaSeconds(header.timestampFrame) + collectionAllowance(room);
        pending.deadlineMonotonic = monotonicSeconds + (closeWall - wallSeconds);
        if (pending.deadlineMonotonic < monotonicSeconds) {
            room.pending.erase(pendingIterator);
            room.mixed.insert(position);
            return withProbe(std::move(output));
        }
    }
    auto pcm = decodePcm(bytes, header.frames);
    long double squareSum = 0.0;
    std::int32_t ingressPeak = 0;
    for (const auto sample : pcm) {
        squareSum += static_cast<long double>(sample) * static_cast<long double>(sample);
        ingressPeak = std::max(ingressPeak, std::abs(static_cast<std::int32_t>(sample)));
    }
    participant->second.level = static_cast<float>(
        std::sqrt(squareSum / static_cast<long double>(pcm.size())) / 32'768.0L);
    participant->second.lastLevelMonotonic = monotonicSeconds;
    auto& ingressMetrics = room.recipientMetrics[header.participantKey];
    ingressMetrics.ingressNonzeroPackets += static_cast<std::uint64_t>(ingressPeak != 0);
    ingressMetrics.ingressPeak = std::max(ingressMetrics.ingressPeak, ingressPeak);
    pending.inputs.insert_or_assign(header.participantKey, std::move(pcm));
    pending.ingressFrames.insert_or_assign(header.participantKey, protocolFrames(arrivalLateness));
    const auto timelineReady = !room.eligible.empty() &&
                               std::ranges::all_of(room.eligible, [&](auto key) {
                                   return room.started.contains(key);
                               });
    if (timelineReady && room.playoutDelaySeconds > 0.0 &&
        !std::isfinite(pending.partialDeadlineMonotonic)) {
        const auto cadenceDeadline = room.nextEmptyCloseMonotonic == 0.0
                                         ? std::numeric_limits<double>::infinity()
                                         : room.nextEmptyCloseMonotonic;
        pending.partialDeadlineMonotonic = std::min(
            {pending.deadlineMonotonic, monotonicSeconds + collectionWindow(room),
             cadenceDeadline});
    }
    if (!timelineReady || !hasReadyRecipient(room, pending))
        return withProbe(std::move(output));
    if (room.playoutDelaySeconds > 0.0) {
        if (!std::isfinite(pending.readyMonotonic)) {
            pending.readyMonotonic = std::max(monotonicSeconds, room.nextSendMonotonic);
            room.nextSendMonotonic = pending.readyMonotonic + RelayPacingIntervalSeconds;
        }
        if (pending.readyMonotonic > monotonicSeconds)
            return withProbe(std::move(output));
    }
    auto result =
        finish(participant->second.room, position, pending, monotonicSeconds, wallSeconds, false);
    output.insert(output.end(), std::make_move_iterator(result.begin()),
                  std::make_move_iterator(result.end()));
    pending.readyMonotonic = std::numeric_limits<double>::infinity();
    if (positionFinished(room, pending)) {
        finalizePosition(room, pending, monotonicSeconds);
        room.pending.erase(position);
        markMixed(room, position);
    }
    return withProbe(std::move(output));
}

std::vector<RelayDatagram> NativeVoiceRelay::flush(double monotonicSeconds,
                                                   double wallSeconds) {
    std::vector<RelayDatagram> output;
    for (auto& [roomId, room] : rooms_) {
        const auto timelineReady = room.nextTimelinePosition != 0 &&
                                   room.playoutDelaySeconds > 0.0 &&
                                   !room.eligible.empty() &&
                                   std::ranges::all_of(room.eligible, [&](auto participant) {
                                       return room.started.contains(participant);
                                   });
        const auto allowed = collectionAllowance(room);
        if (timelineReady && wallSeconds >= allowed) {
            const auto latestDue = alignSharedTimelinePacketFrame(static_cast<std::uint64_t>(
                (wallSeconds - allowed) * ProtocolRate));
            if (latestDue > room.nextTimelinePosition + SharedRoomPacketFrames) {
                room.nextTimelinePosition = latestDue;
                room.pending.clear();
                std::erase_if(room.mixed, [latestDue](const auto& value) {
                    return (value.timestamp & ~SharedAudioTimelineFlag) < latestDue;
                });
                room.nextSendMonotonic = monotonicSeconds;
                room.nextEmptyCloseMonotonic = monotonicSeconds;
            }
        }
        for (auto position = room.pending.begin(); position != room.pending.end();) {
            const auto pendingDeadline = std::min(position->second.deadlineMonotonic,
                                                  position->second.partialDeadlineMonotonic);
            const auto ready = std::isfinite(position->second.readyMonotonic) &&
                               position->second.readyMonotonic <= monotonicSeconds;
            const auto forced = pendingDeadline <= monotonicSeconds;
            if (!ready && !forced) {
                ++position;
                continue;
            }
            if (forced) {
                room.nextSendMonotonic =
                    std::max(room.nextSendMonotonic, monotonicSeconds) + RelayPacingIntervalSeconds;
            }
            auto datagrams = finish(roomId, position->first, position->second,
                                    monotonicSeconds, wallSeconds, forced);
            output.insert(output.end(), std::make_move_iterator(datagrams.begin()),
                          std::make_move_iterator(datagrams.end()));
            position->second.readyMonotonic = std::numeric_limits<double>::infinity();
            if (forced || positionFinished(room, position->second)) {
                finalizePosition(room, position->second, monotonicSeconds);
                markMixed(room, position->first);
                position = room.pending.erase(position);
            } else {
                ++position;
            }
        }
        if (!timelineReady)
            continue;
        if (room.nextEmptyCloseMonotonic == 0.0)
            room.nextEmptyCloseMonotonic = monotonicSeconds + noIngressWindow(room);
        if (room.nextEmptyCloseMonotonic > monotonicSeconds)
            continue;
        const Position missing{room.nextTimelinePosition | SharedAudioTimelineFlag,
                               static_cast<std::uint16_t>(SharedRoomPacketFrames)};
        if (room.pending.contains(missing))
            continue;
        Pending silence;
        room.nextSendMonotonic = std::max(room.nextSendMonotonic, monotonicSeconds) +
                                 RelayPacingIntervalSeconds;
        auto datagrams =
            finish(roomId, missing, silence, monotonicSeconds, wallSeconds, true);
        output.insert(output.end(), std::make_move_iterator(datagrams.begin()),
                      std::make_move_iterator(datagrams.end()));
        finalizePosition(room, silence, monotonicSeconds);
        markMixed(room, missing);
        room.nextEmptyCloseMonotonic = monotonicSeconds + RoomPacketSeconds;
    }
    return output;
}

std::vector<RelayDatagram> NativeVoiceRelay::finish(std::string_view roomId,
                                                    const Position& position,
                                                    Pending& pending,
                                                    double sentAt,
                                                    double sentWall,
                                                    bool force) {
    auto& room = rooms_.at(std::string(roomId));
    room.nextEmptyCloseMonotonic = sentAt + noIngressWindow(room);
    const auto audible = expected(room);
    std::vector<RelayDatagram> output;
    for (const auto& [recipientKey, recipientToken] : room.members) {
        (void)recipientToken;
        const auto* recipient = member(room, recipientKey);
        if (recipient == nullptr || !recipient->hasEndpoint ||
            pending.sentRecipients.contains(recipientKey))
            continue;
        const auto ready = std::ranges::all_of(audible, [&](auto sourceKey) {
            return sourceKey == recipientKey || pending.inputs.contains(sourceKey);
        });
        if (!force && !ready)
            continue;
        pending.sentRecipients.insert(recipientKey);
        auto& metrics = room.recipientMetrics[recipientKey];
        // A later position may be ready for this recipient before an older partial mix.
        // Once the later position has left, the older one has missed its playout slot.
        if (metrics.packets != 0 &&
            (position.timestamp & ~SharedAudioTimelineFlag) <= metrics.pipelinePosition)
            continue;
        const auto sentAtMs = sentAt * 1'000.0;
        metrics.latestGapMs = metrics.lastSendMonotonicMs == 0.0
                                  ? 0.0
                                  : sentAtMs - metrics.lastSendMonotonicMs;
        metrics.maximumGapMs = std::max(metrics.maximumGapMs, metrics.latestGapMs);
        metrics.stalls += static_cast<std::uint64_t>(
            metrics.lastSendMonotonicMs != 0.0 && metrics.latestGapMs > 7.5);
        metrics.lastSendMonotonicMs = sentAtMs;
        metrics.pipelinePosition = position.timestamp & ~SharedAudioTimelineFlag;
        metrics.pipelineGeneration = room.generation;
        ++metrics.packets;
        std::vector<std::int16_t> mix(position.frames, 0);
        for (const auto& [sourceKey, voice] : pending.inputs) {
            if (sourceKey == recipientKey || !audible.contains(sourceKey))
                continue;
            const auto gain = [&] {
                const auto found = room.gains.find({recipientKey, sourceKey});
                return found == room.gains.end() ? 1.0F : found->second;
            }();
            for (std::size_t frame = 0; frame < mix.size(); ++frame) {
                const auto sample = static_cast<long>(std::lround(
                    static_cast<double>(mix[frame]) + static_cast<double>(voice[frame]) * gain));
                mix[frame] = static_cast<std::int16_t>(std::clamp(
                    sample, static_cast<long>(std::numeric_limits<std::int16_t>::min()),
                    static_cast<long>(std::numeric_limits<std::int16_t>::max())));
            }
        }
        std::int32_t recipientPeak = 0;
        for (const auto sample : mix)
            recipientPeak = std::max(recipientPeak, std::abs(static_cast<std::int32_t>(sample)));
        metrics.recipientNonzeroPackets += static_cast<std::uint64_t>(recipientPeak != 0);
        metrics.recipientPeak = std::max(metrics.recipientPeak, recipientPeak);
        AudioPacketHeader header{};
        header.sequence = room.sequences[recipientKey]++;
        header.participantKey = participantKey(ServerMixParticipant);
        header.sessionToken = recipient->token;
        header.timestampFrame = position.timestamp;
        header.channels = 1;
        header.frames = position.frames;
        header.codec = VoiceCodec::Pcm16;
        header.streamEpoch = room.generation;
        // How long this mix spent before leaving: the latest voice it carries reached the relay
        // `ingress` after its position, and the relay waited `collection` more. The listener
        // subtracts both from the mix's arrival lateness to measure its return route alone.
        std::uint32_t ingress = 0;
        for (const auto& [sourceKey, frames] : pending.ingressFrames) {
            if (sourceKey != recipientKey && audible.contains(sourceKey))
                ingress = std::max(ingress, frames);
        }
        const auto sendLateness = protocolFrames(sentWall - mediaSeconds(position.timestamp));
        const auto report = encodeServerMixStageReport(
            ingress, sendLateness > ingress ? sendLateness - ingress : 0U);
        header.reportedParticipantKey = report & ReportKeyMask;
        header.reportedLossPermille = static_cast<std::uint16_t>(report >> 24U);
        const auto encoded = encodeAudioPacketHeader(header);
        std::vector<std::byte> bytes(encoded.begin(), encoded.end());
        appendPcm(bytes, mix);
        output.push_back({recipient->endpoint, std::move(bytes)});
    }
    return output;
}

bool NativeVoiceRelay::hasReadyRecipient(const Room& room, const Pending& pending) const {
    const auto audible = expected(room);
    return std::ranges::any_of(room.members, [&](const auto& entry) {
        const auto recipientKey = entry.first;
        const auto* recipient = member(room, recipientKey);
        return recipient != nullptr && recipient->hasEndpoint &&
               !pending.sentRecipients.contains(recipientKey) &&
               std::ranges::all_of(audible, [&](auto sourceKey) {
                   return sourceKey == recipientKey || pending.inputs.contains(sourceKey);
               });
    });
}

bool NativeVoiceRelay::positionFinished(const Room& room, const Pending& pending) const {
    return std::ranges::all_of(room.members, [&](const auto& entry) {
        const auto recipientKey = entry.first;
        const auto* recipient = member(room, recipientKey);
        return recipient == nullptr || !recipient->hasEndpoint ||
               pending.sentRecipients.contains(recipientKey);
    });
}

void NativeVoiceRelay::finalizePosition(Room& room, const Pending& pending,
                                        double monotonicSeconds) {
    const auto required = expected(room);
    const auto complete = std::ranges::all_of(required, [&](auto participant) {
        return pending.inputs.contains(participant);
    });
    if (complete) {
        ++room.completePositions;
    } else {
        ++room.partialPositions;
        for (const auto participant : required) {
            if (!pending.inputs.contains(participant))
                ++room.missingContributions[participant];
        }
    }
    updateHealth(room, pending, monotonicSeconds);
}

void NativeVoiceRelay::updateHealth(Room& room, const Pending& pending,
                                    double monotonicSeconds) {
    if (room.eligible.empty() || !std::ranges::all_of(
            room.eligible, [&](auto participant) { return room.started.contains(participant); }))
        return;
    for (const auto participant : expected(room)) {
        if (pending.inputs.contains(participant)) {
            room.consecutiveMisses.erase(participant);
            room.missStartedMonotonic.erase(participant);
            continue;
        }
        const auto misses = ++room.consecutiveMisses[participant];
        const auto [started, _inserted] =
            room.missStartedMonotonic.try_emplace(participant, monotonicSeconds);
        if (misses >= ExclusionMisses &&
            monotonicSeconds - started->second >= ExclusionGraceSeconds) {
            room.excluded.insert(participant);
            room.consecutiveMisses.erase(participant);
            room.missStartedMonotonic.erase(participant);
            room.recoveryPackets[participant] = 0;
            room.recoveryNextFrame.erase(participant);
        }
    }
}

void NativeVoiceRelay::advanceRecovery(Room& room, std::uint32_t participant,
                                       std::uint64_t mediaStart, std::uint16_t frames,
                                       double wallSeconds) {
    if (!room.excluded.contains(participant))
        return;
    const auto allowed = collectionAllowance(room);
    const auto arrivalLateness = wallSeconds - mediaSeconds(mediaStart);
    if (room.playoutDelaySeconds > 0.0 && arrivalLateness > allowed) {
        room.recoveryPackets[participant] = 0;
        room.recoveryNextFrame.erase(participant);
        return;
    }
    const auto next = room.recoveryNextFrame.find(participant);
    if (next != room.recoveryNextFrame.end() && mediaStart < next->second)
        return;
    auto& recovered = room.recoveryPackets[participant];
    recovered = next != room.recoveryNextFrame.end() && next->second == mediaStart
                    ? recovered + 1U
                    : 1U;
    room.recoveryNextFrame[participant] = mediaStart + frames;
    if (recovered >= RecoveryPackets) {
        room.excluded.erase(participant);
        room.recoveryPackets.erase(participant);
        room.recoveryNextFrame.erase(participant);
    }
}

RelayRecipientMetrics NativeVoiceRelay::recipientMetrics(
    std::string_view room, std::string_view participant) const {
    const auto foundRoom = rooms_.find(std::string(room));
    if (foundRoom == rooms_.end())
        return {};
    const auto key = participantKey(participant);
    const auto found = foundRoom->second.recipientMetrics.find(key);
    auto result = found == foundRoom->second.recipientMetrics.end() ? RelayRecipientMetrics{}
                                                                    : found->second;
    result.completePositions = foundRoom->second.completePositions;
    result.partialPositions = foundRoom->second.partialPositions;
    const auto missing = foundRoom->second.missingContributions.find(key);
    result.missingContributions = missing == foundRoom->second.missingContributions.end()
                                      ? 0U
                                      : missing->second;
    return result;
}

std::map<std::string, float> NativeVoiceRelay::participantLevels(
    std::string_view room, double monotonicSeconds) const {
    std::map<std::string, float> result;
    const auto foundRoom = rooms_.find(std::string(room));
    if (foundRoom == rooms_.end())
        return result;
    for (const auto& [key, token] : foundRoom->second.members) {
        (void)token;
        const auto* participant = member(foundRoom->second, key);
        if (participant != nullptr && participant->lastLevelMonotonic != 0.0 &&
            monotonicSeconds - participant->lastLevelMonotonic <= 0.3)
            result.emplace(participant->id, participant->level);
    }
    return result;
}

std::size_t NativeVoiceRelay::excludedParticipants(std::string_view room) const {
    const auto found = rooms_.find(std::string(room));
    return found == rooms_.end() ? 0U : found->second.excluded.size();
}
