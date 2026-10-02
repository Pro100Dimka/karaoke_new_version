#include "TestHarness.hpp"
#include "app/AudioService.hpp"
#include "backend/fake/FakeAudioBackend.hpp"
#include "network/AdaptiveJitterBuffer.hpp"
#include "network/NetworkAudioEngine.hpp"
#include "network/NetworkPacket.hpp"
#include "network/OpusCodec.hpp"
#include "network/PcmVoiceCodec.hpp"
#include "network/UdpSocket.hpp"

#include <atomic>
#include <cmath>
#include <cstdio>
#include <thread>
#include <vector>

struct NetworkTestAccess {
    static void queueBeforeSenderStarts(NetworkAudioEngine& engine) {
        engine.running_.store(true);
        engine.sendEnabled_.store(true);
    }
    static void startQueuedSender(NetworkAudioEngine& engine, std::uint16_t port) {
        engine.encoder_ = std::make_unique<OpusVoiceEncoder>(48000, 1);
        engine.socket_.bind(0);
        engine.socket_.connect("127.0.0.1", port);
        engine.sendThread_ = std::thread(&NetworkAudioEngine::sendMain, &engine);
    }
    static void wakeSender(NetworkAudioEngine& engine) {
        engine.wakeSender();
    }
    static void startIdleSender(NetworkAudioEngine& engine) {
        engine.running_.store(true);
        engine.sendEnabled_.store(true);
        engine.sendThread_ = std::thread(&NetworkAudioEngine::sendMain, &engine);
    }
    static std::atomic<std::uint32_t>& renderReaders(NetworkAudioEngine& engine,
                                                     std::string_view participant) {
        return engine.slotForId(participant)->renderReaders;
    }
    static std::uint32_t key(std::string_view participant) {
        return NetworkAudioEngine::participantKey(participant);
    }
    static bool queueVoice(NetworkAudioEngine& engine, std::string_view participant,
                           std::span<const float> samples) {
        auto* slot = engine.slotForId(participant);
        return slot && slot->queue.push(samples, static_cast<std::uint32_t>(samples.size()));
    }
};

namespace Tests {
void outgoingVoiceKeepsTheTimestampOfItsOwnPcm() {
    UdpSocket receiver;
    receiver.bind(0);
    receiver.setReceiveTimeoutMs(1000);
    NetworkAudioEngine engine;
    constexpr std::uint32_t packetFrames = 48'000 / VoicePacketsPerSecond;
    engine.prepare(48000, 1, 1024, packetFrames, GenerationId{1});
    NetworkTestAccess::queueBeforeSenderStarts(engine);
    const std::vector<float> pcm(packetFrames, 0.1F);
    engine.pushLocal(GenerationId{1}, pcm, packetFrames, 1000);
    engine.pushLocal(GenerationId{1}, pcm, packetFrames,
                     10'000); // A missing interval before the second capture.
    NetworkTestAccess::startQueuedSender(engine, receiver.localPort());
    std::array<std::byte, 2048> bytes{};
    // Packets carry the capture time of the audio they decode to: the codec delay earlier.
    const auto codecDelay = OpusVoiceEncoder(48000, 1).lookaheadFrames();
    for (const auto captured : {1000ULL, 10'000ULL}) {
        const auto size = receiver.receive(bytes);
        AudioPacketHeader packet;
        expect(decodeAudioPacketHeader(std::span<const std::byte>{bytes.data(), size}, packet) &&
                   (packet.timestampFrame & MediaTimelineMask) == captured - codecDelay,
               "queued voice retains its capture timestamp instead of compressing missing time");
    }
    engine.stop();
}

void centralRoomMixerReceivesPcmFromTheFirstSharedTimelinePacket() {
    UdpSocket receiver;
    receiver.bind(0);
    receiver.setReceiveTimeoutMs(1000);
    NetworkAudioEngine engine;
    constexpr std::uint32_t packetFrames = 48'000 / VoicePacketsPerSecond;
    engine.prepare(48'000, 1, 1024, packetFrames, GenerationId{1});
    engine.setLocalParticipant("singer");
    engine.setSessionToken(77);
    engine.setSharedTimeline(true);
    engine.startSend("127.0.0.1", receiver.localPort());
    const std::vector<float> pcm(packetFrames, 0.25F);
    engine.pushLocal(GenerationId{1}, pcm, packetFrames, 48'000);

    std::array<std::byte, 2048> bytes{};
    const auto size = receiver.receive(bytes);
    AudioPacketHeader packet{};
    expect(decodeAudioPacketHeader(std::span<const std::byte>{bytes.data(), size}, packet) &&
               packet.codec == VoiceCodec::Pcm16 &&
               (packet.timestampFrame & SharedAudioTimelineFlag) != 0,
           "the central room mixer receives immediately decodable PCM on the shared timeline");
    engine.stop();
}

void sharedTimelinePacketTimestampUsesTheRoomFrameGrid() {
    UdpSocket receiver;
    receiver.bind(0);
    receiver.setReceiveTimeoutMs(1000);
    NetworkAudioEngine engine;
    constexpr std::uint32_t packetFrames = 48'000 / VoicePacketsPerSecond;
    engine.prepare(48'000, 1, 1024, packetFrames, GenerationId{1});
    engine.setLocalParticipant("singer");
    engine.setSessionToken(77);
    engine.setSharedTimeline(true);
    engine.startSend("127.0.0.1", receiver.localPort());
    const std::vector<float> pcm(packetFrames, 0.25F);
    engine.pushLocal(GenerationId{1}, pcm, packetFrames, 48'048);

    std::array<std::byte, 2048> bytes{};
    const auto size = receiver.receive(bytes);
    AudioPacketHeader packet{};
    expect(decodeAudioPacketHeader(std::span<const std::byte>{bytes.data(), size}, packet) &&
               (packet.timestampFrame & MediaTimelineMask) % packetFrames == 0,
           "shared-timeline packet timestamps align to the 120-frame room grid");
    engine.stop();
}

void sharedTimelineVoiceUsesRedundantUpstreamDatagrams() {
    UdpSocket receiver;
    receiver.bind(0);
    receiver.setReceiveTimeoutMs(250);
    NetworkAudioEngine engine;
    constexpr std::uint32_t packetFrames = 48'000 / VoicePacketsPerSecond;
    engine.prepare(48'000, 1, 1024, packetFrames, GenerationId{1});
    engine.setLocalParticipant("singer");
    engine.setSessionToken(77);
    engine.setSharedTimeline(true);
    engine.startSend("127.0.0.1", receiver.localPort());
    const std::vector<float> pcm(packetFrames, 0.25F);
    engine.pushLocal(GenerationId{1}, pcm, packetFrames, 48'000);

    std::array<std::byte, 2048> first{}, second{};
    const auto firstSize = receiver.receive(first);
    const auto secondSize = receiver.receive(second);
    engine.stop();

    expect(firstSize != 0 && secondSize == firstSize &&
               std::equal(first.begin(), first.begin() + static_cast<std::ptrdiff_t>(firstSize),
                          second.begin()),
           "shared-timeline microphone audio reaches the server in redundant identical UDP "
           "datagrams");
}

void roomVoiceClockAdvancesWhileTheSongIsStopped() {
    UdpSocket receiver;
    receiver.bind(0);
    receiver.setReceiveTimeoutMs(1000);
    AudioService service{std::make_unique<FakeAudioBackend>()};
    service.start();
    service.session().prepare(RequestedConfiguration{});
    service.session().start();
    constexpr std::uint64_t serverMicros = 1'790'000'000'000'000ULL;
    (void)service.handleLine("1|SetRoomClock|serverMicros=" + std::to_string(serverMicros) +
                             "|localMicros=" + std::to_string(monotonicTicksNow() / 1000));
    expect(service.handleLine("1|JoinMediaSession|localParticipantId=local|localPort=0|host=127.0."
                              "0.1|remotePort=" +
                              std::to_string(receiver.localPort()) + "|voiceToken=0000000000000001")
                   .status == ControlStatus::Ok,
           "voice clock regression opens the existing media transport");
    std::array<std::uint64_t, 2> timestamps{};
    std::vector<float> output(480);
    std::array<std::byte, 2048> bytes{};
    std::optional<std::uint32_t> previousSequence;
    for (std::size_t index = 0; index < timestamps.size(); ++index) {
        service.realtime().onRender(service.session().generationId(),
                                    {nullptr, output.data(), 240, 2});
        AudioPacketHeader packet;
        do {
            const auto size = receiver.receive(bytes);
            expect(decodeAudioPacketHeader(std::span<const std::byte>{bytes.data(), size}, packet),
                   "idle voice produces a valid audio packet");
        } while (previousSequence && packet.sequence == *previousSequence);
        timestamps[index] = packet.timestampFrame & MediaTimelineMask;
        previousSequence = packet.sequence;
        std::this_thread::sleep_for(std::chrono::milliseconds(5));
    }
    expect(timestamps[1] > timestamps[0] && timestamps[0] > 80'000'000'000'000ULL,
           "voice uses the continuous authoritative room clock, never the stopped song cursor");
    NetworkTimingEstimator timing;
    timing.noteArrival(serverMicros / 1'000'000 * 48000, serverMicros + 6000, 48000);
    expect(std::abs(timing.snapshot(480, 4800, 48000).clockOffsetMs - 6.0F) < 0.01F,
           "epoch-sized audio timestamps cannot overflow clock conversion");
}

void networkStopNeverLosesTheSenderWakeup() {
    NetworkAudioEngine engine;
    engine.prepare(48000, 1, 1024, 240, GenerationId{1});
    std::atomic<std::uint32_t> progress{0}, rescued{0};
    std::atomic<bool> finished{false};
    std::thread watchdog([&] {
        auto previous = progress.load();
        while (!finished.load()) {
            std::this_thread::sleep_for(std::chrono::milliseconds(100));
            const auto current = progress.load();
            if (current == previous && !finished.load()) {
                ++rescued;
                NetworkTestAccess::wakeSender(engine);
            }
            previous = current;
        }
    });
    for (std::uint32_t cycle = 0; cycle < 30'000; ++cycle) {
        NetworkTestAccess::startIdleSender(engine);
        const auto stopAt =
            std::chrono::steady_clock::now() + std::chrono::microseconds(cycle % 80);
        while (std::chrono::steady_clock::now() < stopAt)
            std::this_thread::yield();
        engine.stop();
        ++progress;
    }
    finished.store(true);
    watchdog.join();
    expect(rescued.load() == 0,
           "network sender stop must complete without a replacement notification");
}

void remoteRemovalDrainsAnInFlightRenderLease() {
    NetworkAudioEngine engine;
    engine.prepare(48000, 1, 8192, 240, GenerationId{1});
    expect(engine.addRemoteParticipant("voice"), "participant joins before callback starts");
    auto& readers = NetworkTestAccess::renderReaders(engine, "voice");
    readers.fetch_add(1); // Hold the same lease used by renderRemote across DSP processing.
    std::atomic<bool> started{false}, removed{false};
    std::thread control([&] {
        started.store(true);
        (void)engine.removeRemoteParticipant("voice");
        removed.store(true);
    });
    while (!started.load())
        std::this_thread::yield();
    std::this_thread::sleep_for(std::chrono::milliseconds(20));
    const auto reclaimedEarly = removed.load();
    readers.fetch_sub(1);
    readers.notify_one();
    control.join();
    expect(!reclaimedEarly && removed.load(),
           "control must not reclaim participant DSP until its old render lease finishes");
}

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
               NetworkTestAccess::queueVoice(fresh, "new", signal),
           "decoded voice is queued");
    RealtimeInstrumentation::reset();
    {
        RealtimeScope callback;
        (void)reused.renderRemote(GenerationId{1}, actual, 4096);
        (void)fresh.renderRemote(GenerationId{1}, expected, 4096);
    }
    expect(actual == expected, "a newly joined voice must not inherit departed participant DSP");
    const auto violations = RealtimeInstrumentation::snapshot();
    expect(violations.allocations == 0 && violations.deallocations == 0 &&
               violations.blockingCalls == 0,
           "remote slot leases never allocate, reclaim or wait in the audio callback");
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
                capture[frame] = static_cast<float>(
                    0.3 * std::sin(2.0 * 3.14159265 * 440.0 *
                                   static_cast<double>(block * 240 + frame) / 24000.0));
            fake->pump(capture, 1, render, 2, block * 240, block * 480);
            // One 10 ms output block carries several voice packets.
            for (std::uint32_t part = 0; part < 480U * VoicePacketsPerSecond / 48'000U; ++part) {
                const auto bytes = receiver.receive(packet);
                if (bytes <= AudioPacketHeaderBytes)
                    continue;
                const auto decoded =
                    decoder.decode(std::span<const std::byte>{packet}.subspan(
                                       AudioPacketHeaderBytes, bytes - AudioPacketHeaderBytes),
                                   48'000U / VoicePacketsPerSecond);
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
        input[index] =
            static_cast<float>(0.4 * std::sin(2.0 * 3.14159265 * 220.0 * index / sampleRateHz));
    const auto encoded = encoder.encode(input, frames);
    const auto decoded = decoder.decode(encoded, frames);
    expect(!encoded.empty(), "Opus encoder produces a non-empty packet");
    expect(decoded.size() == input.size(), "Opus decoder reproduces the frame's sample count");
}

void opusCodecDelayIsTheReportedLookahead() {
    constexpr std::uint32_t sampleRateHz = 48000, frames = 240, clickFrame = 300;
    OpusVoiceEncoder encoder(sampleRateHz, 1);
    OpusVoiceDecoder decoder(sampleRateHz, 1);
    expect(encoder.lookaheadFrames() == sampleRateHz / 400U,
           "5 ms voice packets use the 2.5 ms low-delay codec path");
    std::vector<float> input(frames * 8, 0.0F), output;
    for (std::uint32_t index = 0; index < 48; ++index) // a short windowed click
        input[clickFrame + index] =
            static_cast<float>(0.5 * std::sin(3.14159265 * index / 48.0) *
                               std::sin(2.0 * 3.14159265 * 2000.0 * index / sampleRateHz));
    for (std::uint32_t packet = 0; packet < 8; ++packet) {
        const auto decoded = decoder.decode(
            encoder.encode(std::span<const float>{input}.subspan(packet * frames, frames), frames),
            frames);
        output.insert(output.end(), decoded.begin(), decoded.end());
    }
    // Where the decoded click lines up best with the input click is the codec delay.
    std::uint32_t bestLag = 0;
    double best = -1.0;
    for (std::uint32_t lag = 0; lag < frames; ++lag) {
        double dot = 0.0;
        for (std::uint32_t index = 0; index < 48; ++index)
            dot +=
                static_cast<double>(input[clickFrame + index]) * output[clickFrame + lag + index];
        if (dot > best) {
            best = dot;
            bestLag = lag;
        }
    }
    expect(bestLag + 2 >= encoder.lookaheadFrames() && bestLag <= encoder.lookaheadFrames() + 2,
           "decoded voice trails its input by exactly the lookahead the packets are stamped with");
}

void opusDecoderConcealsALostFrame() {
    constexpr std::uint32_t sampleRateHz = 48000;
    constexpr std::uint32_t channels = 1;
    constexpr std::uint32_t frames = 240;
    OpusVoiceEncoder encoder(sampleRateHz, channels);
    OpusVoiceDecoder decoder(sampleRateHz, channels);
    std::vector<float> input(frames);
    for (std::uint32_t index = 0; index < frames; ++index)
        input[index] =
            static_cast<float>(0.4 * std::sin(2.0 * 3.14159265 * 220.0 * index / sampleRateHz));
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
    const auto first = jitter.pop(packet) == JitterPopOutcome::Delivered && packet.sequence == 1;
    const auto second = jitter.pop(packet) == JitterPopOutcome::Delivered && packet.sequence == 2;
    expect(first && second, "jitter buffer reorders packets by sequence");
}

void jitterBufferReportsLossExplicitly() {
    AdaptiveJitterBuffer jitter;
    jitter.configure(2, 6);
    jitter.push({1, 0, 1, 1, onePayloadByte()});
    jitter.push({3, 0, 1, 1, onePayloadByte()}); // sequence 2 never arrives
    NetworkAudioPacket packet;
    const auto delivered =
        jitter.pop(packet) == JitterPopOutcome::Delivered && packet.sequence == 1;
    jitter.push({4, 0, 1, 1, onePayloadByte()});
    const auto lost = jitter.pop(packet) == JitterPopOutcome::Lost;
    const auto caughtUp = jitter.pop(packet) == JitterPopOutcome::Delivered && packet.sequence == 3;
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
        // ASIO and surround endpoints commonly expose more than two render channels. Voice
        // transport still has to initialize because the microphone is encoded as one centred mono
        // stream.
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
    constexpr std::uint32_t whole = 44'100 / VoicePacketsPerSecond;
    bool sawWhole = false;
    bool sawExtra = false;
    for (std::uint64_t packet = 0; packet < VoicePacketsPerSecond; ++packet) {
        const auto frames = deviceFramesForVoicePacket(packet, 44'100);
        totalFrames += frames;
        sawWhole = sawWhole || frames == whole;
        sawExtra = sawExtra || frames == whole + 1U;
    }
    expect(totalFrames == 44'100 && sawWhole && sawExtra,
           "44.1 kHz room voice alternates fractional packet lengths without long-term drift");
}

void roomVoiceSharedDelayAdaptsWithoutJumps() {
    expect(adaptSharedCompensationFrames(1'440, 2'400, 1'440, 3'840, 240) == 1'680,
           "room voice adds at most one packet when network delay rises");
    expect(adaptSharedCompensationFrames(2'400, 1'440, 1'440, 3'840, 240) == 2'399,
           "room voice removes excess latency one frame per packet after the network stabilizes");
    expect(adaptSharedCompensationFrames(1'600, 1'650, 1'440, 3'840, 240) == 1'650,
           "room voice never stays below the measured need, which would starve the queue");
    expect(adaptSharedCompensationFrames(1'700, 1'600, 1'440, 3'840, 240) == 1'700,
           "room voice ignores jitter changes inside the half-packet release band");
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
            const auto jitterIndex =
                (sequence + static_cast<std::uint32_t>(index) * 3U) % jitterMilliseconds.size();
            const auto delayMilliseconds =
                static_cast<std::int32_t>(computer.baseDelayMilliseconds) +
                jitterMilliseconds[jitterIndex];
            const auto senderFrame = static_cast<std::uint64_t>(sequence) * packet;
            const auto driftedSenderFrame = static_cast<std::uint64_t>(std::llround(
                static_cast<double>(senderFrame) *
                (1.0 + static_cast<double>(computer.driftPartsPerMillion) / 1'000'000.0)));
            const auto arrivalMicros = driftedSenderFrame * 1'000'000ULL / rate +
                                       static_cast<std::uint64_t>(delayMilliseconds) * 1'000ULL;
            computer.timing.noteArrival(driftedSenderFrame, arrivalMicros, rate);
            const auto jitterTarget =
                computer.timing.snapshot(minimumDelay, simulatedQueue / 2U, rate).targetDelayFrames;
            const auto routeFrames = static_cast<std::uint32_t>(delayMilliseconds) * rate / 1'000U;
            computer.desiredFrames = std::max(routeFrames + jitterTarget, minimumDelay);
        }
        const auto desiredShared = std::max(computers[0].desiredFrames, computers[1].desiredFrames);
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
           "two-computer simulation keeps the slower remote singer buffered despite jitter, loss "
           "and clock drift");
}

void networkPacketWireFormatIsStableAndAuthenticated() {
    AudioPacketHeader input{7,     42,  0x123456789abcdef0ULL, 48000, 1, 240,
                            8'640, 123, VoiceCodec::Pcm16,     17};
    const auto bytes = encodeAudioPacketHeader(input);
    AudioPacketHeader output{};
    expect(bytes.size() == AudioPacketHeaderBytes && decodeAudioPacketHeader(bytes, output),
           "network packet header has a fixed validated wire size");
    expect(
        output.sequence == input.sequence && output.participantKey == input.participantKey &&
            output.sessionToken == input.sessionToken &&
            output.timestampFrame == input.timestampFrame && output.channels == input.channels &&
            output.frames == input.frames &&
            output.reportedParticipantKey == input.reportedParticipantKey &&
            output.streamEpoch == input.streamEpoch && output.codec == input.codec &&
            output.reportedLossPermille == input.reportedLossPermille,
        "network packet wire format preserves identity, token, timeline, shape, codec and report");
    expect(bytes[4] == std::byte{3} && bytes[6] == std::byte{44},
           "the deployed relay still recognises the version and header size it routes");
    auto lossy = input;
    lossy.reportedParticipantKey = 0xABCD'EF12U;
    lossy.reportedLossPermille = 900;
    AudioPacketHeader saturated{};
    expect(decodeAudioPacketHeader(encodeAudioPacketHeader(lossy), saturated) &&
               saturated.reportedParticipantKey == (0xABCD'EF12U & ReportKeyMask) &&
               saturated.reportedLossPermille == MaximumReportedLossPermille,
           "the report keeps the key's low bits and saturates a heavy loss");
}

void serverMixStageReportPreservesIngressAndCollectionFrames() {
    const auto encoded = encodeServerMixStageReport(2'592, 192);
    const auto decoded = decodeServerMixStageReport(encoded);
    expect(decoded.ingressFrames == 2'592 && decoded.collectionFrames == 192,
           "server-mix stage diagnostics share the existing report word without losing frames");
}

void roomVoiceBeyondTheDelayCeilingIsNeverPlayedLate() {
    // Full room synchrony has priority over continuity. A singer outside the current deadline is
    // silent, but can recover at the current position when the pre-song room deadline rises.
    constexpr std::uint32_t rate = 48'000, block = 120, token = 77;
    constexpr std::uint64_t lateFrames = rate / 10U;
    NetworkAudioEngine network;
    network.prepare(rate, 1, rate / 2U, block, GenerationId{1});
    network.setSharedTimeline(true);
    network.setRoomPlayoutDelay(60.0F);
    network.setSessionToken(token);
    expect(network.addRemoteParticipant("far-singer"), "the far singer joins");
    network.startReceive(0);
    UdpSocket sender;
    sender.bind(0);
    std::vector<float> tone(block); // a 400 Hz tone: whole cycles per packet, and not a DC level
    for (std::uint32_t frame = 0; frame < block; ++frame) // the voice chain removes
        tone[frame] = 0.5F * static_cast<float>(std::sin(2.0 * 3.14159265358979 * frame / block));
    const auto payload = PcmVoiceCodec::encode(tone);
    std::vector<float> output(block);
    std::uint64_t timeline = 10U * rate;
    float latePeak = 0.0F;
    for (std::uint32_t sequence = 0; sequence < 400; ++sequence, timeline += block) {
        const AudioPacketHeader header{sequence,
                                       NetworkTestAccess::key("far-singer"),
                                       token,
                                       (timeline - lateFrames) | SharedAudioTimelineFlag,
                                       1,
                                       block,
                                       0,
                                       1,
                                       VoiceCodec::Pcm16,
                                       0};
        const auto encoded = encodeAudioPacketHeader(header);
        std::vector<std::byte> packet(encoded.begin(), encoded.end());
        packet.insert(packet.end(), payload.begin(), payload.end());
        expect(sender.sendTo("127.0.0.1", network.localPort(), packet), "the voice packet is sent");
        std::this_thread::sleep_for(std::chrono::microseconds(2'500)); // real-time packet pacing
        (void)network.renderRemote(GenerationId{1}, output, block, timeline);
        if (sequence > 200)
            latePeak = std::max(latePeak, *std::ranges::max_element(output));
    }
    float recoveredPeak = 0.0F;
    network.setRoomPlayoutDelay(160.0F);
    for (std::uint32_t sequence = 400; sequence < 1'000; ++sequence, timeline += block) {
        const AudioPacketHeader header{sequence,
                                       NetworkTestAccess::key("far-singer"),
                                       token,
                                       (timeline - lateFrames) | SharedAudioTimelineFlag,
                                       1,
                                       block,
                                       0,
                                       1,
                                       VoiceCodec::Pcm16,
                                       0};
        const auto encoded = encodeAudioPacketHeader(header);
        std::vector<std::byte> packet(encoded.begin(), encoded.end());
        packet.insert(packet.end(), payload.begin(), payload.end());
        expect(sender.sendTo("127.0.0.1", network.localPort(), packet),
               "the recovered voice packet is sent");
        std::this_thread::sleep_for(std::chrono::microseconds(2'500));
        (void)network.renderRemote(GenerationId{1}, output, block, timeline);
        if (sequence > 800)
            recoveredPeak = std::max(recoveredPeak, *std::ranges::max_element(output));
    }
    network.stop();
    expect(latePeak < 0.001F,
           "a voice later than the room deadline is dropped instead of being played late");
    expect(recoveredPeak > 0.3F,
           "an excluded voice rejoins at the current position after the pre-song deadline rises");
}

void pcmLossConcealmentAvoidsAZeroFilledClick() {
    PcmLossConcealer concealment;
    std::vector<float> previous(120);
    for (std::size_t index = 0; index < previous.size(); ++index)
        previous[index] = 0.25F * std::sin(static_cast<float>(index) * 0.1F);
    concealment.remember(previous, 1);

    const auto missing = concealment.conceal(120, 1);
    std::vector<float> recovered(120, -0.2F);
    const auto unsmoothedJump = std::abs(recovered.front() - missing.back());
    concealment.smoothRecovery(recovered, 1);

    float power = 0.0F;
    for (const auto sample : missing)
        power += sample * sample;
    const auto expectedNext = previous.back() + (previous.back() - previous[previous.size() - 2]);
    expect(power > 0.01F &&
               std::abs(missing.front() - expectedNext) < 0.01F &&
               std::abs(recovered.front() - missing.back()) < unsmoothedJump,
           "one lost PCM room packet is concealed continuously instead of becoming a 2.5 ms "
           "zero-filled click");
}

void pcmVoiceRoundTripsWithoutCodecDelay() {
    const std::vector<float> voice{0.0F, 0.5F, -0.5F, 1.0F, -1.0F, 1.5F};
    const auto bytes = PcmVoiceCodec::encode(voice);
    const auto decoded = PcmVoiceCodec::decode(bytes, voice.size());
    bool close = decoded.size() == voice.size();
    for (std::size_t index = 0; close && index < voice.size(); ++index)
        close = std::abs(decoded[index] - std::clamp(voice[index], -1.0F, 1.0F)) < 1.0F / 16'000.0F;
    expect(close, "PCM voice keeps every sample in place, clipped to full scale");
    expect(PcmVoiceCodec::decode(bytes, voice.size() + 1U).empty(),
           "a PCM payload of the wrong length is rejected");
}

void voiceCodecUsesPcmOnlyOnACleanConnection() {
    constexpr std::uint64_t second = 1'000'000;
    VoiceCodecPolicy policy;
    expect(policy.step(std::nullopt, 0) == VoiceCodec::Opus,
           "without a listener report the voice stays on Opus");
    expect(policy.step(2U, 1 * second) == VoiceCodec::Opus &&
               policy.step(2U, 3 * second) == VoiceCodec::Opus &&
               policy.step(2U, 4 * second) == VoiceCodec::Pcm16,
           "three seconds of clean reports switch the voice to PCM");
    expect(policy.step(10U, 5 * second) == VoiceCodec::Pcm16,
           "a little loss below the lossy level keeps PCM");
    expect(policy.step(30U, 6 * second) == VoiceCodec::Opus,
           "a lossy report sends the voice back to Opus at once");
    expect(policy.step(0U, 20 * second) == VoiceCodec::Opus &&
               policy.step(0U, 36 * second) == VoiceCodec::Opus &&
               policy.step(0U, 40 * second) == VoiceCodec::Pcm16,
           "PCM returns only after the back-off and another clean span");
    (void)policy.step(30U, 41 * second);
    (void)policy.step(0U, 80 * second);
    expect(policy.step(0U, 100 * second) == VoiceCodec::Opus &&
               policy.step(0U, 101 * second) == VoiceCodec::Opus &&
               policy.step(0U, 104 * second) == VoiceCodec::Pcm16,
           "a second failure doubles the back-off, so a weak link settles on Opus");
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
    const auto fasterTarget =
        compensatedVoiceTargetFrames(capturedAtFrame, 50'000, 480, 1'440, 12'000);
    const auto slowerTarget =
        compensatedVoiceTargetFrames(capturedAtFrame, 52'000, 480, 1'440, 12'000);
    const auto commonTarget = std::max(fasterTarget, slowerTarget);
    const auto faster = alignSharedAudioTimeline(capturedAtFrame, 50'000, commonTarget);
    const auto slower = alignSharedAudioTimeline(capturedAtFrame, 52'000, commonTarget);

    expect(fasterTarget == 2'480 && slowerTarget == 4'480,
           "room compensation includes each stream's measured arrival delay and jitter headroom");
    expect(50'000 + faster.silenceFrames == 52'000 + slower.silenceFrames,
           "the faster voice is delayed until both singers reach one shared playout frame");
    expect(sharedTimelineQueueTargetFrames(capturedAtFrame, 50'000, commonTarget) == 2'480 &&
               sharedTimelineQueueTargetFrames(capturedAtFrame, 52'000, commonTarget) == 480,
           "steady-state shared playback targets remaining queue time rather than adding route "
           "latency twice");
    expect(sharedCompensationTargetFrames(4'480, 12'000, true) == 4'480,
           "a transient decoder stall cannot permanently ratchet room latency after alignment");
    expect(maximumRoomCompensationFrames(24'000, 240) == 23'760,
           "room compensation follows the prepared bounded queue instead of a fixed latency");
    expect(maximumInteractiveRoomDelayFrames(24'000, 240, 48'000, 1'440) == 7'680,
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
        const auto deterministicJitter =
            static_cast<double>(static_cast<int>(packet % 17U) - 8) * 1'500.0;
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
    constexpr auto interactiveLimit = rate * 160U / 1'000U;
    const auto limit =
        maximumInteractiveRoomDelayFrames(rate / 2U, rate / 200U, rate, rate * 20U / 1'000U);

    expect(limit <= interactiveLimit, "a live room cannot turn route changes into more than 160 "
                                      "milliseconds of voice lag (a follower included)");
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
    expect(first.receive(received) == payload.size() && second.receive(received) == payload.size(),
           "both direct peers receive their packet on the advertised bound port");

    // `first` treats `second` as its relay; a packet from `sender` is a direct one.
    first.connect("127.0.0.1", second.localPort(), 0);
    expect(second.sendTo("127.0.0.1", first.localPort(), payload) &&
               first.receive(received) == payload.size() && first.lastFromDefaultPeer(),
           "a packet from the relay address is recognised as relayed");
    expect(sender.sendTo("127.0.0.1", first.localPort(), payload) &&
               first.receive(received) == payload.size() && !first.lastFromDefaultPeer(),
           "a packet from any other address is recognised as direct");
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
    expect(service.handleLine("1|SetRoomClock|serverMicros=1790000000000000|localMicros=" +
                              std::to_string(monotonicTicksNow() / 1000))
                   .status == ControlStatus::Ok,
           "room join receives an authoritative clock observation before shared voice starts");

    expect(service.handleLine("1|JoinMediaSession|localParticipantId=local|localPort=0|host=127.0."
                              "0.1|remotePort=9|voiceToken=0000000000000001")
                   .status == ControlStatus::Ok,
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

void clockCommandReportsTheServiceClockAtReplyTime() {
    AudioService service{std::make_unique<FakeAudioBackend>()};
    const auto before = monotonicTicksNow();
    const auto reply = service.handleLine("1|GetClock");
    const auto after = monotonicTicksNow();
    const auto ticks = std::stoll(reply.text.substr(reply.text.find(": ") + 2));
    expect(reply.status == ControlStatus::Ok && ticks >= before && ticks <= after,
           "the clock command reads the service clock between request and reply");
}

void roomFollowEngagesOnlyForALargeLeaderDelay() {
    constexpr std::uint32_t engage = 48'000 * DefaultRoomFollowMinimumMs / 1'000; // 30 ms
    expect(!roomFollowEngaged(false, 48 * 20, engage) && !roomFollowEngaged(false, engage, engage),
           "a small leader delay keeps the room symmetric: everyone hears everyone");
    expect(roomFollowEngaged(false, 48 * 45, engage),
           "a large leader delay makes the follower sing on the leader's beat");
    expect(roomFollowEngaged(true, 48 * 27, engage) && !roomFollowEngaged(true, 48 * 24, engage),
           "following releases only well below the limit, so a delay near it does not flap");
    expect(roomFollowEngaged(false, 1, 0), "a zero minimum follows the leader unconditionally");

    RoomFollowState state;
    for (int packet = 0; packet < 10; ++packet)
        state = stepRoomFollow(state, 48 * 50, engage, 800);
    state = stepRoomFollow(state, 48 * 20, engage, 800);
    expect(!state.engaged && state.packetsAbove == 0,
           "a short delay spike does not switch the room to follow mode");
    for (int packet = 0; packet < 800; ++packet)
        state = stepRoomFollow(state, 48 * 50, engage, 800);
    expect(state.engaged, "a delay that stays high for the sustain time engages following");
}

void voiceBlocksJoinExactlyDespiteCaptureStampWander() {
    // A laptop in exclusive mode: 441-frame blocks whose measured capture time wanders by up to a
    // whole period, the way it did on the computer whose voice broke up several times a second.
    constexpr std::uint32_t rate = 44'100, block = 441;
    constexpr std::array wander{0, 441, -200, 300, -441, 120, 380, -300};
    VoiceTimelineSmoother timeline;
    std::uint64_t previous = 0;
    std::int64_t worstJoin = 0, worstOffset = 0;
    for (std::uint64_t index = 0; index < 2'000; ++index) {
        const auto truth = 1'000'000 + index * block;
        const auto measured = static_cast<std::uint64_t>(static_cast<std::int64_t>(truth) +
                                                         wander[index % wander.size()]);
        const auto stamped = timeline.stamp(measured, block, rate);
        if (index != 0)
            worstJoin = std::max(
                worstJoin, std::llabs(signedMediaTimelineDistance(previous + block, stamped)));
        if (index > 400)
            worstOffset =
                std::max(worstOffset, std::llabs(signedMediaTimelineDistance(truth, stamped)));
        previous = stamped;
    }
    expect(worstJoin <= static_cast<std::int64_t>(block / 100U + 1U),
           "consecutive voice blocks join to within 1% of a block (a gentle steer), not a period");
    expect(worstOffset <= static_cast<std::int64_t>(block),
           "the smoothed timeline stays on the measured song moment");
    const auto jumped = timeline.stamp(previous + block + rate, block, rate);
    expect(jumped == previous + block + rate,
           "a real jump of the song moment is taken over at once");
}

void roomDelayReleasesAfterASpike() {
    constexpr std::uint32_t packet = 220, minimum = 440, maximum = 7'056;
    std::uint32_t delay = 5'060; // a start-up spike
    for (int step = 0; step < 400; ++step)
        delay = adaptSharedCompensationFrames(delay, 2'860, minimum, maximum, packet);
    expect(delay == 5'060 - 400,
           "the delay comes down steadily, one frame per packet, instead of snapping back");
    for (int step = 0; step < 2'000; ++step)
        delay = adaptSharedCompensationFrames(delay, 2'860, minimum, maximum, packet);
    expect(delay <= 2'860 + packet / 2U,
           "the leader delay returns to within half a packet of the measured need");
}

void roomVoiceTargetFollowsMeasuredLateness() {
    constexpr std::uint32_t guard = 48;
    VoiceLatenessTracker lateness;
    for (std::uint32_t packet = 0; packet < VoiceLatenessTracker::WindowPackets; ++packet)
        lateness.note(packet % 2'000U == 0U ? 3'600 : 720); // steady 15 ms, a rare 75 ms stall
    expect(lateness.targetFrames() == 720 + VoiceLatenessTracker::BinFrames,
           "rare stalls do not set the target: it is the level 99.5% of packets stayed within");
    for (std::uint32_t packet = 0; packet < VoiceLatenessTracker::WindowPackets; ++packet)
        lateness.note(packet >= 1'000U && packet < 1'040U ? 4'800 : 720); // one 100 ms stall
    expect(lateness.targetFrames() == 720 + VoiceLatenessTracker::BinFrames,
           "a single stall of a sender is cut, not turned into half a minute of room delay");
    expect(roomPlayoutTargetFrames(lateness.targetFrames(), guard, 480, 7'680) ==
               720 + VoiceLatenessTracker::BinFrames + guard,
           "the playout target is the measured lateness plus the guard");
    for (std::uint32_t packet = 0; packet < VoiceLatenessTracker::WindowPackets; ++packet)
        lateness.note(packet % 50U == 0U ? 3'600 : 720); // stalls on 2% of packets
    expect(lateness.targetFrames() == 3'600 + VoiceLatenessTracker::BinFrames,
           "stalls frequent enough to matter do raise the target");
    for (std::uint32_t packet = 0; packet < VoiceLatenessTracker::WindowPackets; ++packet)
        lateness.note(720);
    expect(lateness.targetFrames() == 720 + VoiceLatenessTracker::BinFrames,
           "the target falls back once the stalls leave the thirty-second window");
    for (std::uint32_t packet = 0; packet < VoiceLatenessTracker::WindowPackets; ++packet)
        lateness.note(packet % 400U < 15U ? 7'200 : 720); // a Wi-Fi stall every second
    expect(lateness.targetFrames() == 7'200 + VoiceLatenessTracker::BinFrames &&
               lateness.followFrames() == 720 + VoiceLatenessTracker::BinFrames,
           "Wi-Fi stalls raise the playout level but not the level a follower shifts its song by");
    expect(lateAudioSkipFrames(480, 480, 120) == 0 && lateAudioSkipFrames(900, 480, 120) == 0,
           "a few packets of queue error are left to the gentle retime");
    expect(lateAudioSkipFrames(480, -1'000, 120) == 1'480,
           "audio that arrives after its playout time is cut instead of played late");
    lateness.reset();
    lateness.note(-300);
    expect(lateness.targetFrames() == VoiceLatenessTracker::BinFrames &&
               lateness.latestFrames() == -300,
           "an early packet needs no delay but is still reported for diagnostics");
    expect(signedMediaTimelineDistance(1'000, 900) == -100 &&
               signedMediaTimelineDistance(900, 1'000) == 100,
           "timeline distance is signed so early and late packets are distinguished");
}

} // namespace Tests
