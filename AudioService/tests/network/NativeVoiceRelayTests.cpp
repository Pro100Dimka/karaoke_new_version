#include "TestHarness.hpp"
#include "network/NetworkPacket.hpp"
#include "relay/NativeVoiceRelay.hpp"

#include <algorithm>
#include <array>
#include <cstddef>
#include <cstdint>
#include <span>
#include <string_view>
#include <tuple>
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

void configureTwoSingerRoom(NativeVoiceRelay& relay) {
    relay.expect("room", "alice", 0x1111);
    relay.expect("room", "bob", 0x2222);
    constexpr std::array<std::string_view, 2> eligible{"alice", "bob"};
    relay.setEligibleParticipants("room", eligible);
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
    configureTwoSingerRoom(relay);
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

void nativeVoiceRelayQuantizesOnlyTheCompleteRecipientMix() {
    struct MixCase {
        std::array<std::int16_t, 3> voices;
        std::int16_t expected;
        float gain{1.0F};
    };
    constexpr std::array cases{
        MixCase{{30'000, 30'000, -30'000}, 30'000},
        MixCase{{-30'000, -30'000, 30'000}, -30'000},
        MixCase{{30'000, 30'000, 30'000}, 32'767},
        MixCase{{-30'000, -30'000, -30'000}, -32'768},
        MixCase{{1, 1, 1}, 1, 0.25F},
    };
    constexpr std::array<std::string_view, 4> participants{"alice", "bob", "carol", "dave"};
    const RelayEndpoint recipient{"127.0.0.1", 41'003};
    for (const auto& scenario : cases) {
        auto voices = scenario.voices;
        std::ranges::sort(voices);
        do {
            NativeVoiceRelay relay;
            relay.setEligibleParticipants("room", participants);
            std::vector<RelayDatagram> output;
            for (std::size_t index = 0; index < participants.size(); ++index) {
                const auto name = participants[index];
                const auto token = static_cast<std::uint64_t>(index + 1);
                expect(relay.expect("room", std::string(name), token),
                       "all four singers have independent authenticated voice sessions");
                relay.setRecipientSourceGain("room", "dave", name, scenario.gain);
                const RelayEndpoint endpoint{"127.0.0.1",
                                             static_cast<std::uint16_t>(41'000 + index)};
                const auto sample = index < voices.size() ? voices[index] : std::int16_t{0};
                output = relay.receive(packet(name, token, 1, 48'000, sample), endpoint, 10.0, 1.0);
            }
            expect(serverMixPackets(output) == participants.size(),
                   "a complete four-singer position emits every personalized mix");
            const auto mixed = samples(forTarget(output, recipient).bytes);
            expect(std::ranges::all_of(mixed,
                                       [&](auto sample) { return sample == scenario.expected; }),
                   "mix-minus sums all voices before rounding or clipping, regardless of identity "
                   "order");
        } while (std::next_permutation(voices.begin(), voices.end()));
    }
}

void nativeVoiceRelayRequiresRecoveryAfterOneMissedDeadline() {
    NativeVoiceRelay relay;
    configureTwoSingerRoom(relay);
    relay.setRoomPlayoutDelay("room", 80.0);
    const RelayEndpoint alice{"10.0.0.1", 41001};
    const RelayEndpoint bob{"10.0.0.2", 41002};
    constexpr std::uint64_t base = 48'000'000;
    (void)relay.receive(packet("alice", 0x1111, 1, base, 100), alice, 10.0, 1'000.020);
    (void)relay.receive(packet("bob", 0x2222, 1, base, 1'000), bob, 10.001, 1'000.021);
    (void)relay.receive(packet("alice", 0x1111, 2, base + SharedRoomPacketFrames, 100), alice,
                        10.0025, 1'000.0225);
    (void)relay.flush(10.0235, 1'000.0435);
    expect(relay.excludedParticipants("room") == 1,
           "one missed position excludes its singer until a continuous recovery window");
    if (relay.excludedParticipants("room") != 1)
        return;

    for (std::uint32_t index = 0; index < 200; ++index) {
        const auto position = base + (index + 20) * SharedRoomPacketFrames;
        const auto elapsed = static_cast<double>(index + 20) * VoicePacketSeconds;
        auto output = relay.receive(packet("bob", 0x2222, index + 3, position, 1'000), bob,
                                    10.0 + elapsed, 1'000.020 + elapsed);
        const auto other = relay.receive(packet("alice", 0x1111, index + 3, position, 100), alice,
                                         10.001 + elapsed, 1'000.021 + elapsed);
        output.insert(output.end(), other.begin(), other.end());
        const auto mixed = samples(forTarget(output, alice).bytes);
        const auto expected = index == 199 ? 1'000 : 0;
        expect(std::ranges::all_of(mixed, [expected](auto sample) { return sample == expected; }),
               "excluded audio stays silent until 200 consecutive on-time current positions");
    }
    expect(relay.excludedParticipants("room") == 0,
           "a stable half-second of current voice restores eligibility");
}

void nativeVoiceRelayEnforcesSingingDeadlinesBeforeEveryFirstPacket() {
    NativeVoiceRelay relay;
    configureTwoSingerRoom(relay);
    relay.setRoomPlayoutDelay("room", 80.0, 10.0, 1'000.0);
    const RelayEndpoint alice{"10.0.0.1", 41001};
    const RelayEndpoint bob{"10.0.0.2", 41002};
    (void)relay.receive(packet("alice", 0x1111, 1, 47'995'200, 100), alice, 9.9, 999.9);
    (void)relay.flush(9.971, 999.971);
    expect(relay.excludedParticipants("room") == 0,
           "pre-song warmup waits for the first voice packets");
    (void)relay.receive(packet("alice", 0x1111, 2, 48'000'000, 100), alice, 10.020, 1'000.020);
    (void)relay.flush(10.071, 1'000.071);
    expect(relay.excludedParticipants("room") == 1,
           "an eligible singer with no first packet misses the actual singing deadline");
    if (relay.excludedParticipants("room") != 1)
        return;
    (void)relay.flush(10.095, 1'000.095);
    expect(relay.excludedParticipants("room") == 2,
           "a never-started peer cannot mask another singer's missed position");
    for (std::uint32_t index = 0; index < 200; ++index) {
        const auto position = 48'004'800 + index * SharedRoomPacketFrames;
        const auto elapsed = 0.1 + static_cast<double>(index) * VoicePacketSeconds;
        auto output = relay.receive(packet("bob", 0x2222, index + 3, position, 1'000), bob,
                                    10.020 + elapsed, 1'000.020 + elapsed);
        auto other = relay.receive(packet("alice", 0x1111, index + 3, position, 100), alice,
                                   10.021 + elapsed, 1'000.021 + elapsed);
        output.insert(output.end(), other.begin(), other.end());
        other = relay.flush(10.022 + elapsed, 1'000.022 + elapsed);
        output.insert(output.end(), other.begin(), other.end());
        const auto expected = index == 199 ? 1'000 : 0;
        expect(std::ranges::any_of(output,
                                   [&](const auto& datagram) {
                                       return datagram.target == alice &&
                                              std::ranges::all_of(samples(datagram.bytes),
                                                                  [expected](auto sample) {
                                                                      return sample == expected;
                                                                  });
                                   }),
               "every singer must recover for 200 consecutive current positions");
    }
    expect(relay.excludedParticipants("room") == 0, "both recovered current voices rejoin");
}

void nativeVoiceRelayClearsPersonalGainWhenARecipientLeaves() {
    NativeVoiceRelay relay;
    relay.expect("room", "alice", 0x1111);
    relay.expect("room", "bob", 0x2222);
    relay.setRecipientSourceGain("room", "bob", "alice", 0.0F);
    relay.forget("bob");
    relay.expect("room", "bob", 0x3333);
    constexpr std::array<std::string_view, 2> eligible{"alice", "bob"};
    relay.setEligibleParticipants("room", eligible);
    const RelayEndpoint alice{"10.0.0.1", 41001};
    const RelayEndpoint bob{"10.0.0.2", 41002};
    (void)relay.receive(packet("alice", 0x1111, 1, 48'120, 100), alice, 10.0, 1.0);
    const auto output = relay.receive(packet("bob", 0x3333, 1, 48'120, 1'000), bob, 10.001, 1.001);

    expect(std::ranges::all_of(samples(forTarget(output, bob).bytes),
                               [](auto value) { return value == 100; }),
           "a recipient who rejoins starts with the default audible personal mix");
}

void nativeVoiceRelayKeepsRoomEligibilityAcrossVoiceRejoin() {
    NativeVoiceRelay relay;
    relay.expect("room", "alice", 0x1111);
    relay.expect("room", "bob", 0x2222);
    constexpr std::array<std::string_view, 2> eligible{"alice", "bob"};
    relay.setEligibleParticipants("room", eligible);

    relay.forget("bob");
    relay.expect("room", "bob", 0x3333);

    const RelayEndpoint alice{"10.0.0.1", 41001};
    const RelayEndpoint bob{"10.0.0.2", 41002};
    (void)relay.receive(packet("alice", 0x1111, 1, 48'120, 100), alice, 10.0, 1.0);
    const auto output =
        relay.receive(packet("bob", 0x3333, 1, 48'120, 1'000), bob, 10.001, 1.001);

    expect(serverMixPackets(output) == 2 &&
               std::ranges::all_of(samples(forTarget(output, alice).bytes),
                                   [](auto value) { return value == 1'000; }),
           "recreating a voice session cannot remove a still-connected singer from the "
           "room's authoritative eligible set");
}

void nativeVoiceRelayClearsOldPositionsWhenTheGenerationChanges() {
    NativeVoiceRelay relay;
    configureTwoSingerRoom(relay);
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
    NativeVoiceRelay relay(8.0);
    configureTwoSingerRoom(relay);
    relay.setRoomPlayoutDelay("room", 80.0);
    const RelayEndpoint alice{"10.0.0.1", 41001};
    const RelayEndpoint bob{"10.0.0.2", 41002};
    (void)relay.receive(packet("alice", 0x1111, 1, 47'999'880, 100), alice, 10.0, 1'000.0);
    (void)relay.receive(packet("bob", 0x2222, 1, 47'999'880, 1'000), bob, 10.001, 1'000.001);
    const auto aliceOnly = packet("alice", 0x1111, 2, 48'000'000, 300);
    const auto aliceToBob = relay.receive(aliceOnly, alice, 10.002, 1'000.002);
    expect(serverMixPackets(aliceToBob) == 1 &&
               std::ranges::all_of(samples(forTarget(aliceToBob, bob).bytes),
                                   [](auto value) { return value == 300; }),
           "the present singer reaches the other recipient before partial collection closes");

    expect(relay.flush(10.0099, 1'000.0099).empty(),
           "a partial position keeps a short bounded opportunity for the missing singer");
    const auto partial = relay.flush(10.0101, 1'000.0101);
    expect(serverMixPackets(partial) == 1 &&
               std::ranges::all_of(samples(forTarget(partial, alice).bytes),
                                   [](auto value) { return value == 0; }),
           "the bounded collection window emits present audio with correct mix-minus instead "
           "of waiting for the room deadline");
    const auto lateBob = packet("bob", 0x2222, 2, 48'000'000, 2'000);
    expect(relay.receive(lateBob, bob, 10.011, 1'000.011).empty(),
           "a packet that missed its position is never rendered later");

    const auto nextPosition = 48'000'000U + SharedRoomPacketFrames;
    const auto recoveredToBob = relay.receive(
        packet("alice", 0x1111, 3, nextPosition, 400), alice, 10.012, 1'000.012);
    const auto recovered = relay.receive(packet("bob", 0x2222, 3, nextPosition, 2'000), bob,
                                         10.013, 1'000.013);
    expect(serverMixPackets(recoveredToBob) == 2 && serverMixPackets(recovered) == 0 &&
               std::ranges::all_of(samples(forTarget(recoveredToBob, alice).bytes),
                                   [](auto value) { return value == 0; }),
           "one subsequent on-time packet cannot bypass the excluded singer's recovery window");

    relay.setGeneration("room", 2);
    const auto cadenceBase = 48'000'000U + 8U * SharedRoomPacketFrames;
    (void)relay.receive(packet("alice", 0x1111, 4, cadenceBase, 100), alice, 10.020, 1'000.020);
    (void)relay.receive(packet("bob", 0x2222, 4, cadenceBase, 1'000), bob, 10.021, 1'000.021);
    const auto cadenceBoundPosition = cadenceBase + SharedRoomPacketFrames;
    const auto cadenceToBob = relay.receive(packet("alice", 0x1111, 5, cadenceBoundPosition, 500),
                                            alice, 10.0405, 1'000.0405);
    expect(relay.flush(10.0409, 1'000.0409).empty(),
           "a late first input may use the remaining room cadence window");
    const auto cadenceBound = relay.flush(10.0411, 1'000.0411);
    expect(serverMixPackets(cadenceToBob) == 1 && serverMixPackets(cadenceBound) == 1 &&
               std::ranges::all_of(samples(forTarget(cadenceToBob, bob).bytes),
                                   [](auto value) { return value == 500; }),
           "the per-position collection window cannot extend the hard room cadence bound");
}

void nativeVoiceRelayKeepsSingingInputsUntilTheAuthoritativeDeadline() {
    NativeVoiceRelay relay;
    configureTwoSingerRoom(relay);
    const RelayEndpoint alice{"10.0.0.1", 41001};
    const RelayEndpoint bob{"10.0.0.2", 41002};
    constexpr std::uint64_t base = 48'000'000;
    (void)relay.receive(packet("alice", 0x1111, 1, base - 4'800, 100), alice, 9.900, 999.900);
    (void)relay.receive(packet("bob", 0x2222, 1, base - 4'800, 1'000), bob, 9.901, 999.901);
    relay.setRoomPlayoutDelay("room", 110.0, 22.5, 1'000.0);

    const auto early =
        relay.receive(packet("alice", 0x1111, 2, base, 300), alice, 10.022, 1'000.022);
    expect(serverMixPackets(early) == 1 && forTarget(early, bob).target == bob,
           "a ready mix-minus recipient may hear the first singer before the hard deadline");
    const auto premature = relay.flush(10.0421, 1'000.0421);
    expect(serverMixPackets(premature) == 0 && relay.excludedParticipants("room") == 0,
           "the first arrival plus collection window cannot exclude an on-time singing source");

    const auto onTime =
        relay.receive(packet("bob", 0x2222, 2, base, 2'000), bob, 10.060, 1'000.060);
    expect(serverMixPackets(onTime) == 1 && relay.excludedParticipants("room") == 0,
           "60 ms ingress is eligible before the fixed 87.5 ms collection deadline");
    if (serverMixPackets(onTime) == 1)
        expect(std::ranges::all_of(samples(forTarget(onTime, alice).bytes),
                                   [](auto value) { return value == 2'000; }),
               "the other recipient receives the on-time remote PCM, not a premature zero mix");

    const auto next = base + SharedRoomPacketFrames;
    (void)relay.receive(packet("alice", 0x1111, 3, next, 400), alice, 10.0625, 1'000.0625);
    expect(serverMixPackets(relay.flush(10.0899, 1'000.0899)) == 0 &&
               relay.excludedParticipants("room") == 0,
           "the next singing position keeps the same fixed deadline without early cadence closure");
    const auto missed = relay.flush(10.0901, 1'000.0901);
    expect(serverMixPackets(missed) == 1 && relay.excludedParticipants("room") == 1,
           "a genuinely absent singer is excluded immediately after the fixed deadline");
    if (serverMixPackets(missed) == 1)
        expect(std::ranges::all_of(samples(forTarget(missed, alice).bytes),
                                   [](auto value) { return value == 0; }),
               "the hard deadline emits silence for the missing remote contribution");
    expect(serverMixPackets(
               relay.receive(packet("bob", 0x2222, 3, next, 2'000), bob, 10.0902, 1'000.0902)) == 0,
           "a truly late singing packet is never replayed after its closed position");

    // Supporting continuous coverage after the isolated RED: the same two healthy ingress
    // offsets must not oscillate through the 500 ms excluded-stream recovery window.
    relay.setRoomPlayoutDelay("room", 110.0, 22.5, 1'001.0);
    constexpr auto continuousBase = base + VoiceProtocolSampleRateHz;
    constexpr std::uint32_t positions = 260;
    std::array<std::uint64_t, 2> nextOutput{continuousBase, continuousBase};
    const auto collect = [&](const std::vector<RelayDatagram>& output) {
        for (const auto& datagram : output) {
            AudioPacketHeader header{};
            if (!decodeAudioPacketHeader(datagram.bytes, header) ||
                header.participantKey != NativeVoiceRelay::participantKey("__room_server_mix__"))
                continue;
            const auto recipient = datagram.target == alice ? 0U : 1U;
            const auto expected = recipient == 0U ? 2'000 : 300;
            expect((header.timestampFrame & ~SharedAudioTimelineFlag) == nextOutput[recipient] &&
                       std::ranges::all_of(samples(datagram.bytes),
                                           [expected](auto value) { return value == expected; }),
                   "continuous asymmetric on-time singers retain every current nonzero mix");
            nextOutput[recipient] += SharedRoomPacketFrames;
        }
    };
    struct Ingress {
        std::string_view participant;
        std::uint64_t token;
        RelayEndpoint endpoint;
        std::uint32_t firstTick;
        std::int16_t sample;
    };
    const std::array singers{Ingress{"alice", 0x1111, alice, 44, 300},
                             Ingress{"bob", 0x2222, bob, 120, 2'000}};
    for (std::uint32_t tick = 0; tick <= 1'420; ++tick) {
        const auto elapsed = static_cast<double>(tick) * 0.0005;
        for (const auto& singer : singers) {
            if (tick < singer.firstTick || (tick - singer.firstTick) % 5U != 0)
                continue;
            const auto index = (tick - singer.firstTick) / 5U;
            if (index < positions)
                collect(relay.receive(packet(singer.participant, singer.token, index + 4U,
                                             continuousBase + index * SharedRoomPacketFrames,
                                             singer.sample),
                                      singer.endpoint, 11.0 + elapsed, 1'001.0 + elapsed));
        }
        collect(relay.flush(11.0 + elapsed, 1'001.0 + elapsed));
        expect(relay.excludedParticipants("room") == 0,
               "a sustained 22/60 ms ingress pair never enters recovery before the 87.5 ms bound");
    }
    expect(std::ranges::all_of(nextOutput,
                               [](auto position) {
                                   return position ==
                                          continuousBase + positions * SharedRoomPacketFrames;
                               }),
           "both recipients receive all 260 positions across more than the recovery interval");
}

void nativeVoiceRelayBoundsPartialCollectionForManySingers() {
    NativeVoiceRelay relay(8.0);
    relay.expect("room", "alice", 0x1111);
    relay.expect("room", "bob", 0x2222);
    relay.expect("room", "carol", 0x3333);
    constexpr std::array<std::string_view, 3> eligible{"alice", "bob", "carol"};
    relay.setEligibleParticipants("room", eligible);
    relay.setRecipientSourceGain("room", "bob", "alice", 0.25F);
    relay.setRecipientSourceGain("room", "bob", "carol", 0.0F);
    relay.setRoomPlayoutDelay("room", 80.0);
    const RelayEndpoint alice{"10.0.0.1", 41001};
    const RelayEndpoint bob{"10.0.0.2", 41002};
    const RelayEndpoint carol{"10.0.0.3", 41003};
    constexpr std::uint64_t base = 48'000'000U;

    (void)relay.receive(packet("alice", 0x1111, 1, base - SharedRoomPacketFrames, 100),
                        alice, 10.000, 1'000.000);
    (void)relay.receive(packet("bob", 0x2222, 1, base - SharedRoomPacketFrames, 1'000),
                        bob, 10.001, 1'000.001);
    expect(serverMixPackets(relay.receive(
               packet("carol", 0x3333, 1, base - SharedRoomPacketFrames, 10'000),
               carol, 10.002, 1'000.002)) == 3,
           "all three singers establish the active room timeline");

    (void)relay.receive(packet("alice", 0x1111, 2, base, 400), alice,
                        10.003, 1'000.003);
    expect(relay.flush(10.0109, 1'000.0109).empty(),
           "the N-singer collection window remains bounded but covers measured ingress jitter");
    const auto partial = relay.flush(10.0111, 1'000.0111);
    expect(serverMixPackets(partial) == 3,
           "one missing singer cannot delay the other recipients past the bounded window");
    expect(std::ranges::all_of(samples(forTarget(partial, bob).bytes),
                               [](auto value) { return value == 100; }) &&
               std::ranges::all_of(samples(forTarget(partial, alice).bytes),
                                   [](auto value) { return value == 0; }),
           "partial N-singer output preserves per-recipient gain, mute, and mix-minus");
    const auto metrics = relay.recipientMetrics("room", "bob");
    expect(metrics.completePositions == 1 && metrics.partialPositions == 1 &&
               metrics.missingContributions == 1,
           "native metrics distinguish complete positions from one missing N-singer contribution");
}

void nativeVoiceRelayEmitsRecipientMixesIndependently() {
    NativeVoiceRelay relay;
    configureTwoSingerRoom(relay);
    relay.setRoomPlayoutDelay("room", 80.0);
    const RelayEndpoint alice{"10.0.0.1", 41001};
    const RelayEndpoint bob{"10.0.0.2", 41002};
    constexpr std::uint64_t base = 48'000'000U;
    (void)relay.receive(packet("alice", 0x1111, 1, base, 100), alice,
                        10.000, 1'000.000);
    expect(serverMixPackets(relay.receive(packet("bob", 0x2222, 1, base, 1'000), bob,
                                          10.001, 1'000.001)) == 2,
           "both singers first establish the active recipient set");

    const auto position = base + SharedRoomPacketFrames;
    const auto toBob = relay.receive(packet("alice", 0x1111, 2, position, 300), alice,
                                     10.002, 1'000.002);
    expect(serverMixPackets(toBob) == 1 && forTarget(toBob, bob).target == bob &&
               std::ranges::all_of(samples(forTarget(toBob, bob).bytes),
                                   [](auto value) { return value == 300; }),
           "Alice is sent to Bob immediately without waiting for Bob's self-excluded input");

    const auto toAlice = relay.receive(packet("bob", 0x2222, 2, position, 2'000), bob,
                                       10.006, 1'000.006);
    expect(serverMixPackets(toAlice) == 1 && forTarget(toAlice, alice).target == alice &&
               std::ranges::all_of(samples(forTarget(toAlice, alice).bytes),
                                   [](auto value) { return value == 2'000; }),
           "Bob can complete Alice's personalized position later without replaying Alice to Bob");

    const auto aliceMetrics = relay.recipientMetrics("room", "alice");
    const auto bobMetrics = relay.recipientMetrics("room", "bob");
    expect(aliceMetrics.ingressNonzeroPackets == 2 && aliceMetrics.ingressPeak == 300 &&
               bobMetrics.ingressNonzeroPackets == 2 && bobMetrics.ingressPeak == 2'000,
           "native diagnostics prove each source delivered nonzero PCM to relay ingress");
    expect(aliceMetrics.recipientNonzeroPackets == 2 &&
               aliceMetrics.recipientPeak == 2'000 &&
               bobMetrics.recipientNonzeroPackets == 2 && bobMetrics.recipientPeak == 300,
           "native diagnostics prove personalized recipient mixes contain the remote PCM");
}

void nativeVoiceRelayNeverSendsOlderPositionAfterNewerMixToRecipient() {
    NativeVoiceRelay relay;
    configureTwoSingerRoom(relay);
    relay.setRoomPlayoutDelay("room", 80.0);
    const RelayEndpoint alice{"10.0.0.1", 41001};
    const RelayEndpoint bob{"10.0.0.2", 41002};
    constexpr std::uint64_t base = 48'000'000U;
    (void)relay.receive(packet("alice", 0x1111, 0, base, 300), alice,
                        10.000, 1'000.000);
    (void)relay.receive(packet("bob", 0x2222, 0, base, 1'000), bob,
                        10.001, 1'000.001);
    const auto older = base + SharedRoomPacketFrames;
    const auto newer = older + SharedRoomPacketFrames;
    (void)relay.receive(packet("bob", 0x2222, 1, older, 1'000), bob,
                        10.003, 1'000.003);
    const auto first = relay.receive(packet("alice", 0x1111, 2, newer, 300), alice,
                                     10.005, 1'000.005);
    AudioPacketHeader header{};
    expect(serverMixPackets(first) == 1 &&
               decodeAudioPacketHeader(forTarget(first, bob).bytes, header) &&
               (header.timestampFrame & ~SharedAudioTimelineFlag) == newer,
           "Bob receives the ready newer voice while the older position awaits Alice");
    const auto newerSequence = header.sequence;
    const auto later = relay.flush(10.011, 1'000.011);
    for (const auto& datagram : later) {
        if (datagram.target != bob ||
            !decodeAudioPacketHeader(datagram.bytes, header) ||
            header.participantKey != NativeVoiceRelay::participantKey("__room_server_mix__"))
            continue;
        expect(header.sequence > newerSequence &&
                   (header.timestampFrame & ~SharedAudioTimelineFlag) > newer,
               "a recipient must never receive an older musical position after a newer mix");
    }
}

void nativeVoiceRelayKeepsOnTimeSingingPositionsInRecipientOrder() {
    NativeVoiceRelay relay;
    configureTwoSingerRoom(relay);
    relay.setRoomPlayoutDelay("room", 110.0, 40.0, 1'000.0);
    const std::array endpoints{RelayEndpoint{"10.0.0.1", 41001},
                               RelayEndpoint{"10.0.0.2", 41002}};
    constexpr std::array<std::string_view, 2> names{"alice", "bob"};
    constexpr std::array<std::uint64_t, 2> tokens{0x1111, 0x2222};
    constexpr std::uint64_t base = 48'000'000U;
    std::array<std::vector<std::uint64_t>, 2> received;
    const auto collect = [&](const std::vector<RelayDatagram>& output) {
        for (const auto& datagram : output) {
            AudioPacketHeader header{};
            if (decodeAudioPacketHeader(datagram.bytes, header) &&
                header.participantKey == NativeVoiceRelay::participantKey("__room_server_mix__"))
                received[datagram.target == endpoints[0] ? 0U : 1U].push_back(
                    header.timestampFrame & ~SharedAudioTimelineFlag);
        }
    };
    struct Step {
        std::size_t singer;
        std::uint32_t position;
        double elapsed;
        std::array<std::size_t, 2> counts;
        const char* reason;
    };
    const std::array steps{
        Step{0, 0, .020, {0, 0}, "first input waits for the other recipient endpoint"},
        Step{1, 0, .021, {1, 1}, "the first complete singing position establishes both recipients"},
        Step{1, 1, .023, {2, 1}, "Alice hears Bob without waiting for her own missing input"},
        Step{0, 2, .025, {2, 1}, "Bob's newer position cannot overtake his still-open older position"},
        Step{0, 1, .026, {2, 2}, "Bob receives the older voice that arrived before its 72.5 ms deadline"},
    };
    for (const auto& step : steps) {
        collect(relay.receive(packet(names[step.singer], tokens[step.singer], step.position,
                                     base + step.position * SharedRoomPacketFrames, 300),
                              endpoints[step.singer], 10.0 + step.elapsed, 1'000.0 + step.elapsed));
        expect(received[0].size() == step.counts[0] && received[1].size() == step.counts[1],
               step.reason);
    }
    collect(relay.flush(10.0271, 1'000.0271));
    expect(received[1] == std::vector<std::uint64_t>{base, base + SharedRoomPacketFrames,
                                                   base + 2U * SharedRoomPacketFrames},
           "the deferred newer mix follows the older mix without waiting for a missing self input");
    expect(relay.excludedParticipants("room") == 0,
           "reordering on-time input never starts excluded-stream recovery");
}

void nativeVoiceRelayPacesNewlyUnblockedSingingPositions() {
    NativeVoiceRelay relay;
    configureTwoSingerRoom(relay);
    relay.setRoomPlayoutDelay("room", 110.0, 40.0, 1'000.0);
    const std::array endpoints{RelayEndpoint{"10.0.0.1", 41001},
                               RelayEndpoint{"10.0.0.2", 41002}};
    constexpr std::array<std::string_view, 2> names{"alice", "bob"};
    constexpr std::array<std::uint64_t, 2> tokens{0x1111, 0x2222};
    constexpr std::uint64_t base = 48'000'000U;
    std::vector<std::uint64_t> received;
    struct Step {
        std::size_t singer;
        std::uint32_t position;
        double elapsed;
        std::size_t count;
    };
    const std::array steps{
        Step{0, 0, .020, 0}, Step{1, 0, .021, 1}, Step{1, 1, .023, 1},
        Step{0, 2, .025, 1}, Step{0, 3, .026, 1}, Step{0, 4, .027, 1},
        Step{0, 1, .030, 2}, Step{2, 0, .0301, 2}, Step{2, 0, .0311, 3},
        Step{2, 0, .0315, 3}, Step{2, 0, .0322, 4}, Step{2, 0, .0333, 5},
    };
    for (const auto& step : steps) {
        const auto output = step.singer < names.size()
                                ? relay.receive(packet(names[step.singer], tokens[step.singer],
                                                       step.position,
                                                       base + step.position * SharedRoomPacketFrames,
                                                       300),
                                                endpoints[step.singer], 10.0 + step.elapsed,
                                                1'000.0 + step.elapsed)
                                : relay.flush(10.0 + step.elapsed, 1'000.0 + step.elapsed);
        for (const auto& datagram : output) {
            AudioPacketHeader header{};
            if (datagram.target == endpoints[1] && decodeAudioPacketHeader(datagram.bytes, header) &&
                header.participantKey == NativeVoiceRelay::participantKey("__room_server_mix__")) {
                expect(std::ranges::all_of(samples(datagram.bytes),
                                           [](auto value) { return value == 300; }),
                       "every deferred position retains its on-time remote voice");
                received.push_back(header.timestampFrame & ~SharedAudioTimelineFlag);
            }
        }
        expect(received.size() == step.count,
               "unblocked singing positions keep the existing one-millisecond recipient pacing");
    }
    expect(received == std::vector<std::uint64_t>{base, base + SharedRoomPacketFrames,
                                                 base + 2U * SharedRoomPacketFrames,
                                                 base + 3U * SharedRoomPacketFrames,
                                                 base + 4U * SharedRoomPacketFrames} &&
               relay.excludedParticipants("room") == 0,
           "paced ordered release retains every position without waiting for missing self PCM");
}

void nativeVoiceRelayReleasesOrderedSingingMixesAtTheFixedDeadline() {
    constexpr std::array<std::string_view, 4> names{"alice", "bob", "carol", "dave"};
    constexpr std::array<std::uint64_t, 4> tokens{0x1111, 0x2222, 0x3333, 0x4444};
    const std::array endpoints{RelayEndpoint{"10.0.0.1", 41001},
                               RelayEndpoint{"10.0.0.2", 41002},
                               RelayEndpoint{"10.0.0.3", 41003},
                               RelayEndpoint{"10.0.0.4", 41004}};
    constexpr std::uint64_t base = 48'000'000U;
    for (const auto& [count, closeElapsed, nextElapsed, excluded] :
         {std::tuple{3U, .0726, .0737, 1U}, std::tuple{4U, .0726, .0737, 1U},
          std::tuple{3U, .0744, .0751, 2U}, std::tuple{4U, .0744, .0751, 2U}}) {
        NativeVoiceRelay relay;
        for (std::size_t index = 0; index < count; ++index)
            relay.expect("room", std::string(names[index]), tokens[index]);
        relay.setEligibleParticipants("room", std::span(names).first(count));
        relay.setRoomPlayoutDelay("room", 110.0, 40.0, 1'000.0);
        std::vector<std::pair<std::uint64_t, std::int16_t>> received;
        const auto collect = [&](const std::vector<RelayDatagram>& output) {
            for (const auto& datagram : output) {
                AudioPacketHeader header{};
                if (datagram.target != endpoints[1] ||
                    !decodeAudioPacketHeader(datagram.bytes, header) ||
                    header.participantKey != NativeVoiceRelay::participantKey("__room_server_mix__"))
                    continue;
                const auto pcm = samples(datagram.bytes);
                expect(std::ranges::all_of(pcm, [&](auto value) { return value == pcm.front(); }),
                       "the complete packet preserves the same summed remote voices");
                received.emplace_back(header.timestampFrame & ~SharedAudioTimelineFlag, pcm.front());
            }
        };
        struct PositionInputs {
            std::uint32_t position;
            std::size_t absent;
            double elapsed;
        };
        for (const auto& input : {PositionInputs{0, 4, .020}, PositionInputs{1, 0, .030},
                                  PositionInputs{2, 1, .040}}) {
            for (std::size_t singer = 0; singer < count; ++singer) {
                if (singer == input.absent)
                    continue;
                const auto elapsed = input.elapsed + static_cast<double>(singer) * .0001;
                collect(relay.receive(packet(names[singer], tokens[singer], input.position,
                                             base + input.position * SharedRoomPacketFrames, 100),
                                      endpoints[singer], 10.0 + elapsed, 1'000.0 + elapsed));
            }
        }
        collect(relay.flush(10.0724, 1'000.0724));
        expect(received.size() == 1 && relay.excludedParticipants("room") == 0,
               "three or four singers cannot advance Bob past his still-on-time missing remote voice");
        collect(relay.flush(10.0 + closeElapsed, 1'000.0 + closeElapsed));
        const auto remoteSum = static_cast<std::int16_t>((count - 2U) * 100U);
        expect(received.size() == 2 && relay.excludedParticipants("room") == 1,
               "the unresolved older position closes at the unchanged 72.5 ms deadline");
        expect(serverMixPackets(relay.receive(
                   packet(names[0], tokens[0], 1, base + SharedRoomPacketFrames, 100),
                   endpoints[0], 10.0002 + closeElapsed, 1'000.0002 + closeElapsed)) == 0,
               "the expired older input cannot replay or immediately rejoin the excluded singer");
        collect(relay.flush(10.0 + nextElapsed, 1'000.0 + nextElapsed));
        expect(received == std::vector<std::pair<std::uint64_t, std::int16_t>>{
                               {base, static_cast<std::int16_t>((count - 1U) * 100U)},
                               {base + SharedRoomPacketFrames, remoteSum},
                               {base + 2U * SharedRoomPacketFrames, remoteSum}} &&
                   relay.excludedParticipants("room") == excluded,
               "the paced newer mix reaches Bob by the first flush at its fixed 75 ms deadline, "
               "which overrides pacing, with no wait for Bob's self-excluded input");
    }
}

void nativeVoiceRelayClosesDuePositionsWhileOtherIngressContinues() {
    NativeVoiceRelay relay(8.0);
    configureTwoSingerRoom(relay);
    relay.setRoomPlayoutDelay("room", 80.0);
    const RelayEndpoint alice{"10.0.0.1", 41001};
    const RelayEndpoint bob{"10.0.0.2", 41002};
    constexpr std::uint64_t base = 48'000'000U;
    (void)relay.receive(packet("alice", 0x1111, 0, base - SharedRoomPacketFrames, 100),
                        alice, 10.000, 1'000.000);
    (void)relay.receive(packet("bob", 0x2222, 0, base - SharedRoomPacketFrames, 1'000),
                        bob, 10.001, 1'000.001);
    const auto firstOutput = relay.receive(packet("alice", 0x1111, 1, base, 300),
                                           alice, 10.002, 1'000.002);

    const auto output = relay.receive(
        packet("alice", 0x1111, 2, base + SharedRoomPacketFrames, 400),
        alice, 10.011, 1'000.011);

    expect(serverMixPackets(output) >= 1,
           "continuous ingress closes older due positions without waiting for a socket timeout");
    AudioPacketHeader header{};
    expect(serverMixPackets(firstOutput) == 1 &&
               decodeAudioPacketHeader(forTarget(firstOutput, bob).bytes, header) &&
               (header.timestampFrame & ~SharedAudioTimelineFlag) == base &&
               decodeAudioPacketHeader(forTarget(output, alice).bytes, header) &&
               (header.timestampFrame & ~SharedAudioTimelineFlag) == base,
           "the emitted packet belongs to the expired position, not the newer ingress packet");
}

void nativeVoiceRelayEmitsSilenceWhenAnEntireDuePositionHasNoIngress() {
    NativeVoiceRelay relay;
    configureTwoSingerRoom(relay);
    relay.setRoomPlayoutDelay("room", 80.0);
    const RelayEndpoint alice{"10.0.0.1", 41001};
    const RelayEndpoint bob{"10.0.0.2", 41002};
    constexpr std::uint64_t base = 48'000'000U;
    (void)relay.receive(packet("alice", 0x1111, 1, base, 100), alice, 10.0, 1'000.0);
    expect(serverMixPackets(relay.receive(
               packet("bob", 0x2222, 1, base, 1'000), bob, 10.001, 1'000.001)) == 2,
           "the first complete position starts the authoritative server cadence immediately");

    const auto second = base + SharedRoomPacketFrames;
    (void)relay.receive(packet("alice", 0x1111, 2, second, 200), alice,
                        10.0011, 1'000.0011);
    expect(relay.receive(packet("bob", 0x2222, 2, second, 2'000), bob,
                         10.0012, 1'000.0012)
                   .empty() &&
               relay.receive(packet("alice", 0x1111, 2, second, 200), alice,
                             10.0013, 1'000.0013)
                   .empty() &&
               relay.receive(packet("bob", 0x2222, 2, second, 2'000), bob,
                             10.0014, 1'000.0014)
                   .empty() &&
               relay.flush(10.0019, 1'000.0019).empty(),
           "a second position and its redundant copies wait for the original room-grid slot");
    expect(serverMixPackets(relay.flush(10.0021, 1'000.0021)) == 2,
           "ready mixes are spread inside the callback period without consuming room latency");

    expect(relay.flush(10.0220, 1'000.0220).empty(),
           "an entirely absent position gets a bounded no-ingress collection opportunity");
    const auto silence = relay.flush(10.0222, 1'000.0222);

    expect(serverMixPackets(silence) == 2,
           "the server timeline emits a due position even when every upstream packet is absent");
    AudioPacketHeader header{};
    expect(decodeAudioPacketHeader(forTarget(silence, alice).bytes, header) &&
               (header.timestampFrame & ~SharedAudioTimelineFlag) ==
                   base + SharedRoomPacketFrames * 2U &&
               std::ranges::all_of(samples(forTarget(silence, alice).bytes),
                                   [](auto value) { return value == 0; }),
           "the missing position is represented by on-time silence instead of a downstream gap");

    const auto followingSilence = relay.flush(10.0248, 1'000.0248);
    expect(serverMixPackets(followingSilence) == 2 &&
               decodeAudioPacketHeader(forTarget(followingSilence, alice).bytes, header) &&
               (header.timestampFrame & ~SharedAudioTimelineFlag) ==
                   base + SharedRoomPacketFrames * 3U,
           "once ingress is absent, silence follows the 2.5-ms room grid without a backlog");

    const auto afterSilence = base + SharedRoomPacketFrames * 4U;
    (void)relay.receive(packet("alice", 0x1111, 3, afterSilence, 300), alice,
                        10.0251, 1'000.0251);
    expect(relay.receive(packet("bob", 0x2222, 3, afterSilence, 3'000), bob,
                         10.0252, 1'000.0252)
                   .empty() &&
               serverMixPackets(relay.flush(10.0259, 1'000.0259)) == 2,
           "a silence deadline also advances the pacer before live audio resumes");

    for (std::uint32_t index = 5; index < 64; ++index) {
        const auto queuedPosition = base + index * SharedRoomPacketFrames;
        (void)relay.receive(packet("alice", 0x1111, index, queuedPosition, 300), alice,
                            10.028, 1'000.028);
        (void)relay.receive(packet("bob", 0x2222, index, queuedPosition, 3'000), bob,
                            10.028, 1'000.028);
    }
    const auto afterStall = relay.flush(10.200, 1'000.200);
    const auto currentDue = alignSharedTimelinePacketFrame(
        static_cast<std::uint64_t>((1'000.200 - 0.070) * 48'000.0));
    expect(serverMixPackets(afterStall) == 2 &&
               decodeAudioPacketHeader(forTarget(afterStall, alice).bytes, header) &&
               (header.timestampFrame & ~SharedAudioTimelineFlag) == currentDue,
           "after a scheduler stall the relay resumes at the current position instead of "
           "bursting obsolete silence");
    const auto afterStallPosition = currentDue + SharedRoomPacketFrames;
    (void)relay.receive(packet("alice", 0x1111, 64, afterStallPosition, 300), alice,
                        10.2001, 1'000.2001);
    expect(relay.receive(packet("bob", 0x2222, 64, afterStallPosition, 3'000), bob,
                         10.2002, 1'000.2002)
                   .empty() &&
               serverMixPackets(relay.flush(10.2011, 1'000.2011)) == 2,
           "discarding stale scheduled positions re-anchors the pacer at the current timeline");
}

void nativeVoiceRelayPacesCallbackBurstsWithoutLongTermDrift() {
    NativeVoiceRelay relay;
    configureTwoSingerRoom(relay);
    relay.setRoomPlayoutDelay("room", 80.0);
    const RelayEndpoint alice{"10.0.0.1", 41001};
    const RelayEndpoint bob{"10.0.0.2", 41002};
    constexpr std::uint64_t base = 48'000'000U;
    constexpr std::uint32_t callbacks = 2'000;
    std::size_t mixedPackets = 0;
    const auto collect = [&](const std::vector<RelayDatagram>& output) {
        mixedPackets += serverMixPackets(output);
    };

    for (std::uint32_t callback = 0; callback < callbacks; ++callback) {
        const auto callbackMonotonic = 10.030 + callback * 0.010;
        const auto callbackWall = 1'000.030 + callback * 0.010;
        if (callback != 0) {
            // A nominal 3 ms SO_RCVTIMEO can wake on a 4 ms kernel tick on Linux.
            for (const auto offset : {0.004, 0.008})
                collect(relay.flush(callbackMonotonic - 0.010 + offset,
                                    callbackWall - 0.010 + offset));
        }
        for (std::uint32_t packetIndex = 0; packetIndex < 4; ++packetIndex) {
            const auto sequence = callback * 4U + packetIndex;
            const auto position = base + sequence * SharedRoomPacketFrames;
            const auto alicePacket = packet("alice", 0x1111, sequence, position, 100);
            const auto bobPacket = packet("bob", 0x2222, sequence, position, 1'000);
            collect(relay.receive(alicePacket, alice, callbackMonotonic, callbackWall));
            collect(relay.receive(alicePacket, alice, callbackMonotonic, callbackWall));
            collect(relay.receive(bobPacket, bob, callbackMonotonic, callbackWall));
            collect(relay.receive(bobPacket, bob, callbackMonotonic, callbackWall));
        }
    }
    for (const auto offset : {0.004, 0.008, 0.012, 0.016})
        collect(relay.flush(30.020 + offset, 1'020.020 + offset));

    const auto mixedPositions = mixedPackets / 2U;
    expect(mixedPositions >= callbacks * 4U - 4U,
           "kernel-rounded relay wake-ups sustain the 400-Hz room grid without cumulative "
           "pacer drift");
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

void nativeVoiceRelayEchoesTheSenderEvenWhenThePacketCompletesAMix() {
    NativeVoiceRelay relay;
    configureTwoSingerRoom(relay);
    const RelayEndpoint alice{"10.0.0.1", 41001};
    const RelayEndpoint bob{"10.0.0.2", 41002};
    (void)relay.receive(packet("alice", 0x1111, 1, 48'000, 100), alice, 10.0, 1.0);
    (void)relay.receive(packet("bob", 0x2222, 1, 48'000, 1'000), bob, 10.001, 1.001);
    (void)relay.receive(packet("bob", 0x2222, 2, 48'120, 1'000), bob, 11.0, 2.0);

    const auto alicePacket = packet("alice", 0x1111, 2, 48'120, 100);
    const auto output = relay.receive(alicePacket, alice, 11.001, 2.001);
    const auto echoes = std::ranges::count_if(output, [&](const auto& datagram) {
        return datagram.target == alice && datagram.bytes == alicePacket;
    });

    expect(serverMixPackets(output) == 1 && echoes == 1,
           "a healthy continuous mix still echoes the sender so the client cannot mistake it "
           "for a dead relay");
}

void nativeVoiceRelayReportsItsRecipientSendCadence() {
    NativeVoiceRelay relay;
    configureTwoSingerRoom(relay);
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
    configureTwoSingerRoom(relay);
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

void nativeVoiceRelayKeepsTheCurrentMixWhenOnlyReturnReserveChanges() {
    NativeVoiceRelay relay;
    configureTwoSingerRoom(relay);
    relay.setRoomPlayoutDelay("room", 160.0, 25.0);
    const RelayEndpoint alice{"10.0.0.1", 41001};
    const RelayEndpoint bob{"10.0.0.2", 41002};
    constexpr auto first = 48'000'000U;
    (void)relay.receive(packet("alice", 0x1111, 1, first, 100), alice, 10.0, 1'000.0);
    (void)relay.receive(packet("bob", 0x2222, 1, first, 1'000), bob, 10.001, 1'000.001);

    const auto next = first + SharedRoomPacketFrames;
    (void)relay.receive(packet("alice", 0x1111, 2, next, 200), alice, 10.0025, 1'000.0025);
    relay.setRoomPlayoutDelay("room", 160.0, 22.5);
    const auto output = relay.receive(packet("bob", 0x2222, 2, next, 2'000), bob,
                                      10.0035, 1'000.0035);

    expect(serverMixPackets(output) == 1 &&
               std::ranges::all_of(samples(forTarget(output, alice).bytes),
                                   [](auto value) { return value == 2'000; }) &&
               relay.recipientMetrics("room", "alice").packets == 2,
           "a changed return reserve must not clear an in-flight voice or reset send cadence");
}

void nativeVoiceRelayCollectsCaptureBurstsBeforeClosingTheMix() {
    for (const auto [delay, reserve, burstMs, packetsPerBurst] :
         {std::tuple{250.0, 60.0, 30.0, 12U}, std::tuple{110.0, 22.5, 15.0, 6U}}) {
        NativeVoiceRelay relay;
        configureTwoSingerRoom(relay);
        relay.setRoomPlayoutDelay("room", delay, reserve);
        const RelayEndpoint asio{"10.0.0.1", 41001};
        const RelayEndpoint shared{"10.0.0.2", 41002};
        constexpr std::uint64_t base = 48'000'000U;
        (void)relay.receive(packet("alice", 0x1111, 0, base - SharedRoomPacketFrames, 100),
                            asio, 10.027, 1'000.027);
        (void)relay.receive(packet("bob", 0x2222, 0, base - SharedRoomPacketFrames, 1'000),
                            shared, 10.028, 1'000.028);

        for (std::uint32_t burst = 0; burst < 20; ++burst) {
            const auto start = 10.030 + burst * burstMs / 1'000.0;
            for (std::uint32_t index = 0; index < packetsPerBurst; ++index) {
                const auto sequence = burst * packetsPerBurst + index + 1U;
                const auto position = base + (sequence - 1U) * SharedRoomPacketFrames;
                const auto at = start + index * 0.0025;
                (void)relay.receive(packet("alice", 0x1111, sequence, position, 100),
                                    asio, at, 1'000.0 + at - 10.0);
            }
            const auto burstAt = start + (burstMs - 1.0) / 1'000.0;
            for (std::uint32_t index = 0; index < packetsPerBurst; ++index) {
                const auto sequence = burst * packetsPerBurst + index + 1U;
                const auto position = base + (sequence - 1U) * SharedRoomPacketFrames;
                (void)relay.receive(packet("bob", 0x2222, sequence, position, 1'000),
                                    shared, burstAt, 1'000.0 + burstAt - 10.0);
            }
        }
        (void)relay.flush(10.030 + 20 * burstMs / 1'000.0 + 0.015,
                          1'000.030 + 20 * burstMs / 1'000.0 + 0.015);

        const auto missing = relay.recipientMetrics("room", "bob").missingContributions;
        const auto received = relay.recipientMetrics("room", "alice").packets;
        expect(missing == 0 && received >= 20 * packetsPerBurst,
               "a bounded capture burst must reach the other singer without losing musical "
               "positions (delay=" + std::to_string(delay) + ", missing=" +
                   std::to_string(missing) + ", received=" + std::to_string(received) + ")");
    }
}

void nativeVoiceRelayStartsANewGenerationAfterABackwardSeek() {
    NativeVoiceRelay relay;
    configureTwoSingerRoom(relay);
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

void nativeVoiceRelayKeepsAMissingStreamExcludedUntilRecovery() {
    NativeVoiceRelay relay;
    configureTwoSingerRoom(relay);
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
           "a missing stream stays excluded throughout a sustained absence");

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
    expect(serverMixPackets(waiting) == 1,
           "the recovered singer is immediately expected in the live mix again");
    auto recovered = relay.receive(
        packet("bob", 0x2222, recoveredIndex, recoveredPosition, 1'000), bob,
        recoveredAt + 0.001, 1'000.001 + recoveredIndex * 0.0025);
    recovered.insert(recovered.end(), waiting.begin(), waiting.end());
    // This health-policy test closes each missing position with deliberately compressed,
    // non-monotonic synthetic receive times. Give the independent cadence pacer enough
    // monotonic time to drain that artificial lead without advancing the musical wall clock.
    auto paced = relay.flush(recoveredAt + 10.0, 1'000.004 + recoveredIndex * 0.0025);
    recovered.insert(recovered.end(), std::make_move_iterator(paced.begin()),
                     std::make_move_iterator(paced.end()));
    const auto recoveredMixPackets = std::ranges::count_if(recovered, [&](const auto& datagram) {
        AudioPacketHeader header{};
        return decodeAudioPacketHeader(datagram.bytes, header) &&
               header.participantKey == NativeVoiceRelay::participantKey("__room_server_mix__") &&
               (header.timestampFrame & ~SharedAudioTimelineFlag) == recoveredPosition;
    });
    expect(recoveredMixPackets == 2,
           "the first complete recovered position is paced and mixed for both recipients");
}

void nativeVoiceRelayRecoveryIgnoresDelayedRedundantPackets() {
    NativeVoiceRelay relay;
    configureTwoSingerRoom(relay);
    relay.setRoomPlayoutDelay("room", 80.0);
    const RelayEndpoint alice{"10.0.0.1", 41001};
    const RelayEndpoint bob{"10.0.0.2", 41002};
    constexpr std::uint64_t base = 48'000'000U;

    for (std::uint32_t index = 0; index <= 240; ++index) {
        const auto position = base + index * SharedRoomPacketFrames;
        const auto at = 10.0 + index * 0.0025;
        const auto wall = 1'000.020 + index * 0.0025;
        (void)relay.receive(packet("alice", 0x1111, index, position, 100), alice, at, wall);
        if (index == 0)
            (void)relay.receive(packet("bob", 0x2222, index, position, 1'000), bob,
                                at + 0.001, wall + 0.001);
    }
    expect(relay.excludedParticipants("room") == 1,
           "a half-second missing singer is excluded before recovery");

    for (std::uint32_t index = 241; index <= 440; ++index) {
        const auto position = base + index * SharedRoomPacketFrames;
        const auto at = 10.0 + index * 0.0025;
        const auto wall = 1'000.020 + index * 0.0025;
        (void)relay.receive(packet("alice", 0x1111, index, position, 100), alice, at, wall);
        (void)relay.receive(packet("bob", 0x2222, index, position, 1'000), bob,
                            at + 0.001, wall + 0.001);
        if (index > 241)
            (void)relay.receive(packet("bob", 0x2222, index - 1,
                                       position - SharedRoomPacketFrames, 1'000),
                                bob, at + 0.0015, wall + 0.0015);
    }
    expect(relay.excludedParticipants("room") == 0,
           "delayed copies of older positions do not break a continuous on-time recovery");

    constexpr std::uint32_t nextIndex = 441;
    const auto nextPosition = base + nextIndex * SharedRoomPacketFrames;
    const auto nextAt = 10.0 + nextIndex * 0.0025;
    const auto nextWall = 1'000.020 + nextIndex * 0.0025;
    auto output = relay.receive(packet("bob", 0x2222, nextIndex, nextPosition, 1'000),
                                bob, nextAt, nextWall);
    auto completed = relay.receive(packet("alice", 0x1111, nextIndex, nextPosition, 100),
                                   alice, nextAt + 0.001, nextWall + 0.001);
    output.insert(output.end(), std::make_move_iterator(completed.begin()),
                  std::make_move_iterator(completed.end()));
    auto paced = relay.flush(nextAt + 0.010, nextWall + 0.010);
    output.insert(output.end(), std::make_move_iterator(paced.begin()),
                  std::make_move_iterator(paced.end()));
    expect(std::ranges::any_of(output, [&](const auto& datagram) {
               AudioPacketHeader header{};
               return datagram.target == alice &&
                      decodeAudioPacketHeader(datagram.bytes, header) &&
                      header.participantKey ==
                          NativeVoiceRelay::participantKey("__room_server_mix__") &&
                      (header.timestampFrame & ~SharedAudioTimelineFlag) == nextPosition &&
                      std::ranges::all_of(samples(datagram.bytes),
                                          [](auto value) { return value == 1'000; });
           }),
           "the next mix-minus contains the recovered singer's voice");
}
} // namespace Tests

namespace Tests {
void nativeVoiceRelayIsolatesRoomsWhoseParticipantsShareAWireKey() {
    // Two participant ids whose 32-bit FNV-1a wire keys collide.
    constexpr std::string_view first = "p2039599";
    constexpr std::string_view second = "p2222382";
    expect(NativeVoiceRelay::participantKey(first) == NativeVoiceRelay::participantKey(second),
           "the test ids collide on the wire key");
    NativeVoiceRelay relay;
    expect(relay.expect("room-a", std::string(first), 0x1111) &&
               relay.expect("room-a", "friend", 0x2222) &&
               relay.expect("room-b", std::string(second), 0x3333),
           "a colliding wire key in another room is a separate session");
    expect(!relay.expect("room-a", std::string(second), 0x4444),
           "a colliding wire key inside one room is refused");
    constexpr std::array<std::string_view, 2> eligible{first, "friend"};
    relay.setEligibleParticipants("room-a", eligible);
    const RelayEndpoint singer{"10.0.0.1", 41001};
    const RelayEndpoint friendEndpoint{"10.0.0.2", 41002};
    const RelayEndpoint stranger{"10.0.0.3", 41003};
    (void)relay.receive(packet(second, 0x3333, 1, 48'000, 9), stranger, 9.9, 0.9);
    (void)relay.receive(packet(first, 0x1111, 1, 48'000, 700), singer, 10.0, 1.0);
    const auto output = relay.receive(packet("friend", 0x2222, 1, 48'000, 5), friendEndpoint,
                                      10.001, 1.001);

    expect(std::ranges::none_of(output, [&](const auto& datagram) {
               return datagram.target == stranger;
           }),
           "a room's mix never reaches a participant of another room");
    expect(std::ranges::all_of(samples(forTarget(output, friendEndpoint).bytes),
                               [](auto value) { return value == 700; }),
           "the room still hears its own singer");
}
} // namespace Tests
