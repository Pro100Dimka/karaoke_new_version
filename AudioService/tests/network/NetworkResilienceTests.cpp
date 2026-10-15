#include "TestHarness.hpp"
#include "network/AdaptiveJitterBuffer.hpp"
#include "network/NetworkAudioEngine.hpp"
#include "network/NetworkPacket.hpp"
#include "network/PcmVoiceCodec.hpp"
#include "relay/NativeVoiceRelay.hpp"

#include <array>
#include <chrono>
#include <cmath>
#include <cstdint>
#include <limits>
#include <thread>
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
    const auto beforeWrap =
        jitter.pop(packet) == JitterPopOutcome::Delivered && packet.sequence == last;
    const auto afterWrap =
        jitter.pop(packet) == JitterPopOutcome::Delivered && packet.sequence == 0;
    expect(beforeWrap && afterWrap,
           "jitter order remains continuous when the 32-bit packet sequence wraps");
}

void jitterBufferRebasesAfterLongOutage() {
    AdaptiveJitterBuffer jitter;
    jitter.configure(2, 12);
    jitter.push({1, 0, 1, 1, markerPayload()});
    jitter.push({2, 1, 1, 1, markerPayload()});
    NetworkAudioPacket packet;
    (void)jitter.pop(packet);
    (void)jitter.pop(packet);
    jitter.push({2'003, 2'003, 1, 1, markerPayload()});
    jitter.push({2'004, 2'004, 1, 1, markerPayload()});
    expect(jitter.pop(packet) == JitterPopOutcome::Delivered && packet.sequence == 2'003,
           "a long outage rebases at the live packet instead of synthesizing ten seconds of PLC");
    expect(jitter.snapshot().lostPackets == 2'000,
           "the skipped outage remains visible in packet-loss diagnostics");
}

void sharedJitterKeepsReorderedVoiceUntilItsPresentationDeadline() {
    constexpr std::uint32_t Frames = 120, Target = 55U * 48U;
    AdaptiveJitterBuffer jitter;
    jitter.configure(4, 24);
    const auto push = [&](std::uint32_t sequence) {
        jitter.push({sequence, SharedAudioTimelineFlag | (sequence * Frames), 1, Frames,
                     markerPayload(), VoiceCodec::Pcm16});
    };
    NetworkAudioPacket packet;
    for (std::uint32_t sequence = 0; sequence < 4; ++sequence)
        push(sequence);
    for (std::uint32_t sequence = 0; sequence < 4; ++sequence)
        expect(jitter.pop(packet, 38U * 48U, Target) == JitterPopOutcome::Delivered &&
                   packet.sequence == sequence,
               "ordinary shared voice is decoded without an additional reorder delay");

    // Sequence 4 is due at 65 ms. Four newer packets arrive by 50 ms, so the legacy
    // count-only window commits loss even though the missing packet still has 15 ms to arrive.
    constexpr std::array arrivals{42'500U, 45'000U, 47'500U, 50'000U};
    for (std::uint32_t index = 0; index < arrivals.size(); ++index) {
        push(index + 5U);
        const auto horizon = scaleFramePosition(arrivals[index], 1'000'000, 48'000);
        expect(jitter.pop(packet, horizon, Target) == JitterPopOutcome::Empty,
               "a full reorder window cannot discard shared voice before its presentation time");
    }
    push(4);
    for (std::uint32_t sequence = 4; sequence <= 8; ++sequence)
        expect(jitter.pop(packet, 52'500U * 48U / 1'000U, Target) ==
                       JitterPopOutcome::Delivered &&
                   packet.sequence == sequence,
               "a packet arriving at 52.5 ms is retained before its 65 ms deadline");
    const auto diagnostics = jitter.snapshot();
    expect(diagnostics.lostPackets == 0 && diagnostics.latePackets == 0,
           "timely reordered voice is neither reported lost nor rejected late");
}

void sharedJitterLossCarriesItsMissingMusicalPosition() {
    constexpr std::uint32_t Frames = 120, Target = 55U * 48U;
    struct Origin {
        std::uint32_t sequence;
        std::uint64_t frame;
    };
    constexpr std::array origins{Origin{0, 0},
                                 Origin{UINT32_MAX - 3U, MediaTimelineMask - 600U}};
    for (const auto origin : origins) {
        AdaptiveJitterBuffer jitter;
        jitter.configure(4, 24);
        const auto timestamp = [&](std::uint32_t offset) {
            return addMediaTimelineFrames(origin.frame, offset * Frames);
        };
        const auto push = [&](std::uint32_t offset) {
            jitter.push({origin.sequence + offset,
                         SharedAudioTimelineFlag | timestamp(offset), 1, Frames,
                         markerPayload(), VoiceCodec::Pcm16});
        };
        NetworkAudioPacket packet;
        for (std::uint32_t offset = 0; offset < 4; ++offset)
            push(offset);
        for (std::uint32_t offset = 0; offset < 4; ++offset)
            (void)jitter.pop(packet);
        push(6); // Sequences 4 and 5 never arrive before their musical position.
        const auto due = addMediaTimelineFrames(timestamp(4), Target);
        struct Step {
            std::uint64_t horizon;
            JitterPopOutcome outcome;
            std::uint32_t offset;
        };
        const std::array steps{
            Step{addMediaTimelineFrames(due, MediaTimelineMask), JitterPopOutcome::Empty, 0},
            Step{due, JitterPopOutcome::Lost, 4},
            Step{due, JitterPopOutcome::Empty, 0},
            Step{addMediaTimelineFrames(due, Frames), JitterPopOutcome::Lost, 5},
            Step{addMediaTimelineFrames(due, Frames), JitterPopOutcome::Delivered, 6},
        };
        for (const auto& step : steps) {
            const auto outcome = jitter.pop(packet, step.horizon, Target);
            expect(outcome == step.outcome,
                   "shared loss is released at its presentation horizon, including timestamp wrap");
            if (step.outcome == JitterPopOutcome::Empty)
                continue;
            expect(packet.sequence == origin.sequence + step.offset &&
                       packet.timestampFrame == (SharedAudioTimelineFlag | timestamp(step.offset)) &&
                       packet.channels == 1 && packet.frames == Frames &&
                       packet.codec == VoiceCodec::Pcm16 &&
                       packet.payload.empty() == (step.outcome == JitterPopOutcome::Lost),
                   "concealment retains the missing sequence, shared timestamp and audio format");
        }
        push(4); // The original PCM must not be replayed after loss has been committed.
        expect(jitter.pop(packet, addMediaTimelineFrames(due, Frames), Target) ==
                       JitterPopOutcome::Empty &&
                   jitter.snapshot().lostPackets == 2 && jitter.snapshot().latePackets == 1,
               "an expired original packet cannot move old PCM to a later musical position");
    }
}

void sharedJitterDeadlineWaitRemainsBounded() {
    constexpr std::uint32_t Frames = 120, Target = 55U * 48U;
    AdaptiveJitterBuffer jitter;
    jitter.configure(4, 8);
    const auto push = [&](std::uint32_t sequence) {
        jitter.push({sequence, SharedAudioTimelineFlag | (sequence * Frames), 1, Frames,
                     markerPayload()});
    };
    NetworkAudioPacket packet;
    for (std::uint32_t sequence = 0; sequence < 4; ++sequence)
        push(sequence);
    for (std::uint32_t sequence = 0; sequence < 4; ++sequence)
        (void)jitter.pop(packet);
    for (std::uint32_t sequence = 5; sequence <= 16; ++sequence) {
        push(sequence);
        expect(jitter.pop(packet, 50U * 48U, Target) == JitterPopOutcome::Empty,
               "deadline wait retains an unexpired missing position despite future arrivals");
    }
    const auto full = jitter.snapshot();
    expect(full.fillPackets == 8 && full.overflowPackets == 4,
           "presentation-aware waiting keeps the original bounded encoded packet capacity");
    push(4);
    for (std::uint32_t sequence = 4; sequence <= 11; ++sequence)
        expect(jitter.pop(packet, 52'500U * 48U / 1'000U, Target) ==
                       JitterPopOutcome::Delivered &&
                   packet.sequence == sequence,
               "overflow preserves the closest future voice and admits the timely missing packet");
}

void sharedTimelineTimestampRemainsOrderedAcrossWrap() {
    const auto almostMaximum = MediaTimelineMask - 100U;
    const auto alignment = alignSharedAudioTimeline(almostMaximum, almostMaximum - 50U, 1'440U);
    expect(alignment.silenceFrames == 1'490U && alignment.skipFrames == 0,
           "a very long session keeps its playout timestamp ordered across modular wrap");
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
    expect(network.addRemoteParticipant("singer-a") && network.addRemoteParticipant("singer-b"),
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
    expect(diagnostics.participants.size() == 1 && diagnostics.participants.front().gain == 1.0F &&
               diagnostics.participants.front().latePackets == 0 &&
               diagnostics.participants.front().decodeUnderruns == 0,
           "rejoin resumes at the current room timeline without stale gain or jitter state");
}

void roomVoicePacketizationSupportsSystemRatesAndBuffers() {
    constexpr std::array rates{44'100U, 48'000U, 96'000U};
    constexpr std::array buffers{64U, 128U, 256U, 512U, 1'024U};
    for (const auto rate : rates) {
        std::uint64_t frames = 0;
        for (std::uint64_t packet = 0; packet < VoicePacketsPerSecond; ++packet)
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

void roomVoiceSurvivesRepeatedDriverFormatSwitches() {
    struct Format {
        std::uint32_t sampleRate;
        std::uint32_t bufferFrames;
    };
    // These represent the runtime plans produced by Shared, Exclusive and ASIO backends. The
    // network layer must not retain a hard-coded device rate or lose room state between them.
    constexpr std::array formats{Format{48'000, 480}, Format{44'100, 128}, Format{96'000, 512},
                                 Format{48'000, 256}, Format{44'100, 220}, Format{96'000, 1'024}};
    NetworkAudioEngine network;
    network.prepare(formats.front().sampleRate, 2, formats.front().sampleRate / 2U,
                    formats.front().bufferFrames, GenerationId{1});
    network.setSharedTimeline(true);
    network.setLocalParticipant("switching-host");
    network.setSessionToken(0x123456789abcdef0ULL);
    expect(network.addRemoteParticipant("remote-singer"),
           "room participant joins before driver switching");
    expect(network.setRemoteGain("remote-singer", 0.42F),
           "per-participant mixer state is configured before driver switching");
    network.startReceive(0);
    network.startSend("127.0.0.1", 9);

    constexpr std::size_t transitions = 1'000;
    for (std::size_t index = 1; index <= transitions; ++index) {
        const auto format = formats[index % formats.size()];
        if (index % 37U == 0U) {
            expect(network.removeRemoteParticipant("remote-singer"),
                   "accelerated reconnect removes the old remote slot");
            expect(network.addRemoteParticipant("remote-singer"),
                   "accelerated reconnect recreates one current remote slot");
            expect(network.setRemoteGain("remote-singer", 0.42F),
                   "accelerated reconnect restores the personal mix");
        }
        network.prepare(format.sampleRate, 2, format.sampleRate / 2U, format.bufferFrames,
                        GenerationId{index + 1U});
        const auto diagnostics = network.diagnostics();
        expect(diagnostics.transportRunning && diagnostics.sendEnabled &&
                   diagnostics.sharedTimeline && diagnostics.participants.size() == 1 &&
                   diagnostics.participants.front().participantId == "remote-singer" &&
                   diagnostics.participants.front().gain == 0.42F,
               "one thousand Shared, Exclusive and ASIO recreations/reconnects keep one current "
               "room graph without retained participants");
    }
    network.stop();
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
