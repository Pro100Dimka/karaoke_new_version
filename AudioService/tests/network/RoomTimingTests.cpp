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
constexpr std::uint64_t Base = 48'000'000U; // position of wall second 1'000 on the timeline
constexpr double Wall = 1'000.0;
constexpr double Monotonic = 10.0;
constexpr std::uint32_t FramesPerMillisecond = VoiceProtocolSampleRateHz / 1'000U;

std::vector<std::byte> voice(std::string_view participant, std::uint64_t token,
                             std::uint32_t sequence, std::uint64_t position, std::int16_t sample) {
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
        result.push_back(
            static_cast<std::byte>((static_cast<std::uint16_t>(sample) >> 8U) & 0xFFU));
    }
    return result;
}

const RelayDatagram* mixFor(const std::vector<RelayDatagram>& output, const RelayEndpoint& target) {
    const auto found = std::ranges::find_if(output, [&](const auto& value) {
        AudioPacketHeader header{};
        return value.target == target && decodeAudioPacketHeader(value.bytes, header) &&
               (header.timestampFrame & ~SharedAudioTimelineFlag) == Base;
    });
    return found == output.end() ? nullptr : &*found;
}

std::int16_t firstSample(const RelayDatagram& datagram) {
    const auto low = std::to_integer<std::uint16_t>(datagram.bytes[AudioPacketHeaderBytes]);
    const auto high = std::to_integer<std::uint16_t>(datagram.bytes[AudioPacketHeaderBytes + 1]);
    return static_cast<std::int16_t>(low | (high << 8U));
}

ServerMixStageReport stageOf(const RelayDatagram& datagram) {
    AudioPacketHeader header{};
    (void)decodeAudioPacketHeader(datagram.bytes, header);
    return decodeServerMixStageReport(header.reportedParticipantKey |
                                      (static_cast<std::uint32_t>(header.reportedLossPermille) << 24U));
}

const RelayEndpoint Alice{"10.0.0.1", 41001};
const RelayEndpoint Bob{"10.0.0.2", 41002};

struct Arrivals {
    std::vector<RelayDatagram> atAlice; // sent when Alice's packet arrived
    std::vector<RelayDatagram> atBob;   // sent when Bob's packet arrived
};

/** Alice reaches the relay 1 ms after the position and Bob 6 ms after it. */
Arrivals bobSixMillisecondsLate(NativeVoiceRelay& relay) {
    relay.expect("room", "alice", 0x1111);
    relay.expect("room", "bob", 0x2222);
    constexpr std::array<std::string_view, 2> eligible{"alice", "bob"};
    relay.setEligibleParticipants("room", eligible);
    const auto previous = Base - SharedRoomPacketFrames;
    (void)relay.receive(voice("alice", 0x1111, 1, previous, 1), Alice, Monotonic - 0.0025,
                        Wall - 0.0025);
    (void)relay.receive(voice("bob", 0x2222, 1, previous, 2), Bob, Monotonic - 0.002, Wall - 0.002);
    auto atAlice = relay.receive(voice("alice", 0x1111, 2, Base, 100), Alice, Monotonic + 0.001,
                                 Wall + 0.001);
    auto atBob = relay.receive(voice("bob", 0x2222, 2, Base, 1'000), Bob, Monotonic + 0.006,
                               Wall + 0.006);
    return {std::move(atAlice), std::move(atBob)};
}
} // namespace

namespace Tests {
void roomRelayClosesEachPositionByTheMeasuredReturnReserve() {
    NativeVoiceRelay legacy;
    legacy.setRoomPlayoutDelay("room", 12.5); // the fixed 10 ms reserve, before measurement
    const auto legacyOutput = bobSixMillisecondsLate(legacy);
    const auto* legacyMix = mixFor(legacyOutput.atBob, Alice);
    expect(legacyMix != nullptr && firstSample(*legacyMix) == 0,
           "with the fixed 10 ms reserve the position closed 2.5 ms after it, so Bob's voice "
           "6 ms later was lost although Alice's fast return route did not need the time");

    NativeVoiceRelay measured;
    measured.setRoomPlayoutDelay("room", 12.5, 3.0); // fast measured return routes
    const auto output = bobSixMillisecondsLate(measured);
    const auto* toAlice = mixFor(output.atBob, Alice);
    const auto* toBob = mixFor(output.atAlice, Bob);
    expect(toAlice != nullptr && firstSample(*toAlice) == 1'000 && toBob != nullptr &&
               firstSample(*toBob) == 100,
           "with the measured 3 ms reserve the position stays open until 9.5 ms and both voices "
           "make the mix");

    const auto aliceStage = stageOf(*toAlice);
    const auto bobStage = stageOf(*toBob);
    expect(aliceStage.ingressFrames == 6U * FramesPerMillisecond &&
               aliceStage.collectionFrames == 0U,
           "the mix tells its listener that its latest voice reached the relay 6 ms late");
    expect(bobStage.ingressFrames == FramesPerMillisecond && bobStage.collectionFrames == 0U,
           "a mix sent as soon as its voices are complete reports no relay wait");

    const auto slack = measured.recipientMetrics("room", "bob").ingressSlack;
    const auto legacySlack = legacy.recipientMetrics("room", "bob").ingressSlack;
    expect(slack.negativePackets == 0U && legacySlack.negativePackets == 1U &&
               legacySlack.minimumMs < -3.0 && slack.minimumMs > 3.0,
           "deadline slack shows Bob 3.5 ms early under the measured reserve and 3.5 ms late "
           "under the fixed one");
}

void roomRelayReservesASlowReturnRouteBeforeTheDeadline() {
    NativeVoiceRelay relay;
    relay.setRoomPlayoutDelay("room", 50.0, 21.0);
    relay.expect("room", "alice", 0x1111);
    relay.expect("room", "bob", 0x2222);
    constexpr std::array<std::string_view, 2> eligible{"alice", "bob"};
    relay.setEligibleParticipants("room", eligible);
    (void)relay.receive(voice("alice", 0x1111, 1, Base, 100), Alice, Monotonic + 0.001,
                        Wall + 0.001);
    expect(relay.flush(Monotonic + 0.0285, Wall + 0.0285).empty(),
           "the position stays open until 29 ms (50 ms deadline minus a 21 ms return route)");
    const auto closed = relay.flush(Monotonic + 0.0295, Wall + 0.0295);
    const auto* toAlice = mixFor(closed, Alice);
    expect(toAlice != nullptr,
           "and closes in time for the slow listener's return route instead of 10 ms before");
    const auto stage = stageOf(*toAlice);
    expect(stage.ingressFrames == 0U &&
               stage.collectionFrames == static_cast<std::uint32_t>(29.5 * FramesPerMillisecond),
           "a mix closed without its other voices reports the relay's whole wait");
}

void roomReturnRouteExcludesTheRelaysWaitSoTheDeadlineCannotFeedBack() {
    // A listener's mix arrives 3 ms after leaving the relay. Whatever the room's deadline, the
    // relay's wait grows with it and the arrival lateness grows by exactly as much.
    constexpr std::int64_t ingress = 5 * FramesPerMillisecond;
    constexpr std::int64_t returnRoute = 3 * FramesPerMillisecond;
    for (const auto waitMilliseconds : {0, 10, 30, 70}) {
        const auto wait = static_cast<std::int64_t>(waitMilliseconds) * FramesPerMillisecond;
        const ServerMixStageReport stage{static_cast<std::uint32_t>(ingress),
                                         static_cast<std::uint32_t>(wait)};
        expect(returnRouteLatenessFrames(ingress + wait + returnRoute, stage) == returnRoute,
               "a larger deadline (a longer relay wait) leaves the measured return route as is");
    }
    expect(!returnRouteLatenessFrames(12 * FramesPerMillisecond, ServerMixStageReport{}),
           "a relay that reports no stages yields no return measurement, never the whole lateness");
}

void roomReturnRequirementIgnoresARareBurstButFollowsRepeatedDelay() {
    constexpr std::int32_t fast = 3 * FramesPerMillisecond;
    VoiceLatenessTracker returnRoute;
    for (std::uint32_t packet = 0; packet < VoiceLatenessTracker::WindowPackets; ++packet)
        returnRoute.note(packet >= 6'000U && packet < 6'040U ? 150 * FramesPerMillisecond : fast);
    expect(returnRoute.targetFrames() == fast + VoiceLatenessTracker::BinFrames,
           "one 100 ms burst of a Windows stall does not become the return requirement");

    constexpr std::int32_t slow = 15 * FramesPerMillisecond;
    for (std::uint32_t packet = 0; packet < VoiceLatenessTracker::WindowPackets; ++packet)
        returnRoute.note(packet % 25U == 0U ? slow : fast); // 4% of packets, all the time
    expect(returnRoute.targetFrames() == slow + VoiceLatenessTracker::BinFrames &&
               returnRoute.medianFrames() == fast + VoiceLatenessTracker::BinFrames,
           "a return delay that keeps recurring raises the requirement; the median stays fast");

    for (std::uint32_t packet = 0; packet < VoiceLatenessTracker::WindowPackets; ++packet)
        returnRoute.note(fast);
    expect(returnRoute.targetFrames() == fast + VoiceLatenessTracker::BinFrames,
           "the requirement comes back down once the delays leave the 30 s window");
}
} // namespace Tests
