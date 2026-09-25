#include "TestHarness.hpp"
#include "network/AdaptiveJitterBuffer.hpp"
#include "network/NetworkAudioEngine.hpp"
#include "network/NetworkPacket.hpp"
#include "app/AudioService.hpp"
#include "backend/fake/FakeAudioBackend.hpp"
#include "network/OpusCodec.hpp"
#include "network/UdpSocket.hpp"

#include <cmath>
#include <atomic>
#include <thread>
#include <vector>

struct NetworkTestAccess {
    static bool queueVoice(NetworkAudioEngine& engine, std::string_view participant,
                           std::span<const float> samples) {
        auto* slot = engine.slotForId(participant);
        return slot && slot->queue.push(samples, static_cast<std::uint32_t>(samples.size()));
    }
};

namespace Tests {
void leavingRoomReclaimsEveryRemoteParticipant() {
    AudioService service{std::make_unique<FakeAudioBackend>()};
    service.start();
    (void)service.session().prepare({});
    for (std::size_t cycle = 0; cycle <= MaxRemoteParticipants; ++cycle) {
        expect(service.network().addRemoteParticipant("guest-" + std::to_string(cycle)),
               "repeated room visits retain participant capacity");
        expect(service.handleLine("1|LeaveMediaSession").status == ControlStatus::Ok,
               "leaving a room succeeds");
        expect(service.network().diagnostics().participants.empty(),
               "departed room participants and DSP must not survive the room lifecycle");
    }
}

void remoteSlotReuseStartsWithFreshEffects() {
    NetworkAudioEngine reused, fresh;
    for (auto* engine : {&reused, &fresh})
        engine->prepare(48000, 1, 8192, 240, GenerationId{1});
    expect(reused.addRemoteParticipant("old"), "old participant joins");
    const std::array effects{"reverb", "echo", "delay", "noiseSuppression", "octave"};
    for (const auto effect : effects)
        expect(reused.setRemoteEffect("old", effect, 1.0F), "old participant enables effects");
    expect(reused.removeRemoteParticipant("old"), "old participant leaves");
    expect(reused.addRemoteParticipant("new") && fresh.addRemoteParticipant("new"),
           "fresh participant joins both routes");
    std::vector<float> signal(4096), actual(signal.size()), expected(signal.size());
    for (std::size_t frame = 0; frame < signal.size(); ++frame)
        signal[frame] = static_cast<float>(0.1 * std::sin(frame * 0.07));
    expect(NetworkTestAccess::queueVoice(reused, "new", signal) &&
               NetworkTestAccess::queueVoice(fresh, "new", signal), "decoded voice is queued");
    (void)reused.renderRemote(GenerationId{1}, actual, 4096);
    (void)fresh.renderRemote(GenerationId{1}, expected, 4096);
    expect(actual == expected, "a newly joined voice must not inherit departed participant DSP");
}

void outgoingVoiceUsesTheInternalClockAndMicrophoneGate() {
    for (const bool microphoneEnabled : {true, false}) {
        UdpSocket receiver;
        receiver.bind(0);
        receiver.setReceiveTimeoutMs(100);
        FakeBackendSettings settings;
        settings.runtime.inputSampleRateHz = 24000;
        settings.runtime.inputPeriodFrames = 240;
        settings.runtime.outputPeriodFrames = 480;
        settings.runtime.clockRelationship = ClockRelationship::Independent;
        auto backend = std::make_unique<FakeAudioBackend>(settings);
        auto* fake = backend.get();
        AudioService service{std::move(backend)};
        service.start();
        service.session().prepare(RequestedConfiguration{});
        service.session().start();
        service.realtime().setMicrophoneEnabled(microphoneEnabled);
        service.realtime().setMixerGains(MixerGains{.microphone = 0.125F});
        service.network().startSend("127.0.0.1", receiver.localPort());
        OpusVoiceDecoder decoder(48000, 1);
        std::vector<float> capture(240), render(960);
        std::array<std::byte, 4096> packet{};
        std::uint32_t receivedFrames = 0;
        float peak = 0.0F;
        for (std::int64_t block = 0; block < 8; ++block) {
            for (std::size_t frame = 0; frame < capture.size(); ++frame)
                capture[frame] = static_cast<float>(0.3 * std::sin(
                    2.0 * 3.14159265 * 440.0 * static_cast<double>(block * 240 + frame) / 24000.0));
            fake->pump(capture, 1, render, 2, block * 240, block * 480);
            for (int part = 0; part < 2; ++part) {
                const auto bytes = receiver.receive(packet);
                if (bytes <= AudioPacketHeaderBytes)
                    continue;
                const auto decoded = decoder.decode(
                    std::span<const std::byte>{packet}.subspan(AudioPacketHeaderBytes,
                                                               bytes - AudioPacketHeaderBytes), 240);
                receivedFrames += static_cast<std::uint32_t>(decoded.size());
                for (const auto sample : decoded)
                    peak = std::max(peak, std::abs(sample));
            }
        }
        service.network().stop();
        expect(receivedFrames == 8U * 480U,
               "network voice duration follows the output/internal clock after input conversion");
        expect(microphoneEnabled ? (peak > 0.01F && peak < 0.08F) : peak < 0.0001F,
               "the microphone gate controls actual encoded outgoing PCM");
    }
}

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

void remoteParticipantEffectsAreIsolated() {
    NetworkAudioEngine network;
    network.prepare(48000, 2, 4800, 240, GenerationId{1});
    expect(network.addRemoteParticipant("alice") && network.addRemoteParticipant("bob"),
           "remote participants added");
    expect(network.setRemoteEffect("alice", "reverb", 0.6F) &&
               network.setRemoteEffect("alice", "echo", 0.4F) &&
               network.setRemoteEffect("alice", "delay", 0.3F) &&
               network.setRemoteEffect("alice", "noiseSuppression", 1.0F) &&
               network.setRemoteEffect("alice", "octave", -1.0F),
           "participant effects accepted");
    const auto diagnostics = network.diagnostics();
    const auto& alice = diagnostics.participants.front();
    const auto& bob = diagnostics.participants.back();
    expect(alice.reverb == 0.6F && alice.echo == 0.4F && alice.delay == 0.3F &&
               alice.noiseSuppression && alice.octave == -1.0F && bob.reverb == 0.0F,
           "participant effects remain isolated");
}

void networkRejectsStaleGeneration() {
    NetworkAudioEngine network;
    network.prepare(48000, 1, 4800, 240, GenerationId{2});
    const std::vector<float> samples(240, 0.1F);
    network.pushLocal(GenerationId{1}, samples, 240);
    expect(network.diagnostics().staleBlocks == 1, "network rejects stale generation work");
}

void networkAcceptsMultichannelDeviceAudio() {
    NetworkAudioEngine network;
    bool prepared = true;
    try {
        // ASIO and surround endpoints commonly expose more than two render channels. Voice transport
        // still has to initialize because the microphone is encoded as one centred mono stream.
        network.prepare(48000, 6, 4800, 240, GenerationId{1});
    } catch (...) {
        prepared = false;
    }
    expect(prepared, "multichannel device audio is folded to an Opus-compatible voice stream");
}

void networkPreparationDoesNotRequireOpusCompatibleDeviceRate() {
    NetworkAudioEngine network;
    bool prepared = true;
    try {
        // Monitoring and solo karaoke do not use network voice. A 44.1 kHz endpoint must therefore
        // be allowed to start even though Opus itself accepts only a fixed set of rates.
        network.prepare(44100, 2, 4410, 220, GenerationId{1});
    } catch (...) {
        prepared = false;
    }
    expect(prepared, "local audio preparation does not create an unused Opus encoder");
}

void roomVoiceStartsAt44100DeviceRate() {
    NetworkAudioEngine network;
    network.prepare(44'100, 2, 4'410, 220, GenerationId{1});
    bool started = true;
    try {
        network.startReceive(0);
        network.startSend("127.0.0.1", 9);
        started = network.addRemoteParticipant("remote-44k");
        const std::vector<float> stereoDeviceBlock(220U * 2U, 0.1F);
        network.pushLocal(GenerationId{1}, stereoDeviceBlock, 220, 0);
        started = started && network.diagnostics().droppedSendBlocks == 0;
    } catch (...) {
        started = false;
    }
    network.stop();
    expect(started,
           "room voice converts a 44.1 kHz system stream to an Opus-compatible transport rate");
}

void roomVoiceFractionalPacketsDoNotDriftAt44100() {
    std::uint64_t totalFrames = 0;
    bool saw220 = false;
    bool saw221 = false;
    for (std::uint64_t packet = 0; packet < 200; ++packet) {
        const auto frames = deviceFramesForVoicePacket(packet, 44'100);
        totalFrames += frames;
        saw220 = saw220 || frames == 220;
        saw221 = saw221 || frames == 221;
    }
    expect(totalFrames == 44'100 && saw220 && saw221,
           "44.1 kHz room voice alternates 220/221-frame packets without long-term drift");
}

void roomVoiceSharedDelayAdaptsWithoutJumps() {
    expect(adaptSharedCompensationFrames(1'440, 2'400, 1'440, 3'840, 240) == 1'680,
           "room voice adds at most one packet when network delay rises");
    expect(adaptSharedCompensationFrames(2'400, 1'440, 1'440, 3'840, 240) == 2'370,
           "room voice removes excess latency slowly after the network stabilizes");
    expect(adaptSharedCompensationFrames(1'600, 1'650, 1'440, 3'840, 240) == 1'600,
           "room voice ignores jitter changes inside the playout hysteresis window");
}

void roomVoiceTwoComputerSimulationSurvivesAsymmetricDelay() {
    constexpr std::uint32_t rate = 48'000;
    constexpr std::uint32_t packet = 240;
    constexpr std::uint32_t minimumDelay = 1'440;
    constexpr std::uint32_t simulatedQueue = rate / 2U;
    constexpr std::array jitterMilliseconds{0, 4, -3, 9, -6, 2, 13, -8};
    struct SimulatedComputer {
        std::uint32_t baseDelayMilliseconds;
        std::int32_t driftPartsPerMillion;
        NetworkTimingEstimator timing;
        std::uint32_t desiredFrames{minimumDelay};
    };
    std::array computers{SimulatedComputer{24, 85}, SimulatedComputer{95, -70}};
    auto sharedDelay = minimumDelay;
    std::uint32_t audibleUnderflows = 0;
    std::uint32_t checkedPackets = 0;

    for (std::uint32_t sequence = 0; sequence < 12'000; ++sequence) {
        if (sequence % 97U == 0U)
            continue; // deterministic 1% packet loss; Opus PLC covers the missing packet.
        for (std::size_t index = 0; index < computers.size(); ++index) {
            auto& computer = computers[index];
            const auto jitterIndex = (sequence + static_cast<std::uint32_t>(index) * 3U) %
                                     jitterMilliseconds.size();
            const auto delayMilliseconds = static_cast<std::int32_t>(computer.baseDelayMilliseconds) +
                                           jitterMilliseconds[jitterIndex];
            const auto senderFrame = static_cast<std::uint64_t>(sequence) * packet;
            const auto driftedSenderFrame = static_cast<std::uint64_t>(std::llround(
                static_cast<double>(senderFrame) *
                (1.0 + static_cast<double>(computer.driftPartsPerMillion) / 1'000'000.0)));
            const auto arrivalMicros =
                driftedSenderFrame * 1'000'000ULL / rate +
                static_cast<std::uint64_t>(delayMilliseconds) * 1'000ULL;
            computer.timing.noteArrival(driftedSenderFrame, arrivalMicros, rate);
            const auto jitterTarget =
                computer.timing.snapshot(minimumDelay, simulatedQueue / 2U, rate)
                    .targetDelayFrames;
            const auto routeFrames = static_cast<std::uint32_t>(delayMilliseconds) * rate / 1'000U;
            computer.desiredFrames = std::max(routeFrames + jitterTarget, minimumDelay);
        }
        const auto desiredShared = std::max(computers[0].desiredFrames,
                                            computers[1].desiredFrames);
        const auto previous = sharedDelay;
        sharedDelay = adaptSharedCompensationFrames(
            previous, desiredShared, minimumDelay,
            maximumRoomCompensationFrames(simulatedQueue, packet), packet);
        expect(sharedDelay <= previous + packet,
               "two-computer simulation bounds every shared-delay increase to one packet");
        if (sequence > 400U) {
            ++checkedPackets;
            const auto slowRouteFrames = computers[1].baseDelayMilliseconds * rate / 1'000U;
            if (sharedDelay < slowRouteFrames)
                ++audibleUnderflows;
        }
    }

    expect(checkedPackets != 0 && audibleUnderflows * 100U <= checkedPackets,
           "two-computer simulation keeps the slower remote singer buffered despite jitter, loss and clock drift");
}

void networkPacketWireFormatIsStableAndAuthenticated() {
    AudioPacketHeader input{7, 42, 0x123456789abcdef0ULL, 48000, 1, 240, 8'640, 123};
    const auto bytes = encodeAudioPacketHeader(input);
    AudioPacketHeader output{};
    expect(bytes.size() == AudioPacketHeaderBytes && decodeAudioPacketHeader(bytes, output),
           "network packet header has a fixed validated wire size");
    expect(output.sequence == input.sequence && output.participantKey == input.participantKey &&
               output.sessionToken == input.sessionToken && output.timestampFrame == input.timestampFrame &&
               output.channels == input.channels && output.frames == input.frames &&
               output.sharedTargetDelayFrames == input.sharedTargetDelayFrames &&
               output.streamEpoch == input.streamEpoch,
           "network packet wire format preserves identity, token, timeline, shape and room delay");
}

void networkTimelineDoesNotCompareIndependentClientClockOrigins() {
    const auto senderStartedEarlier = alignAudioPacketTimeline(5'000'000, 100, 1440, 240);
    expect(senderStartedEarlier.silenceFrames == 1440 && senderStartedEarlier.skipFrames == 0,
           "a sender's older process clock cannot create seconds of artificial silence");
    const auto receiverStartedEarlier = alignAudioPacketTimeline(100, 5'000'000, 1440, 240);
    expect(receiverStartedEarlier.silenceFrames == 1440 && receiverStartedEarlier.skipFrames == 0,
           "a receiver's older process clock cannot discard the first remote voice packet");
}

void roomVoiceCompensationAlignsDifferentNetworkDelays() {
    constexpr std::uint64_t capturedAtFrame = 48'000;
    const auto fasterTarget = compensatedVoiceTargetFrames(
        capturedAtFrame, 50'000, 480, 1'440, 12'000);
    const auto slowerTarget = compensatedVoiceTargetFrames(
        capturedAtFrame, 52'000, 480, 1'440, 12'000);
    const auto commonTarget = std::max(fasterTarget, slowerTarget);
    const auto faster = alignSharedAudioTimeline(
        capturedAtFrame, 50'000, commonTarget);
    const auto slower = alignSharedAudioTimeline(
        capturedAtFrame, 52'000, commonTarget);

    expect(fasterTarget == 2'480 && slowerTarget == 4'480,
           "room compensation includes each stream's measured arrival delay and jitter headroom");
    expect(50'000 + faster.silenceFrames == 52'000 + slower.silenceFrames,
           "the faster voice is delayed until both singers reach one shared playout frame");
    expect(sharedTimelineQueueTargetFrames(capturedAtFrame, 50'000, commonTarget) == 2'480 &&
               sharedTimelineQueueTargetFrames(capturedAtFrame, 52'000, commonTarget) == 480,
           "steady-state shared playback targets remaining queue time rather than adding route latency twice");
    expect(sharedCompensationTargetFrames(4'480, 12'000, true) == 4'480,
           "a transient decoder stall cannot permanently ratchet room latency after alignment");
    expect(maximumRoomCompensationFrames(24'000, 240) == 23'760,
           "room compensation follows the prepared bounded queue instead of a fixed latency");
    expect(maximumInteractiveRoomDelayFrames(24'000, 240, 48'000, 1'440) == 3'840,
           "live room latency stays bounded even when a stale route fills a large queue");

    NetworkAudioEngine network;
    network.prepare(48'000, 1, 4'800, 240, GenerationId{1});
    network.setSharedTimeline(true);
    const auto diagnostics = network.diagnostics();
    expect(diagnostics.sharedTimeline && diagnostics.sharedTargetDelayFrames == 480,
           "karaoke starts from a low-latency ten millisecond room playout target");
}

void networkRemoteQueueConvergesWithoutMutingOtherSingers() {
    const auto starved = stabilizeRemoteQueue(600, 1440, 240);
    expect(starved.silenceFrames == 7 && starved.skipFrames == 0,
           "a starved peer is delayed gradually instead of repeatedly underrunning");
    const auto bloated = stabilizeRemoteQueue(2160, 1440, 240);
    expect(bloated.silenceFrames == 0 && bloated.skipFrames == 7,
           "an overfilled peer sheds only a small bounded slice of accumulated latency");
    const auto stable = stabilizeRemoteQueue(1500, 1440, 240);
    expect(stable.silenceFrames == 0 && stable.skipFrames == 0,
           "a stable remote singer remains fully audible without timing edits");

    auto fill = 1440U;
    constexpr auto shiftedTarget = 2400U;
    for (auto packet = 0U; packet < 200U && fill + 240U < shiftedTarget; ++packet)
        fill += stabilizeRemoteQueue(fill, shiftedTarget, 240).silenceFrames;
    expect(fill + 240U >= shiftedTarget,
           "one 20 ms room-consensus step converges within one second of voice packets");
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

void networkTimingReportsClockOffsetAndDrift() {
    NetworkTimingEstimator timing;
    constexpr std::uint32_t rate = 48'000;
    constexpr double driftPpm = 75.0;
    for (std::uint64_t packet = 0; packet < 4'000; ++packet) {
        const auto senderFrame = packet * 240U;
        const auto senderMicros = static_cast<double>(senderFrame) * 1'000'000.0 / rate;
        const auto arrivalMicros = static_cast<std::uint64_t>(
            std::llround(25'000.0 + senderMicros * (1.0 + driftPpm / 1'000'000.0)));
        timing.noteArrival(senderFrame, arrivalMicros, rate);
    }
    const auto snapshot = timing.snapshot(1'440, 24'000, rate);
    expect(std::abs(snapshot.clockOffsetMs - 25.0F) < 0.5F,
           "network timing exposes the remote clock offset estimate");
    expect(std::abs(snapshot.clockDriftPpm - static_cast<float>(driftPpm)) < 5.0F,
           "network timing exposes bounded remote clock drift in ppm");

    NetworkTimingEstimator jittered;
    for (std::uint64_t packet = 0; packet < 3'000; ++packet) {
        const auto senderFrame = packet * 240U;
        const auto senderMicros = static_cast<double>(senderFrame) * 1'000'000.0 / rate;
        const auto deterministicJitter = static_cast<double>(static_cast<int>(packet % 17U) - 8) * 1'500.0;
        const auto arrivalMicros = static_cast<std::uint64_t>(std::llround(
            25'000.0 + senderMicros * (1.0 + driftPpm / 1'000'000.0) + deterministicJitter));
        jittered.noteArrival(senderFrame, arrivalMicros, rate);
    }
    const auto jitteredSnapshot = jittered.snapshot(1'440, 24'000, rate);
    expect(std::abs(jitteredSnapshot.clockDriftPpm - static_cast<float>(driftPpm)) < 10.0F,
           "clock drift regression rejects deterministic plus/minus twelve millisecond jitter");

    NetworkTimingEstimator reordered;
    reordered.noteArrival(240, 30'000, rate);
    reordered.noteArrival(0, 31'000, rate);
    for (std::uint64_t packet = 2; packet < 3'000; ++packet) {
        const auto senderFrame = packet * 240U;
        reordered.noteArrival(senderFrame, 25'000 + senderFrame * 1'000'000ULL / rate, rate);
    }
    expect(std::abs(reordered.snapshot(1'440, 24'000, rate).clockDriftPpm) < 10.0F,
           "an initially reordered packet cannot overflow the clock regression");
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

void roomVoiceSharedCompensationCannotGrowPastInteractiveLimit() {
    constexpr auto rate = 48'000U;
    constexpr auto eightyMilliseconds = rate * 80U / 1'000U;
    const auto limit = maximumInteractiveRoomDelayFrames(
        rate / 2U, rate / 200U, rate, rate * 20U / 1'000U);

    expect(limit <= eightyMilliseconds,
           "a live room cannot turn route changes into more than eighty milliseconds of voice lag");
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

void roomVoiceTransportSurvivesAudioDeviceRecovery() {
    NetworkAudioEngine network;
    network.prepare(48'000, 1, 24'000, 240, GenerationId{1});
    expect(network.addRemoteParticipant("remote-singer"),
           "room participant is registered before device recovery");
    network.setSharedTimeline(true);
    network.startReceive(0);
    network.startSend("127.0.0.1", 9);

    network.prepare(48'000, 1, 24'000, 240, GenerationId{2});

    const auto diagnostics = network.diagnostics();
    network.stop();
    expect(diagnostics.transportRunning && diagnostics.sendEnabled && diagnostics.sharedTimeline &&
               diagnostics.participants.size() == 1 &&
               diagnostics.participants.front().participantId == "remote-singer",
           "room voice transport and participants survive an audio-device recovery");
}

void udpSocketCanSendDirectlyToMultiplePeersWithoutDisconnectingRelayReceive() {
    UdpSocket first;
    UdpSocket second;
    UdpSocket sender;
    first.bind(0);
    second.bind(0);
    sender.bind(0);
    first.setReceiveTimeoutMs(250);
    second.setReceiveTimeoutMs(250);
    const std::array<std::byte, 3> payload{std::byte{'p'}, std::byte{'2'}, std::byte{'p'}};

    expect(sender.sendTo("127.0.0.1", first.localPort(), payload),
           "one UDP socket sends a direct room packet to the first peer");
    expect(sender.sendTo("127.0.0.1", second.localPort(), payload),
           "the same UDP socket sends to a second peer without reconnecting");
    std::array<std::byte, 16> received{};
    expect(first.receive(received) == payload.size() &&
               second.receive(received) == payload.size(),
           "both direct peers receive their packet on the advertised bound port");
}

void directAndRelayCopiesAreDeduplicatedBeforeJitterMeasurement() {
    RecentAudioSequenceWindow seen;
    expect(!seen.isDuplicate(42) && seen.isDuplicate(42),
           "the relay copy of an already received direct packet is rejected");
    expect(!seen.isDuplicate(42 + RecentAudioSequenceWindow::Capacity),
           "the bounded history accepts a later sequence that reuses the same slot");
    seen.reset();
    expect(!seen.isDuplicate(42), "a restarted remote stream clears duplicate history");
}

void roomSharedTimelineStaysWarmAcrossPlaybackCommands() {
    auto backend = std::make_unique<FakeAudioBackend>();
    AudioService service{std::move(backend)};
    service.start();
    service.session().prepare(RequestedConfiguration{});

    expect(service.handleLine("1|JoinMediaSession|localParticipantId=local|localPort=0|host=127.0.0.1|remotePort=9|voiceToken=0000000000000001").status == ControlStatus::Ok,
           "room voice session joins before karaoke playback");
    expect(service.network().diagnostics().sharedTimeline,
           "shared alignment is warm immediately on room join");
    (void)service.handleLine("1|Play");
    (void)service.handleLine("1|Pause");
    (void)service.handleLine("1|Seek|frame=0");
    (void)service.handleLine("1|Stop");
    expect(service.network().diagnostics().sharedTimeline,
           "playback controls do not reset accumulated room alignment");
}

void roomVoiceRouteCompensationDoesNotAccumulate() {
    const auto first = roomRouteCompensationFrames(50.0F, 960, 480, 3'840, 48'000);
    const auto later = roomRouteCompensationFrames(50.0F, 960, 480, 3'840, 48'000);
    expect(first == 2'160 && later == first,
           "connection RTT and jitter produce a stable target without accumulating backing delay");
}

} // namespace Tests
