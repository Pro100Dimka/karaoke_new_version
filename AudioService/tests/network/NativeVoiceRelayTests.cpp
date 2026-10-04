#include "TestHarness.hpp"
#include "network/NetworkPacket.hpp"
#include "relay/NativeVoiceRelay.hpp"

#include <algorithm>
#include <array>
#include <cstddef>
#include <cstdint>
#include <span>
#include <string_view>
#include <vector>

namespace {
std::vector<std::byte> packet(std::string_view participant, std::uint64_t token,
                              std::uint32_t sequence, std::uint64_t position,
                              std::int16_t sample) {
    AudioPacketHeader header{};
    header.sequence = sequence;
    header.participantKey = NativeVoiceRelay::participantKey(participant);
    header.sessionToken = token;
    header.timestampFrame = position | SharedAudioTimelineFlag;
    header.channels = 1;
    header.frames = static_cast<std::uint16_t>(SharedRoomPacketFrames);
    header.codec = VoiceCodec::Pcm16;
    header.streamEpoch = 7;
    const auto wire = encodeAudioPacketHeader(header);
    std::vector<std::byte> result(wire.begin(), wire.end());
    for (std::uint32_t frame = 0; frame < SharedRoomPacketFrames; ++frame) {
        result.push_back(static_cast<std::byte>(sample & 0xFF));
        result.push_back(static_cast<std::byte>((static_cast<std::uint16_t>(sample) >> 8U) & 0xFFU));
    }
    return result;
}

std::vector<std::int16_t> samples(std::span<const std::byte> packetBytes) {
    std::vector<std::int16_t> result;
    for (std::size_t offset = AudioPacketHeaderBytes; offset + 1 < packetBytes.size(); offset += 2) {
        const auto low = std::to_integer<std::uint16_t>(packetBytes[offset]);
        const auto high = std::to_integer<std::uint16_t>(packetBytes[offset + 1]);
        result.push_back(static_cast<std::int16_t>(low | (high << 8U)));
    }
    return result;
}

const RelayDatagram& forTarget(const std::vector<RelayDatagram>& output,
                               const RelayEndpoint& target) {
    return *std::ranges::find_if(output, [&](const auto& value) { return value.target == target; });
}

std::size_t serverMixPackets(const std::vector<RelayDatagram>& output) {
    return std::ranges::count_if(output, [](const auto& datagram) {
        AudioPacketHeader header{};
        return decodeAudioPacketHeader(datagram.bytes, header) &&
               header.participantKey == NativeVoiceRelay::participantKey("__room_server_mix__");
    });
}
} // namespace

namespace Tests {
void nativeVoiceRelayPreservesTheV3WireProtocolAndBuildsMixMinus() {
    NativeVoiceRelay relay;
    constexpr std::uint64_t aliceToken = 0x1111;
    constexpr std::uint64_t bobToken = 0x2222;
    relay.expect("room", "alice", aliceToken);
    relay.expect("room", "bob", bobToken);
    constexpr std::array<std::string_view, 2> eligible{"alice", "bob"};
    relay.setEligibleParticipants("room", eligible);

    const RelayEndpoint alice{"10.0.0.1", 41001};
    const RelayEndpoint bob{"10.0.0.2", 41002};
    const auto alicePacket = packet("alice", aliceToken, 1, 48'000, 100);
    const auto bobPacket = packet("bob", bobToken, 1, 48'000, 1'000);
    expect(relay.receive(alicePacket, alice, 10.0, 1.0).empty(),
           "the native relay waits for all eligible singers in the position");
    const auto output = relay.receive(bobPacket, bob, 10.001, 1.001);

    expect(output.size() == 2, "one personalized mix-minus packet is produced per recipient");
    for (const auto& datagram : output) {
        AudioPacketHeader header{};
        expect(decodeAudioPacketHeader(datagram.bytes, header),
               "the native relay preserves the deployed v3 packet header");
        expect(header.participantKey == NativeVoiceRelay::participantKey("__room_server_mix__") &&
                   header.frames == SharedRoomPacketFrames && header.codec == VoiceCodec::Pcm16 &&
                   header.timestampFrame == (48'000U | SharedAudioTimelineFlag) &&
                   header.streamEpoch == 1,
               "the server mix uses the shared room identity and timeline");
        const auto mixed = samples(datagram.bytes);
        const auto expected = datagram.target == alice ? 1'000 : 100;
        expect(mixed.size() == SharedRoomPacketFrames &&
                   std::ranges::all_of(mixed, [expected](auto value) { return value == expected; }),
               "each recipient hears only the other eligible singer");
        expect(header.sessionToken == (datagram.target == alice ? aliceToken : bobToken),
               "each personalized packet keeps the recipient authentication token");
    }
}

void nativeVoiceRelayAppliesPersonalGainAndRejectsDuplicateCopies() {
    NativeVoiceRelay relay;
    relay.expect("room", "alice", 0x1111);
    relay.expect("room", "bob", 0x2222);
    constexpr std::array<std::string_view, 2> eligible{"alice", "bob"};
    relay.setEligibleParticipants("room", eligible);
    relay.setRecipientSourceGain("room", "alice", "bob", 0.25F);
    const RelayEndpoint alice{"10.0.0.1", 41001};
    const RelayEndpoint bob{"10.0.0.2", 41002};
    const auto alicePacket = packet("alice", 0x1111, 1, 48'000, 100);
    const auto bobPacket = packet("bob", 0x2222, 1, 48'000, 1'000);
    (void)relay.receive(alicePacket, alice, 10.0, 1.0);
    const auto output = relay.receive(bobPacket, bob, 10.001, 1.001);

    expect(std::ranges::all_of(samples(forTarget(output, alice).bytes),
                               [](auto value) { return value == 250; }),
           "personal gain changes only this recipient's server mix");
    expect(std::ranges::all_of(samples(forTarget(output, bob).bytes),
                               [](auto value) { return value == 100; }),
           "the other recipient keeps the unmodified source");
    expect(relay.receive(alicePacket, alice, 10.002, 1.002).empty() &&
               relay.receive(bobPacket, bob, 10.003, 1.003).empty(),
           "redundant upstream copies cannot emit a second mix for one position");
}

void nativeVoiceRelayClearsOldPositionsWhenTheGenerationChanges() {
    NativeVoiceRelay relay;
    relay.expect("room", "alice", 0x1111);
    relay.expect("room", "bob", 0x2222);
    constexpr std::array<std::string_view, 2> eligible{"alice", "bob"};
    relay.setEligibleParticipants("room", eligible);
    const RelayEndpoint alice{"10.0.0.1", 41001};
    const RelayEndpoint bob{"10.0.0.2", 41002};
    (void)relay.receive(packet("alice", 0x1111, 1, 48'000, 100), alice, 10.0, 1.0);
    relay.setGeneration("room", 2);
    (void)relay.receive(packet("bob", 0x2222, 2, 48'000, 1'000), bob, 10.001, 1.001);
    const auto output = relay.receive(
        packet("alice", 0x1111, 2, 48'000, 200), alice, 10.002, 1.002);

    AudioPacketHeader header{};
    expect(decodeAudioPacketHeader(forTarget(output, bob).bytes, header) &&
               header.streamEpoch == 2,
           "the native relay publishes the control-plane generation");
    expect(std::ranges::all_of(samples(forTarget(output, bob).bytes),
                               [](auto value) { return value == 200; }),
           "audio retained from the old generation cannot leak after seek");
}

void nativeVoiceRelayClosesPartialPositionsAtTheFixedDeadline() {
    NativeVoiceRelay relay;
    relay.expect("room", "alice", 0x1111);
    relay.expect("room", "bob", 0x2222);
    constexpr std::array<std::string_view, 2> eligible{"alice", "bob"};
    relay.setEligibleParticipants("room", eligible);
    relay.setRoomPlayoutDelay("room", 80.0);
    const RelayEndpoint alice{"10.0.0.1", 41001};
    const RelayEndpoint bob{"10.0.0.2", 41002};
    (void)relay.receive(packet("alice", 0x1111, 1, 47'999'880, 100), alice, 9.9, 999.9);
    (void)relay.receive(packet("bob", 0x2222, 1, 47'999'880, 1'000), bob, 9.901, 999.901);
    const auto aliceOnly = packet("alice", 0x1111, 2, 48'000'000, 300);
    (void)relay.receive(aliceOnly, alice, 10.05, 1'000.05);

    expect(relay.flush(10.071, 1'000.071).size() == 2,
           "the fixed deadline emits available audio instead of waiting indefinitely");
    const auto lateBob = packet("bob", 0x2222, 2, 48'000'000, 2'000);
    expect(relay.receive(lateBob, bob, 10.072, 1'000.072).empty(),
           "a packet that missed its position is never rendered later");
}

void nativeVoiceRelayClosesDuePositionsWhileOtherIngressContinues() {
    NativeVoiceRelay relay;
    relay.expect("room", "alice", 0x1111);
    relay.expect("room", "bob", 0x2222);
    constexpr std::array<std::string_view, 2> eligible{"alice", "bob"};
    relay.setEligibleParticipants("room", eligible);
    relay.setRoomPlayoutDelay("room", 80.0);
    const RelayEndpoint alice{"10.0.0.1", 41001};
    const RelayEndpoint bob{"10.0.0.2", 41002};
    constexpr std::uint64_t base = 48'000'000U;
    (void)relay.receive(packet("alice", 0x1111, 0, base - SharedRoomPacketFrames, 100),
                        alice, 9.9, 999.9);
    (void)relay.receive(packet("bob", 0x2222, 0, base - SharedRoomPacketFrames, 1'000),
                        bob, 9.901, 999.901);
    (void)relay.receive(packet("alice", 0x1111, 1, base, 300),
                        alice, 10.05, 1'000.05);

    const auto output = relay.receive(
        packet("alice", 0x1111, 2, base + SharedRoomPacketFrames, 400),
        alice, 10.071, 1'000.071);

    expect(serverMixPackets(output) == 2,
           "continuous ingress closes older due positions without waiting for a socket timeout");
    AudioPacketHeader header{};
    expect(decodeAudioPacketHeader(forTarget(output, bob).bytes, header) &&
               (header.timestampFrame & ~SharedAudioTimelineFlag) == base,
           "the emitted packet belongs to the expired position, not the newer ingress packet");
}

void nativeVoiceRelayEchoesTheAuthenticatedSenderForRouteMeasurement() {
    NativeVoiceRelay relay;
    relay.expect("room", "alice", 0x1111);
    const RelayEndpoint alice{"10.0.0.1", 41001};
    const auto probe = packet("alice", 0x1111, 1, 48'000, 100);

    expect(relay.receive(probe, alice, 10.0, 1.0).empty(),
           "joining learns the endpoint without an artificial zero-time RTT sample");
    const auto echo = relay.receive(probe, alice, 11.001, 2.001);

    expect(echo.size() == 1 && echo[0].target == alice && echo[0].bytes == probe,
           "the authenticated sender receives a periodic relay RTT echo");
}

void nativeVoiceRelayReportsItsRecipientSendCadence() {
    NativeVoiceRelay relay;
    relay.expect("room", "alice", 0x1111);
    relay.expect("room", "bob", 0x2222);
    constexpr std::array<std::string_view, 2> eligible{"alice", "bob"};
    relay.setEligibleParticipants("room", eligible);
    const RelayEndpoint alice{"10.0.0.1", 41001};
    const RelayEndpoint bob{"10.0.0.2", 41002};
    for (std::uint32_t index = 0; index < 2; ++index) {
        const auto position = 48'000U + index * SharedRoomPacketFrames;
        (void)relay.receive(packet("alice", 0x1111, index, position, 100), alice,
                            10.0 + index * 0.0025, 1.0 + index * 0.0025);
        (void)relay.receive(packet("bob", 0x2222, index, position, 1'000), bob,
                            10.001 + index * 0.0025, 1.001 + index * 0.0025);
    }

    const auto metrics = relay.recipientMetrics("room", "alice");
    expect(metrics.packets == 2 && metrics.pipelineGeneration == 1 &&
               metrics.pipelinePosition == 48'120U &&
               std::abs(metrics.latestGapMs - 2.5) < 0.001 &&
               std::abs(metrics.maximumGapMs - 2.5) < 0.001 && metrics.stalls == 0,
           "native diagnostics expose cadence and the active server timeline");
}

void nativeVoiceRelayResetsPositionStateWhenTheDeadlineChanges() {
    NativeVoiceRelay relay;
    relay.expect("room", "alice", 0x1111);
    relay.expect("room", "bob", 0x2222);
    constexpr std::array<std::string_view, 2> eligible{"alice", "bob"};
    relay.setEligibleParticipants("room", eligible);
    relay.setRoomPlayoutDelay("room", 80.0);
    const RelayEndpoint alice{"10.0.0.1", 41001};
    const RelayEndpoint bob{"10.0.0.2", 41002};
    constexpr auto position = 48'000'000U;
    (void)relay.receive(packet("alice", 0x1111, 1, position, 100), alice, 10.0, 1'000.0);

    relay.setRoomPlayoutDelay("room", 70.0);
    (void)relay.receive(packet("bob", 0x2222, 1, position, 1'000), bob, 10.001, 1'000.001);
    const auto output = relay.receive(
        packet("alice", 0x1111, 2, position, 200), alice, 10.002, 1'000.002);

    expect(std::ranges::all_of(samples(forTarget(output, bob).bytes),
                               [](auto value) { return value == 200; }),
           "a new deadline cannot reuse pending PCM collected under the old schedule");
    expect(relay.recipientMetrics("room", "alice").packets == 1,
           "deadline reconfiguration starts fresh native cadence diagnostics");
}

void nativeVoiceRelayStartsANewGenerationAfterABackwardSeek() {
    NativeVoiceRelay relay;
    relay.expect("room", "alice", 0x1111);
    relay.expect("room", "bob", 0x2222);
    constexpr std::array<std::string_view, 2> eligible{"alice", "bob"};
    relay.setEligibleParticipants("room", eligible);
    const RelayEndpoint alice{"10.0.0.1", 41001};
    const RelayEndpoint bob{"10.0.0.2", 41002};
    constexpr auto oldPosition = 144'000U;
    (void)relay.receive(packet("alice", 0x1111, 1, oldPosition, 100), alice, 10.0, 3.0);
    (void)relay.receive(packet("bob", 0x2222, 1, oldPosition, 1'000), bob, 10.001, 3.001);

    constexpr auto seekPosition = 24'000U;
    (void)relay.receive(packet("alice", 0x1111, 2, seekPosition, 200), alice, 10.002, 0.5);
    const auto output = relay.receive(
        packet("bob", 0x2222, 2, seekPosition, 2'000), bob, 10.003, 0.503);

    AudioPacketHeader header{};
    expect(decodeAudioPacketHeader(forTarget(output, alice).bytes, header) &&
               header.streamEpoch == 2,
           "a backward seek starts a fresh server mix generation");
    expect(std::ranges::all_of(samples(forTarget(output, bob).bytes),
                               [](auto value) { return value == 200; }),
           "retained positions from before a seek cannot affect the resumed mix");
}

void nativeVoiceRelayExposesFreshParticipantLevelsToTheControlPlane() {
    NativeVoiceRelay relay;
    relay.expect("room", "alice", 0x1111);
    const RelayEndpoint alice{"10.0.0.1", 41001};
    (void)relay.receive(packet("alice", 0x1111, 1, 48'000, 1'000), alice, 10.0, 1.0);

    const auto fresh = relay.participantLevels("room", 10.1);
    const auto stale = relay.participantLevels("room", 10.4);

    expect(fresh.contains("alice") && std::abs(fresh.at("alice") - 0.0305176F) < 0.0001F,
           "the control plane receives the native ingress microphone level");
    expect(stale.empty(), "participant levels expire when voice ingress stops");
}

void nativeVoiceRelayExcludesOnlyALongMissingStreamAndRecoversAtTheCurrentPosition() {
    NativeVoiceRelay relay;
    relay.expect("room", "alice", 0x1111);
    relay.expect("room", "bob", 0x2222);
    constexpr std::array<std::string_view, 2> eligible{"alice", "bob"};
    relay.setEligibleParticipants("room", eligible);
    relay.setRoomPlayoutDelay("room", 80.0);
    const RelayEndpoint alice{"10.0.0.1", 41001};
    const RelayEndpoint bob{"10.0.0.2", 41002};
    constexpr std::uint64_t base = 48'000'000U;
    (void)relay.receive(packet("alice", 0x1111, 0, base, 100), alice, 10.0, 1'000.0);
    (void)relay.receive(packet("bob", 0x2222, 0, base, 1'000), bob, 10.001, 1'000.001);

    for (std::uint32_t index = 1; index <= 205; ++index) {
        const auto position = base + index * SharedRoomPacketFrames;
        const auto at = 10.0 + index * 0.0025;
        (void)relay.receive(packet("alice", 0x1111, index, position, 100), alice,
                            at, 1'000.0 + index * 0.0025);
        (void)relay.flush(at + 0.071, 1'000.071 + index * 0.0025);
    }
    expect(relay.excludedParticipants("room") == 1,
           "a stream is excluded only after a sustained half-second absence");

    for (std::uint32_t index = 206; index < 406; ++index) {
        const auto position = base + index * SharedRoomPacketFrames;
        const auto at = 10.0 + index * 0.0025;
        (void)relay.receive(packet("alice", 0x1111, index, position, 100), alice,
                            at, 1'000.0 + index * 0.0025);
        (void)relay.receive(packet("bob", 0x2222, index, position, 1'000), bob,
                            at + 0.001, 1'000.001 + index * 0.0025);
    }
    expect(relay.excludedParticipants("room") == 0,
           "two hundred consecutive on-time packets recover the stream at the current position");

    constexpr std::uint32_t recoveredIndex = 406;
    const auto recoveredPosition = base + recoveredIndex * SharedRoomPacketFrames;
    const auto recoveredAt = 10.0 + recoveredIndex * 0.0025;
    const auto waiting = relay.receive(
        packet("alice", 0x1111, recoveredIndex, recoveredPosition, 100), alice,
        recoveredAt, 1'000.0 + recoveredIndex * 0.0025);
    expect(serverMixPackets(waiting) == 0,
           "the recovered singer is immediately expected in the live mix again");
    const auto recovered = relay.receive(
        packet("bob", 0x2222, recoveredIndex, recoveredPosition, 1'000), bob,
        recoveredAt + 0.001, 1'000.001 + recoveredIndex * 0.0025);
    expect(serverMixPackets(recovered) == 2,
           "the first complete recovered position is mixed for both recipients");
}
} // namespace Tests
