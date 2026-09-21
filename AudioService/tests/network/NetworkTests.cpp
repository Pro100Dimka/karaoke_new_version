#include "TestHarness.hpp"
#include "network/AdaptiveJitterBuffer.hpp"
#include "network/NetworkAudioEngine.hpp"
#include "network/Pcm16Codec.hpp"

#include <cmath>
#include <vector>

namespace Tests {
void pcmCodecKeepsSampleCount() {
    Pcm16Codec codec;
    const std::vector<float> input{-1.0F, -0.25F, 0.25F, 1.0F};
    const auto decoded = codec.decode(codec.encode(input));
    expect(decoded.size() == input.size(), "PCM codec keeps sample count");
}

void pcmCodecQuantizationIsBounded() {
    Pcm16Codec codec;
    const std::vector<float> input{-1.0F, -0.25F, 0.25F, 1.0F};
    const auto decoded = codec.decode(codec.encode(input));
    expect(std::abs(decoded[1] - input[1]) < 0.001F, "PCM codec quantization bounded");
}

void jitterBufferReordersPackets() {
    AdaptiveJitterBuffer jitter;
    jitter.configure(2, 6);
    jitter.push({2, 0, 1, {2.0F}});
    jitter.push({1, 0, 1, {1.0F}});
    NetworkAudioPacket packet;
    const auto first = jitter.pop(packet) && packet.sequence == 1;
    const auto second = jitter.pop(packet) && packet.sequence == 2;
    expect(first && second, "jitter buffer reorders packets by sequence");
}

void jitterBufferIsBounded() {
    AdaptiveJitterBuffer jitter;
    jitter.configure(2, 4);
    for (std::uint32_t sequence = 10; sequence < 20; ++sequence) {
        jitter.push({sequence, 0, 1, {static_cast<float>(sequence)}});
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
} // namespace Tests
