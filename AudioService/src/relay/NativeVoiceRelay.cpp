#include "relay/NativeVoiceRelay.hpp"

#include "network/NetworkPacket.hpp"

#include <algorithm>
#include <cmath>
#include <limits>
#include <utility>

namespace {
constexpr std::string_view ServerMixParticipant = "__room_server_mix__";
constexpr double ReturnRouteReserveSeconds = 0.010;
constexpr std::uint64_t TimelineRestartFrames = 48'000;
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
} // namespace

std::uint32_t NativeVoiceRelay::participantKey(std::string_view participant) noexcept {
    std::uint32_t value = 2'166'136'261U;
    for (const auto character : participant) {
        value ^= static_cast<unsigned char>(character);
        value *= 16'777'619U;
    }
    return value == 0 ? 1U : value;
}

void NativeVoiceRelay::expect(std::string room, std::string participant, std::uint64_t token) {
    const auto key = participantKey(participant);
    forget(participant);
    Participant value{room, std::move(participant), key, token};
    participants_.insert_or_assign(key, std::move(value));
    tokenKeys_.insert_or_assign(token, key);
    rooms_[room].members.insert(key);
}

void NativeVoiceRelay::forget(std::string_view participant) {
    const auto key = participantKey(participant);
    const auto found = participants_.find(key);
    if (found == participants_.end() || found->second.id != participant)
        return;
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
    tokenKeys_.erase(found->second.token);
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

void NativeVoiceRelay::setRoomPlayoutDelay(std::string_view room, double milliseconds) {
    auto& state = rooms_[std::string(room)];
    const auto seconds = std::max(0.0, milliseconds / 1'000.0);
    if (state.playoutDelaySeconds == seconds)
        return;
    state.playoutDelaySeconds = seconds;
    resetTimeline(state, false);
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
    room.started.clear();
    room.excluded.clear();
    room.consecutiveMisses.clear();
    room.missStartedMonotonic.clear();
    room.recoveryPackets.clear();
    room.recoveryNextFrame.clear();
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
    const auto token = tokenKeys_.find(header.sessionToken);
    if (token == tokenKeys_.end() || token->second != header.participantKey)
        return {};
    auto participant = participants_.find(header.participantKey);
    if (participant == participants_.end())
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
    room.started.insert(header.participantKey);
    advanceRecovery(room, header.participantKey, mediaStart, header.frames, wallSeconds);
    const Position position{header.timestampFrame, header.frames};
    if (room.mixed.contains(position))
        return withProbe(std::move(output));
    const auto [pendingIterator, created] = room.pending.try_emplace(position);
    auto& pending = pendingIterator->second;
    if (created && room.playoutDelaySeconds > 0.0) {
        const auto frame = static_cast<double>(
            header.timestampFrame & ~SharedAudioTimelineFlag);
        const auto closeWall = frame / 48'000.0 +
                               std::max(0.0, room.playoutDelaySeconds - ReturnRouteReserveSeconds);
        pending.deadlineMonotonic = monotonicSeconds + (closeWall - wallSeconds);
        if (pending.deadlineMonotonic < monotonicSeconds) {
            room.pending.erase(pendingIterator);
            room.mixed.insert(position);
            return withProbe(std::move(output));
        }
    }
    auto pcm = decodePcm(bytes, header.frames);
    long double squareSum = 0.0;
    for (const auto sample : pcm)
        squareSum += static_cast<long double>(sample) * static_cast<long double>(sample);
    participant->second.level = static_cast<float>(
        std::sqrt(squareSum / static_cast<long double>(pcm.size())) / 32'768.0L);
    participant->second.lastLevelMonotonic = monotonicSeconds;
    pending.inputs.insert_or_assign(header.participantKey, std::move(pcm));
    const auto required = expected(room);
    if (required.empty() || !std::ranges::all_of(required, [&](auto key) {
            return pending.inputs.contains(key);
        }))
        return withProbe(std::move(output));
    auto result = finish(participant->second.room, position, pending, monotonicSeconds);
    output.insert(output.end(), std::make_move_iterator(result.begin()),
                  std::make_move_iterator(result.end()));
    room.pending.erase(position);
    room.mixed.insert(position);
    return withProbe(std::move(output));
}

std::vector<RelayDatagram> NativeVoiceRelay::flush(double monotonicSeconds,
                                                   double wallSeconds) {
    (void)wallSeconds;
    std::vector<RelayDatagram> output;
    for (auto& [roomId, room] : rooms_) {
        for (auto position = room.pending.begin(); position != room.pending.end();) {
            if (position->second.deadlineMonotonic > monotonicSeconds) {
                ++position;
                continue;
            }
            auto datagrams = finish(roomId, position->first, position->second, monotonicSeconds);
            output.insert(output.end(), std::make_move_iterator(datagrams.begin()),
                          std::make_move_iterator(datagrams.end()));
            room.mixed.insert(position->first);
            position = room.pending.erase(position);
        }
    }
    return output;
}

std::vector<RelayDatagram> NativeVoiceRelay::finish(std::string_view roomId,
                                                    const Position& position,
                                                    Pending& pending,
                                                    double sentAt) {
    auto& room = rooms_.at(std::string(roomId));
    updateHealth(room, pending, sentAt);
    const auto audible = expected(room);
    std::vector<RelayDatagram> output;
    for (const auto recipientKey : room.members) {
        const auto recipient = participants_.find(recipientKey);
        if (recipient == participants_.end() || !recipient->second.hasEndpoint)
            continue;
        auto& metrics = room.recipientMetrics[recipientKey];
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
        AudioPacketHeader header{};
        header.sequence = room.sequences[recipientKey]++;
        header.participantKey = participantKey(ServerMixParticipant);
        header.sessionToken = recipient->second.token;
        header.timestampFrame = position.timestamp;
        header.channels = 1;
        header.frames = position.frames;
        header.codec = VoiceCodec::Pcm16;
        header.streamEpoch = room.generation;
        const auto encoded = encodeAudioPacketHeader(header);
        std::vector<std::byte> bytes(encoded.begin(), encoded.end());
        appendPcm(bytes, mix);
        output.push_back({recipient->second.endpoint, std::move(bytes)});
    }
    return output;
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
    const auto allowed = std::max(0.0, room.playoutDelaySeconds - ReturnRouteReserveSeconds);
    const auto arrivalLateness = wallSeconds - static_cast<double>(mediaStart) / 48'000.0;
    if (room.playoutDelaySeconds > 0.0 && arrivalLateness > allowed) {
        room.recoveryPackets[participant] = 0;
        room.recoveryNextFrame.erase(participant);
        return;
    }
    const auto next = room.recoveryNextFrame.find(participant);
    if (next != room.recoveryNextFrame.end() && mediaStart + frames == next->second)
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
    const auto found = foundRoom->second.recipientMetrics.find(participantKey(participant));
    return found == foundRoom->second.recipientMetrics.end() ? RelayRecipientMetrics{}
                                                             : found->second;
}

std::map<std::string, float> NativeVoiceRelay::participantLevels(
    std::string_view room, double monotonicSeconds) const {
    std::map<std::string, float> result;
    const auto foundRoom = rooms_.find(std::string(room));
    if (foundRoom == rooms_.end())
        return result;
    for (const auto key : foundRoom->second.members) {
        const auto participant = participants_.find(key);
        if (participant != participants_.end() && participant->second.lastLevelMonotonic != 0.0 &&
            monotonicSeconds - participant->second.lastLevelMonotonic <= 0.3)
            result.emplace(participant->second.id, participant->second.level);
    }
    return result;
}

std::size_t NativeVoiceRelay::excludedParticipants(std::string_view room) const {
    const auto found = rooms_.find(std::string(room));
    return found == rooms_.end() ? 0U : found->second.excluded.size();
}
