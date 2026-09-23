#include "TestHarness.hpp"
#include "network/AdaptiveJitterBuffer.hpp"
#include "network/NetworkAudioEngine.hpp"
#include "network/NetworkPacket.hpp"
#include "network/OpusCodec.hpp"

#include <cmath>
#include <atomic>
#include <thread>
#include <vector>

namespace Tests {
namespace {
std::vector<std::byte> onePayloadByte() {
    return {std::byte{0}};
}
} // namespace

void opusCodecRoundTripsSpeechLikeSignal() {
    constexpr std::uint32_t sampleRateHz = 48000;
    constexpr std::uint32_t channels = 1;
    constexpr std::uint32_t frames = 240; // 5 ms, the project's packetization interval
    OpusVoiceEncoder encoder(sampleRateHz, channels);
    OpusVoiceDecoder decoder(sampleRateHz, channels);
    std::vector<float> input(frames);
    for (std::uint32_t index = 0; index < frames; ++index)
        input[index] = static_cast<float>(0.4 * std::sin(2.0 * 3.14159265 * 220.0 * index / sampleRateHz));
    const auto encoded = encoder.encode(input, frames);
    const auto decoded = decoder.decode(encoded, frames);
    expect(!encoded.empty(), "Opus encoder produces a non-empty packet");
    expect(decoded.size() == input.size(), "Opus decoder reproduces the frame's sample count");
}

void opusDecoderConcealsALostFrame() {
    constexpr std::uint32_t sampleRateHz = 48000;
    constexpr std::uint32_t channels = 1;
    constexpr std::uint32_t frames = 240;
    OpusVoiceEncoder encoder(sampleRateHz, channels);
    OpusVoiceDecoder decoder(sampleRateHz, channels);
    std::vector<float> input(frames);
    for (std::uint32_t index = 0; index < frames; ++index)
        input[index] = static_cast<float>(0.4 * std::sin(2.0 * 3.14159265 * 220.0 * index / sampleRateHz));
    // Decode two real frames first so the decoder has signal history to conceal from.
    (void)decoder.decode(encoder.encode(input, frames), frames);
    (void)decoder.decode(encoder.encode(input, frames), frames);
    const auto concealed = decoder.conceal(frames);
    expect(concealed.size() == input.size(),
           "Opus packet-loss concealment fills the missing frame instead of leaving it empty");
}

void jitterBufferReordersPackets() {
    AdaptiveJitterBuffer jitter;
    jitter.configure(2, 6);
    jitter.push({2, 0, 1, 1, onePayloadByte()});
    jitter.push({1, 0, 1, 1, onePayloadByte()});
    NetworkAudioPacket packet;
    const auto first =
        jitter.pop(packet) == JitterPopOutcome::Delivered && packet.sequence == 1;
    const auto second =
        jitter.pop(packet) == JitterPopOutcome::Delivered && packet.sequence == 2;
    expect(first && second, "jitter buffer reorders packets by sequence");
}

void jitterBufferReportsLossExplicitly() {
    AdaptiveJitterBuffer jitter;
    jitter.configure(2, 6);
    jitter.push({1, 0, 1, 1, onePayloadByte()});
    jitter.push({3, 0, 1, 1, onePayloadByte()}); // sequence 2 never arrives
    NetworkAudioPacket packet;
    const auto delivered = jitter.pop(packet) == JitterPopOutcome::Delivered && packet.sequence == 1;
    jitter.push({4, 0, 1, 1, onePayloadByte()});
    const auto lost = jitter.pop(packet) == JitterPopOutcome::Lost;
    const auto caughtUp =
        jitter.pop(packet) == JitterPopOutcome::Delivered && packet.sequence == 3;
    expect(delivered && lost && caughtUp,
           "jitter buffer reports a gap as Lost instead of silently skipping it");
}

void jitterBufferWaitsForReorderingWindowBeforeDeclaringLoss() {
    AdaptiveJitterBuffer jitter;
    jitter.configure(2, 6);
    jitter.push({1, 0, 1, 1, onePayloadByte()});
    jitter.push({3, 0, 1, 1, onePayloadByte()});
    NetworkAudioPacket packet;
    expect(jitter.pop(packet) == JitterPopOutcome::Delivered && packet.sequence == 1,
           "jitter buffer starts with the first in-order packet");
    expect(jitter.pop(packet) == JitterPopOutcome::Empty,
           "jitter buffer waits for a missing packet inside its reorder window");
    jitter.push({4, 0, 1, 1, onePayloadByte()});
    expect(jitter.pop(packet) == JitterPopOutcome::Lost,
           "jitter buffer declares loss after the reorder window is full");
}

void jitterBufferIsBounded() {
    AdaptiveJitterBuffer jitter;
    jitter.configure(2, 4);
    for (std::uint32_t sequence = 10; sequence < 20; ++sequence) {
        jitter.push({sequence, 0, 1, 1, onePayloadByte()});
    }
    const auto snapshot = jitter.snapshot();
    expect(snapshot.fillPackets <= snapshot.maximumTargetPackets && snapshot.overflowPackets != 0,
           "jitter buffer is bounded and reports overflow");
}

void remoteParticipantControlsAreIsolated() {
    NetworkAudioEngine network;
    network.prepare(48000, 2, 4800, 240, GenerationId{1});
    expect(network.addRemoteParticipant("alice"), "remote participant added");
    expect(network.setRemoteGain("alice", 0.5F), "participant gain updated");
    expect(network.setRemoteMute("alice", true), "participant mute updated");
    const auto diagnostics = network.diagnostics();
    expect(diagnostics.participants.size() == 1 &&
               diagnostics.participants.front().participantId == "alice" &&
               diagnostics.participants.front().gain == 0.5F &&
               diagnostics.participants.front().muted,
           "participant diagnostics remain isolated");
}

void networkRejectsStaleGeneration() {
    NetworkAudioEngine network;
    network.prepare(48000, 1, 4800, 240, GenerationId{2});
    const std::vector<float> samples(240, 0.1F);
    network.pushLocal(GenerationId{1}, samples, 240);
    expect(network.diagnostics().staleBlocks == 1, "network rejects stale generation work");
}

void networkPacketWireFormatIsStableAndAuthenticated() {
    AudioPacketHeader input{7, 42, 0x123456789abcdef0ULL, 48000, 1, 240};
    const auto bytes = encodeAudioPacketHeader(input);
    AudioPacketHeader output{};
    expect(bytes.size() == AudioPacketHeaderBytes && decodeAudioPacketHeader(bytes, output),
           "network packet header has a fixed validated wire size");
    expect(output.sequence == input.sequence && output.participantKey == input.participantKey &&
               output.sessionToken == input.sessionToken && output.timestampFrame == input.timestampFrame &&
               output.channels == input.channels && output.frames == input.frames,
           "network packet wire format preserves identity, token, timeline and shape");
}

void networkTimelineDoesNotCompareIndependentClientClockOrigins() {
    const auto senderStartedEarlier = alignAudioPacketTimeline(5'000'000, 100, 1440, 240);
    expect(senderStartedEarlier.silenceFrames == 1440 && senderStartedEarlier.skipFrames == 0,
           "a sender's older process clock cannot create seconds of artificial silence");
    const auto receiverStartedEarlier = alignAudioPacketTimeline(100, 5'000'000, 1440, 240);
    expect(receiverStartedEarlier.silenceFrames == 1440 && receiverStartedEarlier.skipFrames == 0,
           "a receiver's older process clock cannot discard the first remote voice packet");
}

void networkRemoteQueueConvergesWithoutMutingOtherSingers() {
    const auto starved = stabilizeRemoteQueue(600, 1440, 240);
    expect(starved.silenceFrames == 2 && starved.skipFrames == 0,
           "a starved peer is delayed gradually instead of repeatedly underrunning");
    const auto bloated = stabilizeRemoteQueue(2160, 1440, 240);
    expect(bloated.silenceFrames == 0 && bloated.skipFrames == 2,
           "an overfilled peer sheds only a small bounded slice of accumulated latency");
    const auto stable = stabilizeRemoteQueue(1500, 1440, 240);
    expect(stable.silenceFrames == 0 && stable.skipFrames == 0,
           "a stable remote singer remains fully audible without timing edits");
}

void networkTimingTracksJitterAndRoundTripDelay() {
    NetworkTimingEstimator timing;
    timing.noteArrival(0, 1'000'000, 48'000);
    timing.noteArrival(240, 1'005'000, 48'000);
    timing.noteArrival(480, 1'018'000, 48'000); // an 8 ms network spike
    timing.noteRoundTrip(80.0F);
    timing.noteRoundTrip(120.0F);

    const auto snapshot = timing.snapshot(1440, 5760, 48'000);
    expect(snapshot.roundTripMs > 80.0F && snapshot.roundTripMs < 120.0F,
           "room voice smooths recurring RTT probes instead of exposing one noisy sample");
    expect(snapshot.interarrivalJitterMs > 0.0F && snapshot.targetDelayFrames > 1440,
           "each remote singer receives an individual playout target when arrival jitter rises");
}

void networkRetimeCorrectionPreservesContinuousVoice() {
    const std::array<float, 4> ramp{0.0F, 0.25F, 0.5F, 0.75F};
    const auto expanded = retimeInterleavedLinear(ramp, 1, 5);
    const auto contracted = retimeInterleavedLinear(ramp, 1, 3);
    expect(expanded.size() == 5 && expanded.front() == ramp.front() &&
               expanded.back() == ramp.back(),
           "starvation correction stretches voice continuously without inserting silence");
    expect(contracted.size() == 3 && contracted.front() == ramp.front() &&
               contracted.back() == ramp.back(),
           "latency correction compresses voice continuously without dropping a hard slice");
}

void roomVoicePlayoutDelayStaysBelowFortyMilliseconds() {
    NetworkAudioEngine network;
    network.prepare(48000, 1, 4800, 240, GenerationId{1});

    expect(network.diagnostics().playoutDelayFrames <= 1920,
           "room voice playout budget stays below forty milliseconds");
}

void remoteParticipantLifecycleIsSafeDuringDiagnostics() {
    NetworkAudioEngine network;
    network.prepare(48000, 1, 4800, 240, GenerationId{1});
    std::atomic<bool> done{false};
    std::atomic<bool> valid{true};
    std::thread writer([&] {
        for (int index = 0; index < 20000; ++index) {
            const std::string id = "participant-" + std::to_string(index);
            if (!network.addRemoteParticipant(id)) {
                valid.store(false, std::memory_order_relaxed);
                break;
            }
            (void)network.removeRemoteParticipant(id);
        }
        done.store(true, std::memory_order_release);
    });
    std::thread reader([&] {
        while (!done.load(std::memory_order_acquire)) {
            for (const auto& participant : network.diagnostics().participants) {
                if (!participant.participantId.starts_with("participant-"))
                    valid.store(false, std::memory_order_relaxed);
            }
        }
    });
    writer.join();
    reader.join();
    expect(valid.load(std::memory_order_relaxed),
           "remote participant lifecycle is serialized with diagnostics reads");
}
} // namespace Tests
