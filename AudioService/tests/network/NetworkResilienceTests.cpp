#include "TestHarness.hpp"
#include "network/AdaptiveJitterBuffer.hpp"
#include "network/NetworkAudioEngine.hpp"
#include "network/NetworkPacket.hpp"

#include <array>
#include <cstdint>
#include <limits>
#include <vector>

namespace Tests {
namespace {
std::vector<std::byte> markerPayload() {
    return {std::byte{0x2a}};
}
} // namespace

void jitterBufferSurvivesSequenceWrap() {
    AdaptiveJitterBuffer jitter;
    jitter.configure(2, 8);
    const auto last = std::numeric_limits<std::uint32_t>::max();
    jitter.push({last, 0, 1, 1, markerPayload()});
    jitter.push({0, 1, 1, 1, markerPayload()});
    NetworkAudioPacket packet;
    const auto beforeWrap = jitter.pop(packet) == JitterPopOutcome::Delivered &&
                            packet.sequence == last;
    const auto afterWrap = jitter.pop(packet) == JitterPopOutcome::Delivered &&
                           packet.sequence == 0;
    expect(beforeWrap && afterWrap,
           "jitter order remains continuous when the 32-bit packet sequence wraps");
}

void sharedTimelineTimestampSaturatesInsteadOfWrapping() {
    const auto almostMaximum = std::numeric_limits<std::uint64_t>::max() - 100U;
    const auto alignment = alignSharedAudioTimeline(almostMaximum, almostMaximum - 50U, 1'440U);
    expect(alignment.silenceFrames == 1'490U && alignment.skipFrames == 0,
           "a very long session cannot wrap its playout timestamp into the past");
}

void networkRejectsWrongSessionAndMalformedPackets() {
    constexpr std::uint64_t ExpectedToken = 0x123456789abcdef0ULL;
    AudioPacketHeader valid{7, 42, ExpectedToken, 48'000, 1, 240, 1'440};
    expect(audioPacketBelongsToSession(valid, ExpectedToken, 1),
           "the matching authenticated mono room packet is accepted");
    auto wrongToken = valid;
    wrongToken.sessionToken ^= 1U;
    expect(!audioPacketBelongsToSession(wrongToken, ExpectedToken, 1),
           "a packet carrying another room token is rejected");
    auto malformed = valid;
    malformed.frames = 0;
    expect(!audioPacketBelongsToSession(malformed, ExpectedToken, 1),
           "a malformed packet is rejected before it reaches Opus");
    auto bytes = encodeAudioPacketHeader(valid);
    bytes[0] ^= std::byte{0xff};
    AudioPacketHeader decoded{};
    expect(!decodeAudioPacketHeader(bytes, decoded),
           "a corrupted wire header is rejected deterministically");
}

void roomVoiceSupportsThreeParticipantsAndLateJoin() {
    NetworkAudioEngine network;
    network.prepare(48'000, 2, 24'000, 240, GenerationId{1});
    network.setSharedTimeline(true);
    expect(network.addRemoteParticipant("singer-a") &&
               network.addRemoteParticipant("singer-b"),
           "the first two remote singers join");
    const auto beforeLateJoin = network.diagnostics();
    expect(network.addRemoteParticipant("singer-c"),
           "a third singer can join after the room timeline has started");
    const auto afterLateJoin = network.diagnostics();
    expect(beforeLateJoin.participants.size() == 2 && afterLateJoin.participants.size() == 3,
           "late join keeps existing participants and adds an independent third stream");
}

void roomVoiceRejoinClearsPreviousParticipantState() {
    NetworkAudioEngine network;
    network.prepare(48'000, 1, 24'000, 240, GenerationId{1});
    expect(network.addRemoteParticipant("rejoining-singer"), "participant initially joins");
    expect(network.setRemoteGain("rejoining-singer", 0.25F), "old participant state changes");
    expect(network.removeRemoteParticipant("rejoining-singer"), "participant leaves mid-song");
    expect(network.addRemoteParticipant("rejoining-singer"), "participant rejoins mid-song");
    const auto diagnostics = network.diagnostics();
    expect(diagnostics.participants.size() == 1 &&
               diagnostics.participants.front().gain == 1.0F &&
               diagnostics.participants.front().latePackets == 0 &&
               diagnostics.participants.front().decodeUnderruns == 0,
           "rejoin resumes at the current room timeline without stale gain or jitter state");
}

void roomVoicePacketizationSupportsSystemRatesAndBuffers() {
    constexpr std::array rates{44'100U, 48'000U, 96'000U};
    constexpr std::array buffers{64U, 128U, 256U, 512U, 1'024U};
    for (const auto rate : rates) {
        std::uint64_t frames = 0;
        for (std::uint64_t packet = 0; packet < 200; ++packet)
            frames += deviceFramesForVoicePacket(packet, rate);
        expect(frames == rate, "one second of room packets exactly matches the system sample rate");
        for (const auto buffer : buffers) {
            NetworkAudioEngine network;
            network.prepare(rate, 2, rate / 2U, buffer, GenerationId{1});
            expect(network.diagnostics().playoutDelayFrames != 0,
                   "room transport accepts a driver-reported sample rate and buffer size");
        }
    }
}

void remoteQueueRecoversAfterForcedUnderrunAndOverrun() {
    constexpr std::uint32_t Target = 4'800;
    constexpr std::uint32_t Packet = 240;
    auto fill = 0U;
    for (std::uint32_t iteration = 0; iteration < 3'000 && fill < Target; ++iteration) {
        const auto correction = stabilizeRemoteQueue(fill, Target, Packet);
        fill += correction.silenceFrames;
        fill += Packet;
        fill = fill > Packet ? fill - Packet : 0U;
    }
    expect(fill + Packet >= Target, "a forced underrun rebuilds bounded playout headroom");
    fill = Target + Packet * 20U;
    for (std::uint32_t iteration = 0; iteration < 3'000 && fill > Target + Packet * 2U;
         ++iteration) {
        const auto correction = stabilizeRemoteQueue(fill, Target, Packet);
        fill = fill > correction.skipFrames ? fill - correction.skipFrames : 0U;
    }
    expect(fill <= Target + Packet * 2U,
           "a forced overrun sheds excess latency and returns to the bounded target");
}
} // namespace Tests
