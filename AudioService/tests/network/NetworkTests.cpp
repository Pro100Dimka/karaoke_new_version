#include "TestHarness.hpp"
#include "app/AudioService.hpp"
#include "backend/fake/FakeAudioBackend.hpp"
#include "media/WavDecoder.hpp"
#include "network/AdaptiveJitterBuffer.hpp"
#include "network/NetworkAudioEngine.hpp"
#include "network/NetworkPacket.hpp"
#include "network/OpusCodec.hpp"
#include "network/PcmVoiceCodec.hpp"
#include "network/UdpSocket.hpp"
#include "relay/NativeVoiceRelay.hpp"
#include "realtime/RealtimeInstrumentation.hpp"

#include <atomic>
#include <chrono>
#include <cmath>
#include <cstdio>
#include <fstream>
#include <sstream>
#include <thread>
#include <vector>

struct NetworkTestAccess {
    static void excludeVoice(NetworkAudioEngine& engine, std::string_view participant) {
        auto* slot = engine.slotForId(participant);
        slot->timelineExcluded = true;
        slot->remoteStreamEpoch = 1;
        slot->recoveryPackets = 0;
    }
    static std::uint64_t sentPackets(const NetworkAudioEngine& engine) {
        return engine.packetsSent_.load(std::memory_order_acquire);
    }
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
    static bool traceRetainsVoiceAfterEmptyLateCuts(NetworkAudioEngine& engine) {
        engine.packetTraceEnabled_ = true;
        auto* slot = engine.slotForId("__room_server_mix__");
        if (!slot) return false;
        engine.resetPacketTrace(*slot);
        for (std::uint32_t sequence = 0; sequence < 100; ++sequence) {
            RoomPacketDecisionTrace event{};
            event.sequence = sequence;
            event.delivered = true;
            event.lateSkipFrames = 120;
            event.decision = "QUEUE_LATE";
            engine.notePacketDecision(*slot, event);
        }
        RoomPacketDecisionTrace voice{};
        voice.sequence = 100;
        voice.delivered = true;
        voice.nonzero = true;
        voice.lateSkipFrames = 120;
        voice.decision = "QUEUE_LATE";
        engine.notePacketDecision(*slot, voice);
        return std::any_of(slot->packetTrace.begin(), slot->packetTrace.end(),
                           [](const RoomPacketDecisionTrace& event) {
                               return event.sequence == 100 && event.nonzero;
                           });
    }
    static bool queueVoice(NetworkAudioEngine& engine, std::string_view participant,
                           std::span<const float> samples, bool real = true) {
        auto* slot = engine.slotForId(participant);
        return slot && slot->queue.push(samples, static_cast<std::uint32_t>(samples.size()),
                                        static_cast<std::uint8_t>(real));
    }
    static void noteVoiceDecision(NetworkAudioEngine& engine, std::string_view participant,
                                  std::uint32_t sequence, bool late) {
        engine.packetTraceEnabled_ = true;
        auto* slot = engine.slotForId(participant);
        RoomPacketDecisionTrace event{};
        event.sequence = sequence;
        event.delivered = true;
        event.nonzero = true;
        event.lateSkipFrames = late ? 120U : 0U;
        event.decision = late ? "QUEUE_LATE" : "QUEUED";
        engine.notePacketDecision(*slot, event);
        if (late)
            engine.noteLateAudioCut(*slot, sequence + 1U,
                                    NetworkAudioEngine::LateCutKind::NonzeroVoice);
    }
    static void bypassRemoteEffects(NetworkAudioEngine& engine, std::string_view participant) {
        engine.slotForId(participant)->effects->setEnabled(false);
    }
    static void clearRemoteQueue(NetworkAudioEngine& engine, std::string_view participant) {
        engine.slotForId(participant)->queue.clear();
    }
    static void useSinglePacketReorder(NetworkAudioEngine& engine, std::string_view participant,
                                       std::uint32_t maximumPackets = 12) {
        auto* slot = engine.slotForId(participant);
        std::lock_guard lock(slot->jitterMutex);
        slot->jitter.configure(1, maximumPackets);
        slot->jitter.reset();
    }
    static void pumpRemotePackets(NetworkAudioEngine& engine, std::string_view participant,
                                   std::optional<NetworkAudioPacket> packet = std::nullopt,
                                   bool drain = true) {
        std::lock_guard lock(engine.remoteMutex_);
        if (packet)
            engine.slotForId(participant)->jitter.push(std::move(*packet));
        if (drain)
            engine.drainRemotePackets(engine.generation_.load(std::memory_order_acquire));
    }
    static void bindReceiverBeforeWorker(NetworkAudioEngine& engine, std::string_view participant) {
        engine.socket_.bind(0);
        engine.socket_.setReceiveTimeoutMs(2);
        engine.localPort_ = engine.socket_.localPort();
        engine.slotForId(participant)->remoteStreamEpoch = 1;
        engine.running_.store(true);
    }
    static void startBoundReceiverWorker(NetworkAudioEngine& engine) {
        engine.receiveThread_ = std::thread(&NetworkAudioEngine::receiveMain, &engine);
    }
    static std::pair<std::uint64_t, std::uint32_t>
    renderPosition(NetworkAudioEngine& engine, std::string_view participant) {
        const auto position = engine.renderPositionFor(*engine.slotForId(participant));
        return {position.timelineFrame, position.queueFrames};
    }
    static void beginRenderBeforeQueuePop(NetworkAudioEngine& engine) {
        engine.renderPositionVersion_.fetch_add(1, std::memory_order_acq_rel);
        engine.localTimelineFrame_.store(480, std::memory_order_release);
    }
    static void finishRenderAfterQueuePop(NetworkAudioEngine& engine, std::string_view participant) {
        std::array<float, 480> output{};
        (void)engine.slotForId(participant)->queue.pop(output, 480);
        engine.renderPositionVersion_.fetch_add(1, std::memory_order_release);
        engine.renderPositionVersion_.notify_all();
    }
    static void primeSharedTimeline(NetworkAudioEngine& engine, std::string_view participant,
                                    std::uint32_t frames) {
        auto* slot = engine.slotForId(participant);
        std::vector<float> audio(frames, 0.1F);
        if (slot && slot->queue.push(audio, frames))
            slot->timelineInitialized = true;
    }
    static void setRemoteStreamEpoch(NetworkAudioEngine& engine, std::string_view participant,
                                     std::uint32_t epoch) {
        engine.slotForId(participant)->remoteStreamEpoch = epoch;
    }
    static bool timelineInitialized(NetworkAudioEngine& engine, std::string_view participant) {
        std::lock_guard lock(engine.remoteMutex_);
        const auto* slot = engine.slotForId(participant);
        return slot && slot->timelineInitialized;
    }
    static std::uint32_t queuedFrames(NetworkAudioEngine& engine, std::string_view participant) {
        std::lock_guard lock(engine.remoteMutex_);
        const auto* slot = engine.slotForId(participant);
        return slot ? slot->queue.availableFrames() : 0U;
    }
    static void seedLateCutSeries(NetworkAudioEngine& engine, std::string_view participant,
                                  std::uint32_t current, std::uint32_t maximum) {
        auto* slot = engine.slotForId(participant);
        if (!slot) return;
        slot->consecutiveLateAudioCuts.store(current);
        slot->maximumConsecutiveLateAudioCuts.store(maximum);
    }
    static std::pair<std::uint32_t, std::uint32_t>
    lateCutSeries(NetworkAudioEngine& engine, std::string_view participant) {
        const auto* slot = engine.slotForId(participant);
        return slot ? std::pair{slot->consecutiveLateAudioCuts.load(),
                                slot->maximumConsecutiveLateAudioCuts.load()}
                    : std::pair{0U, 0U};
    }
    static void seedMeasuredServerMixRoute(NetworkAudioEngine& engine,
                                           std::uint32_t collectionFrames) {
        auto* slot = engine.slotForId("__room_server_mix__");
        Tests::expect(slot != nullptr, "the measured server-mix slot exists");
        if (!slot)
            return;
        constexpr std::uint32_t IngressFrames = 30U * 48U;
        constexpr std::uint32_t ReturnFrames = 40U * 48U;
        for (std::uint32_t packet = 0; packet < room_audio_contract::ReturnCalibrationPackets;
             ++packet) {
            slot->lateness.note(IngressFrames + collectionFrames + ReturnFrames);
            slot->returnRoute.note(ReturnFrames);
            slot->arrivalRoute.note(IngressFrames);
        }
        slot->remoteStreamEpoch = 7;
        engine.advertisedTargetDelayFrames_.store(80U * 48U, std::memory_order_release);
    }
    static void seedDirectReadyVoice(NetworkAudioEngine& engine, std::string_view participant) {
        auto* slot = engine.slotForId(participant);
        Tests::expect(slot != nullptr, "the direct singer is registered");
        if (!slot) return;
        for (std::uint32_t packet = 0; packet < VoiceLatenessTracker::WindowPackets; ++packet) {
            slot->lateness.note(50U * 48U);
            slot->readyLateness.note(packet == 0 ? 130U * 48U : 75U * 48U);
        }
        slot->directFirstPackets.store(VoiceLatenessTracker::WindowPackets,
                                       std::memory_order_relaxed);
        slot->lastPacketMicros.store(static_cast<std::uint64_t>(
            std::chrono::duration_cast<std::chrono::microseconds>(
                std::chrono::steady_clock::now().time_since_epoch()).count()),
            std::memory_order_relaxed);
        slot->lastRoutePacketMicros = slot->lastPacketMicros.load(std::memory_order_relaxed);
        engine.advertisedTargetDelayFrames_.store(160U * 48U, std::memory_order_release);
    }
    static void seedRouteMeasurement(NetworkAudioEngine& engine, std::string_view participant,
                                     std::uint32_t packets) {
        auto* slot = engine.slotForId(participant);
        Tests::expect(slot != nullptr, "the measured route belongs to a registered singer");
        if (!slot) return;
        for (std::uint32_t packet = 0; packet < packets; ++packet) {
            slot->readyLateness.note(35U * 48U);
            slot->stableLateness.note(35U * 48U);
        }
        slot->remoteStreamEpoch = 1;
        slot->directFirstPackets.store(packets, std::memory_order_relaxed);
        slot->lastPacketMicros.store(static_cast<std::uint64_t>(
            std::chrono::duration_cast<std::chrono::microseconds>(
                std::chrono::steady_clock::now().time_since_epoch()).count()),
            std::memory_order_relaxed);
        slot->lastRoutePacketMicros = slot->lastPacketMicros.load(std::memory_order_relaxed);
        // Reproduce the live bug: conversation compensation is already at its safe ceiling.
        engine.advertisedTargetDelayFrames_.store(250U * 48U, std::memory_order_release);
    }
    static void expireRouteMeasurement(NetworkAudioEngine& engine, std::string_view participant) {
        auto* slot = engine.slotForId(participant);
        slot->lastPacketMicros.store(0, std::memory_order_relaxed);
        slot->lastRoutePacketMicros = 0;
    }
};

namespace Tests {
void masterCompanionRecordsTheExactRenderedBacking() {
    constexpr std::uint32_t frames = 480, blocks = 32;
    const auto musicPath = tempRoot / "companion-source-44100.wav";
    makeTestWav(musicPath, 44'100, 44'100);
    auto backend = std::make_unique<FakeAudioBackend>();
    auto* fake = backend.get();
    AudioService service{std::move(backend)};
    service.start();
    service.session().prepare({});
    service.session().start();
    service.realtime().setMicrophoneEnabled(false);
    service.realtime().setMonitoring(false);
    service.realtime().setMixerGains(MixerGains{.music = 0.4F, .remote = 0.7F, .master = 0.5F});
    expect(service.network().addRemoteParticipant("companion-remote"), "remote voice slot exists");
    service.network().setRoomClock(1'000'000, 1'000'000);
    service.media().load(MediaSlot::Music, musicPath.string());
    expect(service.media().waitUntilReady(MediaSlot::Music) == PlaybackState::Ready,
           "44.1 kHz backing is decoded for ordinary 48 kHz rendering");
    const auto filledBy = std::chrono::steady_clock::now() + std::chrono::seconds(3);
    while (service.media().snapshot(MediaSlot::Music).bufferFillFrames < frames * blocks &&
           std::chrono::steady_clock::now() < filledBy)
        std::this_thread::yield();
    const auto path = tempRoot / "companion-master.wav";
    expect(service.handleLine("1|PrepareRecording|id=paired|tap=master|backing=true|path=" +
                              path.string()).status == ControlStatus::Ok &&
               service.handleLine("1|StartRecording").status == ControlStatus::Ok,
           "master can request its exact simultaneous backing companion");
    service.media().play(MediaContext::Karaoke);
    std::vector<float> input(frames), output(frames * 2U), remote(frames);
    std::vector<float> processedRemote(frames);
    DspChain remoteDsp;
    remoteDsp.prepare(48'000, frames, 1);
    remoteDsp.setEnabled(true);
    std::vector<float> expectedMaster, expectedBacking;
    expectedMaster.reserve(frames * blocks * 2U);
    expectedBacking.reserve(frames * blocks * 2U);
    for (std::uint32_t block = 0; block < blocks; ++block) {
        for (std::uint32_t frame = 0; frame < frames; ++frame)
            remote[frame] = 0.05F * std::sin((block * frames + frame) * 0.037F);
        expect(NetworkTestAccess::queueVoice(service.network(), "companion-remote", remote),
               "the known remote waveform enters the ordinary remote render queue");
        std::copy(remote.begin(), remote.end(), processedRemote.begin());
        remoteDsp.process(processedRemote, frames);
        RealtimeInstrumentation::reset();
        fake->pump(input, 1, output, 2, block * frames, block * frames);
        const auto rt = RealtimeInstrumentation::snapshot();
        expect(rt.allocations == 0 && rt.deallocations == 0 && rt.blockingCalls == 0 &&
                   rt.diskIoCalls == 0 && rt.networkIoCalls == 0 && rt.ipcCalls == 0,
               "paired recording has no realtime allocation, blocking or I/O");
        expectedMaster.insert(expectedMaster.end(), output.begin(), output.end());
        for (std::uint32_t frame = 0; frame < frames; ++frame)
            for (std::uint32_t channel = 0; channel < 2U; ++channel)
                expectedBacking.push_back(output[frame * 2U + channel] - processedRemote[frame] * 0.7F);
    }
    expect(service.handleLine("1|StopRecording").status == ControlStatus::Ok,
           "master and companion finalize together");
    const auto backingPath = path.string() + ".backing.wav";
    expect(std::filesystem::exists(backingPath), "the optional exact rendered backing WAV exists");
    if (!std::filesystem::exists(backingPath))
        return;
    for (const auto& [file, expected] : {
             std::pair{path.string(), std::span<const float>{expectedMaster}},
             std::pair{backingPath, std::span<const float>{expectedBacking}}}) {
        WavDecoder decoder;
        const auto format = decoder.open(file);
        std::vector<float> actual(expected.size());
        expect(format.sampleRateHz == 48'000 && format.channels == 2 &&
                   format.totalFrames == frames * blocks &&
                   decoder.read(actual, frames * blocks) == frames * blocks,
               "both files have identical format, start sample and duration");
        float maximumError = 0.0F;
        for (std::size_t sample = 0; sample < actual.size(); ++sample)
            maximumError = std::max(maximumError, std::abs(actual[sample] - expected[sample]));
        expect(maximumError < 0.00005F,
               "companion is the exact rendered, gained backing; master additionally has voice");
    }
}

void roomQueuePositionCannotCombineANewRenderCursorWithOldPcm() {
    NetworkAudioEngine engine;
    engine.prepare(48'000, 1, 1'440, 120, GenerationId{1});
    expect(engine.addRemoteParticipant("singer"), "room singer registers");
    const std::vector<float> samples(720, 0.1F);
    expect(NetworkTestAccess::queueVoice(engine, "singer", samples), "PCM waits for render");
    NetworkTestAccess::beginRenderBeforeQueuePop(engine);
    std::atomic<bool> started{false}, finished{false};
    std::pair<std::uint64_t, std::uint32_t> position{};
    std::thread reader([&] {
        started.store(true, std::memory_order_release);
        position = NetworkTestAccess::renderPosition(engine, "singer");
        finished.store(true, std::memory_order_release);
    });
    while (!started.load(std::memory_order_acquire))
        std::this_thread::yield();
    std::this_thread::sleep_for(std::chrono::milliseconds(10));
    const auto returnedBeforePop = finished.load(std::memory_order_acquire);
    NetworkTestAccess::finishRenderAfterQueuePop(engine, "singer");
    reader.join();
    expect(!returnedBeforePop && position == std::pair<std::uint64_t, std::uint32_t>{480, 240},
           "a packet sees the cursor and PCM queue from the same render step");
}

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

void outgoingVoiceSeparatesSocketSendTimeFromCaptureCadence() {
    UdpSocket relay, peer;
    relay.bind(0);
    peer.bind(0);
    relay.setReceiveTimeoutMs(1000);
    peer.setReceiveTimeoutMs(1000);
    NetworkAudioEngine engine;
    constexpr auto frames = 48000 / VoicePacketsPerSecond;
    engine.prepare(48000, 1, 1024, frames, GenerationId{1});
    expect(engine.setDirectPeer("peer", "127.0.0.1", peer.localPort(), 42), "direct peer configured");
    NetworkTestAccess::queueBeforeSenderStarts(engine);
    NetworkTestAccess::startQueuedSender(engine, relay.localPort());
    std::vector<float> pcm(frames, 0.1F);
    std::array<std::byte, 2048> bytes{};
    for (unsigned i = 0; i < 4; ++i) {
        engine.pushLocal(GenerationId{1}, pcm, frames, 48000 + i * frames);
        expect(relay.receive(bytes) > 0 && peer.receive(bytes) > 0,
               "both routes receive the captured voice");
    }
    engine.stop();
    const auto measured = engine.diagnostics();
    expect(measured.relaySendMaximumMicros > 0 && measured.directSendMaximumMicros > 0,
           "socket submission durations are measured separately for both routes");
    engine.prepare(48000, 1, 1024, frames, GenerationId{2});
    const auto reset = engine.diagnostics();
    expect(reset.relaySendMaximumMicros == 0 && reset.directSendMaximumMicros == 0,
           "new audio preparation clears previous route submission measurements");
}

void outgoingVoiceDiagnosticsExposeTheClientSendCadence() {
    UdpSocket receiver;
    receiver.bind(0);
    receiver.setReceiveTimeoutMs(1000);
    NetworkAudioEngine engine;
    constexpr std::uint32_t packetFrames = 48'000 / VoicePacketsPerSecond;
    engine.prepare(48'000, 1, 1024, packetFrames, GenerationId{7});
    NetworkTestAccess::queueBeforeSenderStarts(engine);
    NetworkTestAccess::startQueuedSender(engine, receiver.localPort());
    const std::vector<float> pcm(packetFrames, 0.1F);
    std::array<std::byte, 2048> bytes{};

    engine.pushLocal(GenerationId{7}, pcm, packetFrames, 48'000);
    expect(receiver.receive(bytes) > 0, "the first diagnostic packet is sent");
    std::this_thread::sleep_for(std::chrono::milliseconds(30));
    engine.pushLocal(GenerationId{7}, pcm, packetFrames, 48'120);
    expect(receiver.receive(bytes) > 0, "the second diagnostic packet is sent");

    const auto codecDelay = OpusVoiceEncoder(48'000, 1).lookaheadFrames();
    auto diagnostics = engine.diagnostics();
    const auto deadline = std::chrono::steady_clock::now() + std::chrono::seconds(1);
    while ((diagnostics.lastSendTimelineFrame != 48'120 - codecDelay ||
            diagnostics.sendGapMaximumTimelineFrame != 48'120 - codecDelay ||
            diagnostics.sendGapLatestMicros < 20'000) &&
           std::chrono::steady_clock::now() < deadline) {
        std::this_thread::sleep_for(std::chrono::milliseconds(1));
        diagnostics = engine.diagnostics();
    }
    expect(diagnostics.sendGapLatestMicros >= 20'000,
           "client send diagnostics retain a real gap between voice packets");
    expect(diagnostics.sendGapMaximumMicros >= diagnostics.sendGapLatestMicros,
           "client send diagnostics retain the maximum observed gap");
    expect(diagnostics.sendGapMaximumTimelineFrame == 48'120 - codecDelay &&
               diagnostics.sendGapMaximumGeneration == GenerationId{7} &&
               diagnostics.sendGapMaximumStreamEpoch != 0,
           "the maximum client send gap retains its matching position and generation");
    expect(diagnostics.lastSendTimelineFrame == 48'120 - codecDelay,
           "client send diagnostics identify the musical position after the gap");
    expect(diagnostics.lastSendGeneration == GenerationId{7},
           "client send diagnostics identify the performance generation");
    expect(diagnostics.lastSendStreamEpoch != 0,
           "client send diagnostics identify the network stream epoch");
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

void microphoneUpstreamDoesNotWaitForRender() {
    for (const auto inputRate : {48'000U, 44'100U}) {
        FakeBackendSettings settings;
        settings.runtime.inputSampleRateHz = inputRate;
        AudioService service{std::make_unique<FakeAudioBackend>(settings)};
        service.start();
        service.session().prepare({});
        service.session().start();
        service.network().setRoomClock(1'000'000, 1'000'000);
        service.network().setSharedTimeline(true);
        service.realtime().setMonitoring(false);
        service.realtime().setMixerGains(MixerGains{.microphone = 0.5F});
        service.realtime().setDspEnabled(true);
        expect(service.realtime().setDspParameter("highpass.cutoffHz", 300.0F),
               "capture uses the selected processing");
        UdpSocket receiver;
        receiver.bind(0);
        receiver.setReceiveTimeoutMs(250);
        service.network().startSend("127.0.0.1", receiver.localPort());
        const auto frames = inputRate / 100U;
        std::vector<float> input(frames, 0.2F), processed(frames * 2U, 0.2F);
        DspChain expectedDsp;
        expectedDsp.prepare(inputRate, frames, 2);
        expectedDsp.setEnabled(true);
        expect(expectedDsp.setParameter("highpass.cutoffHz", 300.0F), "reference DSP configured");
        expectedDsp.process(processed, frames);
        BackendAudioBuffer capture{input.data(), nullptr, frames, 1};
        capture.captureTicks = 1'000'000'000;
        RealtimeInstrumentation::reset();
        service.realtime().onCapture(service.session().generationId(), capture);
        const auto violations = RealtimeInstrumentation::snapshot();
        expect(violations.allocations == 0 && violations.blockingCalls == 0 &&
                   violations.networkIoCalls == 0,
               "capture hands off to the existing sender without realtime allocation or IO");
        std::array<std::byte, 2048> bytes{};
        std::optional<AudioPacketHeader> previous;
        std::uint32_t packets = 0, consumed = 0;
        while (packets < 4) {
            const auto size = receiver.receive(bytes);
            AudioPacketHeader header{};
            expect(size > AudioPacketHeaderBytes && decodeAudioPacketHeader(bytes, header),
                   "microphone must reach UDP before any output callback, even with monitoring off");
            if (size <= AudioPacketHeaderBytes)
                break;
            if (previous && previous->sequence == header.sequence)
                continue;
            expect((header.timestampFrame & MediaTimelineMask) == 48'000U + packets * 120U,
                   "capture timestamp and continuous packet order survive different device rates");
            const auto count = deviceFramesForVoicePacket(packets, inputRate);
            std::vector<float> mono(count);
            for (std::uint32_t frame = 0; frame < count; ++frame)
                mono[frame] = processed[(consumed + frame) * 2U] * 0.5F;
            const auto expected = retimeInterleavedLinear(mono, 1, 120);
            const auto actual = PcmVoiceCodec::decode(
                std::span<const std::byte>{bytes.data() + AudioPacketHeaderBytes,
                                          size - AudioPacketHeaderBytes}, 120);
            expect(actual.size() == expected.size(), "one complete processed voice packet");
            for (std::size_t frame = 0; frame < actual.size(); ++frame)
                expect(std::abs(actual[frame] - expected[frame]) < 0.00004F,
                       "upstream preserves DSP, microphone gain and rate conversion");
            consumed += count;
            previous = header;
            ++packets;
        }
        if (!previous) {
            service.session().stop();
            continue;
        }
        std::vector<float> output(480 * 2U);
        service.realtime().onRender(service.session().generationId(),
                                    {nullptr, output.data(), 480, 2});
        expect(std::ranges::all_of(output, [](float sample) { return sample == 0.0F; }),
               "monitoring off stays silent locally after the independent upstream send");
        while (const auto size = receiver.receive(bytes)) {
            AudioPacketHeader header{};
            expect(decodeAudioPacketHeader(bytes, header) && header.sequence == previous->sequence,
                   "render does not send the captured voice a second time");
        }
        service.session().stop();
    }
}

void sharedTimelineSenderKeepsContinuousPcmAcrossClockSteering() {
    constexpr std::uint32_t Rate = 48'000, Block = 480, Blocks = 32;
    for (const auto direction : {-1, 1}) {
        UdpSocket receiver;
        receiver.bind(0);
        receiver.setReceiveTimeoutMs(250);
        NetworkAudioEngine engine;
        engine.prepare(Rate, 1, Block * Blocks, SharedRoomPacketFrames, GenerationId{1});
        engine.setSharedTimeline(true);
        NetworkTestAccess::queueBeforeSenderStarts(engine);
        const std::uint64_t start = Rate + (direction > 0 ? 119U : 0U);
        std::vector<float> pcm(Block);
        for (std::uint32_t block = 0; block < Blocks; ++block) {
            for (std::uint32_t frame = 0; frame < Block; ++frame)
                pcm[frame] = 0.1F + 0.8F * static_cast<float>(block * Block + frame) /
                                        static_cast<float>(Block * Blocks);
            const auto measured =
                static_cast<std::uint64_t>(static_cast<std::int64_t>(start + block * Block) +
                                           (block == 0 ? 0 : direction * 120));
            engine.pushLocal(GenerationId{1}, pcm, Block, measured);
        }
        NetworkTestAccess::startQueuedSender(engine, receiver.localPort());
        std::array<std::byte, 2048> bytes{};
        std::optional<AudioPacketHeader> previous;
        std::vector<float> decoded;
        std::uint32_t packets = 0, brokenJoins = 0;
        for (;;) {
            const auto size = receiver.receive(bytes);
            if (size == 0)
                break;
            AudioPacketHeader header{};
            expect(decodeAudioPacketHeader(std::span<const std::byte>{bytes.data(), size}, header),
                   "clock-steered sender emits a valid wire packet");
            if (previous && header.sequence == previous->sequence)
                continue; // The shared transport intentionally sends each datagram twice.
            const auto timestamp = header.timestampFrame & MediaTimelineMask;
            expect(header.codec == VoiceCodec::Pcm16 && header.frames == SharedRoomPacketFrames &&
                       timestamp % SharedRoomPacketFrames == 0,
                   "clock-steered PCM retains the fixed room packet grid and duration");
            if (previous &&
                (header.sequence != previous->sequence + 1U ||
                 signedMediaTimelineDistance(previous->timestampFrame & MediaTimelineMask,
                                             timestamp) != SharedRoomPacketFrames))
                ++brokenJoins;
            const auto samples = PcmVoiceCodec::decode(
                std::span<const std::byte>{bytes.data() + AudioPacketHeaderBytes,
                                           size - AudioPacketHeaderBytes},
                header.frames);
            decoded.insert(decoded.end(), samples.begin(), samples.end());
            previous = header;
            ++packets;
        }
        engine.stop();
        expect(brokenJoins == 0,
               "gentle clock steering cannot duplicate or skip a whole musical packet");
        expect(packets >= 127 && packets <= 129 && !decoded.empty() && decoded.back() > 0.89F,
               "clock correction preserves the supplied PCM duration instead of dropping blocks");
        bool coherent = !decoded.empty() && std::abs(decoded.front() - 0.1F) < 0.0001F;
        for (std::size_t sample = 1; sample < decoded.size(); ++sample)
            coherent = coherent && decoded[sample] >= decoded[sample - 1] &&
                       decoded[sample] - decoded[sample - 1] < 0.0002F;
        expect(coherent, "retimed ramp remains coherent without whole-packet PCM cuts or replay");
        expect(engine.diagnostics().droppedSendBlocks == 0,
               "the regression does not manufacture a queue overflow");
    }
}

void sharedTimelineSenderDoesNotRetimeAcrossARealCaptureGap() {
    UdpSocket receiver;
    receiver.bind(0);
    receiver.setReceiveTimeoutMs(250);
    NetworkAudioEngine engine;
    for (const auto generation : {GenerationId{1}, GenerationId{2}}) {
        engine.prepare(48'000, 1, 1024, SharedRoomPacketFrames, generation);
        engine.setSharedTimeline(true);
        NetworkTestAccess::queueBeforeSenderStarts(engine);
        engine.pushLocal(generation, std::vector<float>(130, 0.25F), 130, 48'000);
        engine.pushLocal(generation, std::vector<float>(240, 0.75F), 240, 52'930);
        NetworkTestAccess::startQueuedSender(engine, receiver.localPort());
        std::array<std::byte, 2048> bytes{};
        std::vector<AudioPacketHeader> headers;
        std::vector<std::vector<float>> payloads;
        for (;;) {
            const auto size = receiver.receive(bytes);
            if (size == 0)
                break;
            AudioPacketHeader header{};
            expect(decodeAudioPacketHeader(std::span<const std::byte>{bytes.data(), size}, header),
                   "real-gap regression receives a valid voice packet");
            if (!headers.empty() && header.sequence == headers.back().sequence)
                continue;
            headers.push_back(header);
            payloads.push_back(PcmVoiceCodec::decode(
                std::span<const std::byte>{bytes.data() + AudioPacketHeaderBytes,
                                           size - AudioPacketHeaderBytes},
                header.frames));
        }
        engine.stop();
        expect(headers.size() == 4,
               "partial PCM before a real gap is not joined to the next capture block");
        if (headers.size() < 3 || payloads[1].size() != SharedRoomPacketFrames)
            continue;
        expect((headers[1].timestampFrame & MediaTimelineMask) == 48'120 &&
                   (headers[2].timestampFrame & MediaTimelineMask) == 52'920,
               "the sender preserves the actual >50ms gap and reanchors after prepare/restart");
        bool exactTail = true;
        for (std::size_t frame = 0; frame < payloads[1].size(); ++frame)
            exactTail =
                exactTail && std::abs(payloads[1][frame] - (frame < 10 ? 0.25F : 0.0F)) < 0.0001F;
        expect(exactTail, "missing capture time stays silent instead of borrowing future PCM");
    }
}

void sharedTimelineSenderTracksLongClockDriftWithoutTimelineHoles() {
    constexpr std::uint32_t Seconds = 30;
    constexpr std::array rates{
        std::pair{48'000U, 48'000U}, std::pair{44'100U, 44'100U},
        std::pair{44'100U, 48'000U}, std::pair{48'000U, 44'100U}};
    for (const auto [rate, renderRate] : rates) {
        for (const auto direction : {-1, 1}) {
            UdpSocket receiver;
            receiver.bind(0);
            receiver.setReceiveTimeoutMs(500);
            NetworkAudioEngine engine;
            const auto blockFrames = rate / 100U;
            const auto totalFrames = rate * Seconds;
            engine.prepare(renderRate, 1, rate, SharedRoomPacketFrames, GenerationId{1}, rate);
            engine.setSharedTimeline(true);
            NetworkTestAccess::queueBeforeSenderStarts(engine);
            NetworkTestAccess::startQueuedSender(engine, receiver.localPort());
            std::atomic<std::uint32_t> received{0};
            std::atomic<bool> stop{false}, producerFinished{false};
            std::thread producer([&] {
                std::vector<float> pcm(blockFrames);
                for (std::uint32_t offset = 0; offset < totalFrames && !stop.load();
                     offset += blockFrames) {
                    // A bounded wire window keeps this deterministic fast simulation independent
                    // of the operating system's UDP receive-buffer capacity.
                    while (offset > static_cast<std::uint64_t>(received.load()) * rate /
                                            VoicePacketsPerSecond +
                                        rate / 20U &&
                           !stop.load())
                        std::this_thread::yield();
                    for (std::uint32_t frame = 0; frame < blockFrames; ++frame)
                        pcm[frame] = 0.1F + 0.8F * static_cast<float>(offset + frame) /
                                                static_cast<float>(totalFrames);
                    const auto measured = static_cast<std::uint64_t>(
                        static_cast<std::int64_t>(rate + offset) +
                        direction * static_cast<std::int64_t>(offset / 1'000U));
                    // Capture PCM retains its own rate; the public timestamp is in render frames.
                    engine.pushLocal(GenerationId{1}, pcm, blockFrames,
                                     scaleFramePosition(measured, rate, renderRate));
                }
                producerFinished.store(true);
            });
            std::array<std::byte, 2048> bytes{};
            std::optional<AudioPacketHeader> previous;
            std::uint32_t brokenJoins = 0;
            double worstClockError = 0.0;
            bool coherent = true;
            float lastSample = 0.1F;
            for (;;) {
                const auto size = receiver.receive(bytes);
                if (size == 0)
                    break;
                AudioPacketHeader header{};
                if (!decodeAudioPacketHeader(std::span<const std::byte>{bytes.data(), size},
                                             header)) {
                    coherent = false;
                    break;
                }
                if (previous && previous->sequence == header.sequence)
                    continue;
                const auto timestamp = header.timestampFrame & MediaTimelineMask;
                if (timestamp % SharedRoomPacketFrames != 0 ||
                    (previous &&
                     (header.sequence != previous->sequence + 1U ||
                      signedMediaTimelineDistance(previous->timestampFrame & MediaTimelineMask,
                                                  timestamp) != SharedRoomPacketFrames)))
                    ++brokenJoins;
                const auto pcm = PcmVoiceCodec::decode(
                    std::span<const std::byte>{bytes.data() + AudioPacketHeaderBytes,
                                               size - AudioPacketHeaderBytes},
                    header.frames);
                if (pcm.size() != SharedRoomPacketFrames) {
                    coherent = false;
                    break;
                }
                // Recover source position from an independent PCM ramp, including PCM16 error.
                // A timestamp-only clamp drifts by 30ms and fails this 5ms bound.
                const auto sourceFrame =
                    (static_cast<double>(pcm.front()) - 0.1) * totalFrames / 0.8;
                const auto actualSeconds = 1.0 + sourceFrame * (1.0 + direction / 1000.0) / rate;
                worstClockError =
                    std::max(worstClockError,
                             std::abs(static_cast<double>(timestamp) / VoiceProtocolSampleRateHz -
                                      actualSeconds));
                for (const auto sample : pcm) {
                    coherent = coherent && sample >= lastSample - 0.00004F &&
                               sample - lastSample < 0.00008F;
                    lastSample = sample;
                }
                previous = header;
                received.fetch_add(1);
            }
            stop.store(true);
            producer.join();
            engine.stop();
            const auto expectedSeconds = Seconds * (1.0 + direction / 1000.0);
            const auto emittedSeconds =
                static_cast<double>(received.load()) / VoicePacketsPerSecond;
            expect(
                producerFinished.load() && std::abs(emittedSeconds - expectedSeconds) < 0.006,
                "long clock drift is corrected in PCM duration rather than accumulated or dropped");
            expect(brokenJoins == 0 && coherent && lastSample > 0.899F,
                   "30 seconds of either clock drift preserve ordered PCM and continuous room "
                   "positions");
            expect(worstClockError < 0.005,
                   "packet PCM remains within five milliseconds of its measured source clock");
            expect(engine.diagnostics().droppedSendBlocks == 0,
                   "the clock-drift regression never overflows the sender queue");
        }
    }
}

void sharedTimelineSenderWaitsForPcmAndReanchorsOnGenerationChange() {
    UdpSocket receiver;
    receiver.bind(0);
    receiver.setReceiveTimeoutMs(50);
    NetworkAudioEngine engine;
    engine.prepare(48'000, 1, 1024, SharedRoomPacketFrames, GenerationId{1});
    engine.setSharedTimeline(true);
    engine.startSend("127.0.0.1", receiver.localPort());
    std::array<std::byte, 2048> bytes{};
    const auto receivePacket = [&] {
        AudioPacketHeader header{};
        const auto size = receiver.receive(bytes);
        expect(decodeAudioPacketHeader(std::span<const std::byte>{bytes.data(), size}, header),
               "a woken sender emits the next complete packet");
        expect(receiver.receive(bytes) == size, "the redundant copy is also drained");
        return header.timestampFrame & MediaTimelineMask;
    };
    engine.pushLocal(GenerationId{1}, std::vector<float>(121, 0.25F), 121, 48'000);
    expect(receivePacket() == 48'000, "the first packet establishes the shared cursor");
    expect(receiver.receive(bytes) == 0,
           "an incomplete normal packet waits for actual PCM instead of padding or spinning");
    engine.pushLocal(GenerationId{1}, std::vector<float>(119, 0.25F), 119, 48'121);
    expect(receivePacket() == 48'120,
           "new PCM wakes the sender without moving the waiting packet's timeline");
    engine.setGeneration(GenerationId{2});
    engine.pushLocal(GenerationId{2}, std::vector<float>(120, 0.75F), 120, 49'080);
    expect(receivePacket() == 49'080,
           "a generation change reanchors even a sub-50ms source change");
    engine.stop();
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
    std::array<float, 240> input{};
    std::vector<float> output(480);
    std::array<std::byte, 2048> bytes{};
    std::optional<std::uint32_t> previousSequence;
    for (std::size_t index = 0; index < timestamps.size(); ++index) {
        service.realtime().onCapture(service.session().generationId(),
                                     {input.data(), nullptr, 240, 1,
                                      static_cast<std::int64_t>(index * 240),
                                      monotonicTicksNow() - 5'000'000});
        service.realtime().onRender(service.session().generationId(),
                                    {nullptr, output.data(), 240, 2});
        AudioPacketHeader packet;
        do {
            const auto size = receiver.receive(bytes);
            const auto valid = decodeAudioPacketHeader(
                std::span<const std::byte>{bytes.data(), size}, packet);
            expect(valid, "idle voice produces a valid audio packet");
            if (!valid)
                return;
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

void roomVoiceHeterogeneousDevicesReachTheFinalMasterInBothDirections() {
    struct DeviceDomain {
        const char* name;
        std::uint32_t rate;
        std::uint32_t period;
        std::uint32_t buffer;
    };
    struct Pair {
        DeviceDomain first;
        DeviceDomain second;
        double firstDrift;
        double secondDrift;
        bool recreateSecond{false};
    };
    constexpr DeviceDomain asio48{"ASIO 48k/64", 48'000, 64, 64};
    constexpr DeviceDomain asio48_128{"ASIO 48k/128", 48'000, 128, 128};
    constexpr DeviceDomain asio44_64{"ASIO 44.1k/64", 44'100, 64, 64};
    constexpr DeviceDomain asio44{"ASIO 44.1k/128", 44'100, 128, 128};
    constexpr DeviceDomain asio96{"ASIO 96k/256", 96'000, 256, 256};
    constexpr DeviceDomain shared48{"WASAPI Shared 48k/480", 48'000, 480, 1'056};
    constexpr DeviceDomain shared48_512{"WASAPI Shared 48k/512", 48'000, 512, 1'056};
    constexpr DeviceDomain shared44{"WASAPI Shared 44.1k/441", 44'100, 441, 970};
    constexpr DeviceDomain shared44_480{"WASAPI Shared 44.1k/480", 44'100, 480, 970};
    constexpr DeviceDomain exclusive48{"WASAPI Exclusive 48k/128", 48'000, 128, 256};
    constexpr DeviceDomain exclusive44{"WASAPI Exclusive 44.1k/256", 44'100, 256, 512};
    constexpr std::array matrix{
        Pair{asio48, asio44, 75, -65},
        Pair{shared48, shared44, 75, -65},
        Pair{asio44_64, shared48_512, 75, -65},
        Pair{shared48_512, asio44_64, -75, 65},
        Pair{asio48_128, shared44_480, 75, -65},
        Pair{shared44_480, asio48_128, -75, 65, true},
        Pair{exclusive48, asio44, 75, -65},
        Pair{asio48, exclusive48, -75, 65},
        Pair{exclusive44, asio96, 75, -65},
        Pair{asio96, shared48_512, -75, 65}};

    const auto settingsFor = [](const DeviceDomain& domain, double drift) {
        FakeBackendSettings settings;
        settings.runtime.inputSampleRateHz = domain.rate;
        settings.runtime.outputSampleRateHz = domain.rate;
        settings.runtime.inputPeriodFrames = domain.period;
        settings.runtime.outputPeriodFrames = domain.period;
        settings.runtime.inputEndpointBufferFrames = domain.buffer;
        settings.runtime.outputEndpointBufferFrames = domain.buffer;
        settings.runtime.inputChannels = 1;
        settings.runtime.outputChannels = 2;
        settings.runtime.clockRelationship = ClockRelationship::Independent;
        settings.captureDriftPpm = drift;
        settings.renderDriftPpm = -drift;
        return settings;
    };

    for (const auto& test : matrix) {
        auto firstBackend =
            std::make_unique<FakeAudioBackend>(settingsFor(test.first, test.firstDrift));
        auto secondBackend =
            std::make_unique<FakeAudioBackend>(settingsFor(test.second, test.secondDrift));
        auto* firstDevice = firstBackend.get();
        auto* secondDevice = secondBackend.get();
        AudioService first{std::move(firstBackend)};
        AudioService second{std::move(secondBackend)};
        first.start();
        second.start();
        first.session().prepare({});
        second.session().prepare({});
        first.session().start();
        second.session().start();

        UdpSocket upstream, downstream;
        upstream.bind(0);
        downstream.bind(0);
        upstream.setReceiveTimeoutMs(1);
        constexpr std::uint64_t firstToken = 0x1111, secondToken = 0x2222;
        constexpr std::int64_t serverMicros = 1'790'000'000'000'000LL;
        const auto localMicros = static_cast<std::int64_t>(monotonicTicksNow() / 1'000);
        constexpr std::string_view room = "heterogeneous-room";
        const auto configure = [&](AudioService& service, std::string_view participant,
                                   std::uint64_t token) {
            service.network().setLocalParticipant(std::string(participant));
            service.network().setSessionToken(token);
            service.network().setRoomClock(serverMicros, localMicros);
            service.network().setSharedTimeline(true);
            service.network().setRoomPlayoutDelay(80.0F);
            expect(service.network().addRemoteParticipant("__room_server_mix__"),
                   "the heterogeneous receiver registers the real server-mix slot");
            service.network().startReceive(0);
            service.network().startSend("127.0.0.1", upstream.localPort());
        };
        configure(first, "first", firstToken);
        configure(second, "second", secondToken);

        NativeVoiceRelay relay;
        relay.expect(std::string(room), "first", firstToken);
        relay.expect(std::string(room), "second", secondToken);
        constexpr std::array<std::string_view, 2> eligible{"first", "second"};
        relay.setEligibleParticipants(room, eligible);
        relay.setRoomPlayoutDelay(room, 80.0);

        auto secondRate = test.second.rate;
        auto secondPeriod = test.second.period;
        const auto exercisesBackendSwitch = test.recreateSecond;
        std::vector<float> firstCapture(test.first.period), secondCapture(secondPeriod);
        std::vector<float> firstRender(test.first.period * 2U);
        std::vector<float> secondRender(secondPeriod * 2U);
        std::array<std::byte, 2'048> packetBytes{};
        double firstPhase = 0.0, secondPhase = 0.0;
        double firstCapturePosition = 0.0, firstRenderPosition = 0.0;
        double secondCapturePosition = 0.0, secondRenderPosition = 0.0;
        double firstPeak = 0.0, secondPeak = 0.0;
        double firstPeakAfterSwitch = 0.0, secondPeakAfterSwitch = 0.0;
        bool delivered = true;
        bool alignedPackets = true;
        bool backendSwitched = false;
        bool startupDiagnosticsReset = false;
        double maximumEmptyReadMilliseconds = 0.0;
        std::uint64_t emptyReads = 0;
        std::uint64_t receivedDatagrams = 0, previousSecondPackets = 0;
        std::uint64_t firstIngressAfterSwitch = 0, secondIngressAfterSwitch = 0;
        std::uint64_t firstRelayOutputAfterSwitch = 0, secondRelayOutputAfterSwitch = 0;
        std::uint64_t firstStartAfterSwitch = 0, secondStartAfterSwitch = 0;
        std::uint64_t firstEndAfterSwitch = 0, secondEndAfterSwitch = 0;
        const auto started = std::chrono::steady_clock::now();
        const auto startedTicks =
            std::chrono::duration_cast<std::chrono::nanoseconds>(started.time_since_epoch())
                .count();
        auto firstDue = 0.0;
        auto secondDue = 0.0;
        const auto duration =
            exercisesBackendSwitch ? std::chrono::seconds(4) : std::chrono::seconds(2);
        const auto deliver = [&](const std::vector<RelayDatagram>& datagrams) {
            for (const auto& datagram : datagrams) {
                if (backendSwitched) {
                    if (datagram.target.port == first.network().localPort())
                        ++firstRelayOutputAfterSwitch;
                    if (datagram.target.port == second.network().localPort())
                        ++secondRelayOutputAfterSwitch;
                }
                delivered =
                    downstream.sendTo(datagram.target.host, datagram.target.port, datagram.bytes) &&
                    delivered;
            }
        };
        while (std::chrono::steady_clock::now() - started < duration) {
            const auto fillTone = [](std::span<float> destination, double& phase, double frequency,
                                     std::uint32_t rate) {
                constexpr double twoPi = 6.28318530717958647692;
                for (auto& sample : destination) {
                    sample = 0.25F * static_cast<float>(std::sin(phase));
                    phase += twoPi * frequency / static_cast<double>(rate);
                    if (phase >= twoPi)
                        phase -= twoPi;
                }
            };
            const auto elapsed =
                std::chrono::duration<double>(std::chrono::steady_clock::now() - started).count();
            if (!startupDiagnosticsReset && elapsed >= 0.5) {
                first.network().resetDiagnosticLateAudioCutSeries();
                second.network().resetDiagnosticLateAudioCutSeries();
                startupDiagnosticsReset = true;
            }
            if (exercisesBackendSwitch && !backendSwitched && elapsed >= 2.0) {
                second.session().stop();
                previousSecondPackets += NetworkTestAccess::sentPackets(second.network());
                auto replacement =
                    std::make_unique<FakeAudioBackend>(settingsFor(exclusive48, test.secondDrift));
                secondDevice = replacement.get();
                second.session().replaceBackend(std::move(replacement));
                second.session().prepare({});
                second.session().start();
                secondRate = exclusive48.rate;
                secondPeriod = exclusive48.period;
                secondCapture.assign(secondPeriod, 0.0F);
                secondRender.assign(secondPeriod * 2U, 0.0F);
                secondDue = elapsed;
                backendSwitched = true;
            }
            while (elapsed >= firstDue) {
                fillTone(firstCapture, firstPhase, 523.25, test.first.rate);
                std::ranges::fill(firstRender, 0.0F);
                firstDevice->pump(
                    firstCapture, 1, firstRender, 2,
                    static_cast<std::int64_t>(std::llround(firstCapturePosition)),
                    static_cast<std::int64_t>(std::llround(firstRenderPosition)),
                    startedTicks + static_cast<MonotonicTicks>(std::llround(firstDue * 1e9)),
                    startedTicks +
                        static_cast<MonotonicTicks>(std::llround(
                            (firstDue - static_cast<double>(test.first.period) / test.first.rate) *
                            1e9)));
                firstCapturePosition += test.first.period * (1.0 + test.firstDrift / 1'000'000.0);
                firstRenderPosition += test.first.period * (1.0 - test.firstDrift / 1'000'000.0);
                for (const auto sample : firstRender)
                    firstPeak = std::max(firstPeak, static_cast<double>(std::abs(sample)));
                firstDue += static_cast<double>(test.first.period) / test.first.rate;
            }
            while (elapsed >= secondDue) {
                fillTone(secondCapture, secondPhase, 733.33, secondRate);
                std::ranges::fill(secondRender, 0.0F);
                secondDevice->pump(
                    secondCapture, 1, secondRender, 2,
                    static_cast<std::int64_t>(std::llround(secondCapturePosition)),
                    static_cast<std::int64_t>(std::llround(secondRenderPosition)),
                    startedTicks + static_cast<MonotonicTicks>(std::llround(secondDue * 1e9)),
                    startedTicks +
                        static_cast<MonotonicTicks>(std::llround(
                            (secondDue - static_cast<double>(secondPeriod) / secondRate) * 1e9)));
                secondCapturePosition += secondPeriod * (1.0 + test.secondDrift / 1'000'000.0);
                secondRenderPosition += secondPeriod * (1.0 - test.secondDrift / 1'000'000.0);
                for (const auto sample : secondRender)
                    secondPeak = std::max(secondPeak, static_cast<double>(std::abs(sample)));
                secondDue += static_cast<double>(secondPeriod) / secondRate;
            }

            // Shared voice sends two wire copies per completed logical packet. Bound the
            // drain by that upper limit: an empty timed receive must not pace both fake
            // devices and the relay. A failed copy still exits through the socket timeout.
            const auto sentDatagrams =
                2U * (NetworkTestAccess::sentPackets(first.network()) + previousSecondPackets +
                      NetworkTestAccess::sentPackets(second.network()));
            while (receivedDatagrams < sentDatagrams) {
                const auto receiveStarted = std::chrono::steady_clock::now();
                const auto bytes = upstream.receive(packetBytes);
                if (bytes == 0) {
                    maximumEmptyReadMilliseconds =
                        std::max(maximumEmptyReadMilliseconds,
                                 std::chrono::duration<double, std::milli>(
                                     std::chrono::steady_clock::now() - receiveStarted)
                                     .count());
                    ++emptyReads;
                    break;
                }
                ++receivedDatagrams;
                AudioPacketHeader header{};
                expect(decodeAudioPacketHeader(
                           std::span<const std::byte>{packetBytes.data(), bytes}, header),
                       "heterogeneous upstream keeps the room wire format");
                alignedPackets =
                    alignedPackets && header.frames == SharedRoomPacketFrames &&
                    (header.timestampFrame & MediaTimelineMask) % SharedRoomPacketFrames == 0;
                const auto firstPacket =
                    header.participantKey == NativeVoiceRelay::participantKey("first");
                if (backendSwitched) {
                    if (firstPacket)
                        ++firstIngressAfterSwitch;
                    else
                        ++secondIngressAfterSwitch;
                    auto& start = firstPacket ? firstStartAfterSwitch : secondStartAfterSwitch;
                    auto& end = firstPacket ? firstEndAfterSwitch : secondEndAfterSwitch;
                    const auto frame = header.timestampFrame & MediaTimelineMask;
                    if (start == 0)
                        start = frame;
                    end = frame;
                }
                const RelayEndpoint source{"127.0.0.1", firstPacket ? first.network().localPort()
                                                                    : second.network().localPort()};
                const auto nowTicks = monotonicTicksNow();
                const auto monotonic = static_cast<double>(nowTicks) / 1'000'000'000.0;
                const auto wall =
                    static_cast<double>(serverMicros + nowTicks / 1'000 - localMicros) /
                    1'000'000.0;
                deliver(relay.receive(std::span<const std::byte>{packetBytes.data(), bytes}, source,
                                      monotonic, wall));
            }
            const auto flushTicks = monotonicTicksNow();
            deliver(
                relay.flush(static_cast<double>(flushTicks) / 1'000'000'000.0,
                            static_cast<double>(serverMicros + flushTicks / 1'000 - localMicros) /
                                1'000'000.0));
            if (backendSwitched && elapsed >= 2.5) {
                for (const auto sample : firstRender)
                    firstPeakAfterSwitch =
                        std::max(firstPeakAfterSwitch, static_cast<double>(std::abs(sample)));
                for (const auto sample : secondRender)
                    secondPeakAfterSwitch =
                        std::max(secondPeakAfterSwitch, static_cast<double>(std::abs(sample)));
            }
            std::this_thread::sleep_for(std::chrono::milliseconds(1));
        }

        first.network().stop();
        second.network().stop();
        const auto firstDiagnostics = first.network().diagnostics();
        const auto secondDiagnostics = second.network().diagnostics();
        const auto firstRealtime = first.realtime().snapshot();
        const auto secondRealtime = second.realtime().snapshot();
        const auto firstBackendDiagnostics = first.session().backendSnapshot();
        const auto secondBackendDiagnostics = second.session().backendSnapshot();
        const auto participantValue = [](const NetworkDiagnostics& diagnostics, auto member) {
            return diagnostics.participants.empty()
                       ? std::uint64_t{0}
                       : static_cast<std::uint64_t>(diagnostics.participants.front().*member);
        };
        const auto firstRelay = relay.recipientMetrics(room, "first");
        const auto secondRelay = relay.recipientMetrics(room, "second");
        const auto detail =
            std::string{" sent/received="} + std::to_string(firstDiagnostics.packetsSent) + "/" +
            std::to_string(firstDiagnostics.packetsReceived) + "," +
            std::to_string(secondDiagnostics.packetsSent) + "/" +
            std::to_string(secondDiagnostics.packetsReceived) + " late=" +
            std::to_string(
                participantValue(firstDiagnostics, &RemoteParticipantDiagnostics::lateAudioCuts)) +
            "," +
            std::to_string(
                participantValue(secondDiagnostics, &RemoteParticipantDiagnostics::lateAudioCuts)) +
            " streak=" +
            std::to_string(participantValue(
                firstDiagnostics, &RemoteParticipantDiagnostics::maximumConsecutiveLateAudioCuts)) +
            "," +
            std::to_string(
                participantValue(secondDiagnostics,
                                 &RemoteParticipantDiagnostics::maximumConsecutiveLateAudioCuts)) +
            " alignment=" +
            std::to_string(participantValue(
                firstDiagnostics, &RemoteParticipantDiagnostics::interPeerAlignmentErrorFrames)) +
            "," +
            std::to_string(participantValue(
                secondDiagnostics, &RemoteParticipantDiagnostics::interPeerAlignmentErrorFrames)) +
            " excluded=" +
            std::to_string(participantValue(firstDiagnostics,
                                            &RemoteParticipantDiagnostics::timelineExcluded)) +
            "," +
            std::to_string(participantValue(secondDiagnostics,
                                            &RemoteParticipantDiagnostics::timelineExcluded)) +
            " peaks=" + std::to_string(firstPeak) + "," + std::to_string(secondPeak) +
            " relay-excluded=" + std::to_string(relay.excludedParticipants(room)) +
            " relay-missing=" + std::to_string(firstRelay.missingContributions) + "," +
            std::to_string(secondRelay.missingContributions) +
            " ingress-late=" + std::to_string(firstRelay.ingressSlack.negativePackets) + "," +
            std::to_string(secondRelay.ingressSlack.negativePackets) +
            " slack-min-ms=" + std::to_string(firstRelay.ingressSlack.minimumMs) + "," +
            std::to_string(secondRelay.ingressSlack.minimumMs) +
            " empty-recv-ms=" + std::to_string(maximumEmptyReadMilliseconds) +
            " empty-reads=" + std::to_string(emptyReads) +
            " relay-output=" + std::to_string(firstRelay.packets) + "," +
            std::to_string(secondRelay.packets);
        expect(delivered && alignedPackets && firstPeak > 0.01,
               std::string{"final master PCM for "} + test.first.name + " contains the " +
                   test.second.name + " remote pilot;" + detail);
        expect(delivered && alignedPackets && secondPeak > 0.01,
               std::string{"final master PCM for "} + test.second.name + " contains the " +
                   test.first.name + " remote pilot;" + detail);
        const auto tracedPcm = [](const NetworkDiagnostics& network,
                                  const RealtimeSnapshot& realtime,
                                  const BackendSnapshot& backend) {
            return network.normalizedSendNonzeroBlocks > 0 && network.normalizedSendPeak > 0.01F &&
                   !network.participants.empty() &&
                   network.participants.front().decodedNonzeroPackets > 0 &&
                   network.participants.front().decodedPeak > 0.01F &&
                   network.participants.front().queuedNonzeroPackets > 0 &&
                   network.participants.front().queuedPeak > 0.01F &&
                   network.participants.front().renderedNonzeroBlocks > 0 &&
                   realtime.remoteMixNonzeroBlocks > 0 && realtime.remoteMixPeak > 0.01F &&
                   realtime.masterOutputNonzeroBlocks > 0 && realtime.masterOutputPeak > 0.01F &&
                   backend.outputNonzeroBlocks > 0 && backend.outputPeak > 0.01F;
        };
        expect(tracedPcm(firstDiagnostics, firstRealtime, firstBackendDiagnostics) &&
                   tracedPcm(secondDiagnostics, secondRealtime, secondBackendDiagnostics),
               std::string{"bounded diagnostics retain every PCM stage needed to compare a real "
                           "backend before and after recreation;"} +
                   detail);
        if (exercisesBackendSwitch) {
            expect(backendSwitched && firstPeakAfterSwitch > 0.01 && secondPeakAfterSwitch > 0.01,
                   std::string{"reconnect and backend switching restore both final-master "
                               "directions; post-switch peaks="} +
                       std::to_string(firstPeakAfterSwitch) + "," +
                       std::to_string(secondPeakAfterSwitch) +
                       " ingress=" + std::to_string(firstIngressAfterSwitch) + "," +
                       std::to_string(secondIngressAfterSwitch) +
                       " relay-output=" + std::to_string(firstRelayOutputAfterSwitch) + "," +
                       std::to_string(secondRelayOutputAfterSwitch) +
                       " ranges=" + std::to_string(firstStartAfterSwitch) + ".." +
                       std::to_string(firstEndAfterSwitch) + "," +
                       std::to_string(secondStartAfterSwitch) + ".." +
                       std::to_string(secondEndAfterSwitch) + ";" + detail);
        }
        const auto noSystematicLateCuts = [](const NetworkDiagnostics& diagnostics) {
            return std::ranges::all_of(diagnostics.participants,
                                       [&](const auto& participant) {
                                           // A format starts with an empty remote queue. Permit the
                                           // bounded startup fill, but never an ongoing percentage
                                           // of cuts or a user-audible run.
                                           constexpr std::uint64_t allowance = 12;
                                           return participant.lateAudioCuts <= allowance &&
                                                  participant.maximumConsecutiveLateAudioCuts <= 3 &&
                                                  !participant.timelineExcluded &&
                                                  participant.interPeerAlignmentErrorFrames == 0;
                                       });
        };
        expect(firstDiagnostics.sharedTimeline && secondDiagnostics.sharedTimeline &&
                   noSystematicLateCuts(firstDiagnostics) &&
                   noSystematicLateCuts(secondDiagnostics),
               std::string{"heterogeneous room stays aligned without systematic late cuts for "} +
                   test.first.name + " <-> " + test.second.name + ";" + detail);
    }
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

void roomServerMixWaitDoesNotAdvertiseAsRouteLatency() {
    constexpr std::uint32_t Rate = 48'000, PacketFrames = 120;
    constexpr std::uint64_t Token = 77, Timeline = 10U * Rate;
    const auto requestedAfterWait = [](std::uint32_t collectionMilliseconds, bool muted = false) {
        NetworkAudioEngine network;
        network.prepare(Rate, 1, Rate / 2U, PacketFrames, GenerationId{1});
        network.setSharedTimeline(true);
        network.setRoomPlayoutDelay(80.0F);
        network.setSessionToken(Token);
        expect(network.addRemoteParticipant("__room_server_mix__"),
               "the diagnosed listener registers the server mix");
        expect(network.setRemoteMute("__room_server_mix__", muted), "select audible route");
        const auto collectionFrames = collectionMilliseconds * Rate / 1'000U;
        NetworkTestAccess::seedMeasuredServerMixRoute(network, collectionFrames);
        network.startReceive(0);
        std::vector<float> render(PacketFrames);
        (void)network.renderRemote(GenerationId{1}, render, PacketFrames, Timeline - PacketFrames);

        UdpSocket sender;
        sender.bind(0);
        const std::vector<float> tone(PacketFrames, 0.1F);
        const auto payload = PcmVoiceCodec::encode(tone);
        const auto stage = encodeServerMixStageReport(30U * Rate / 1'000U, collectionFrames);
        for (std::uint32_t sequence = 1; sequence <= 4; ++sequence) {
            AudioPacketHeader header{};
            header.sequence = sequence;
            header.participantKey = NetworkTestAccess::key("__room_server_mix__");
            header.sessionToken = Token;
            header.timestampFrame = (Timeline - (70U + collectionMilliseconds) * Rate / 1'000U +
                                     (sequence - 1U) * PacketFrames) |
                                    SharedAudioTimelineFlag;
            header.channels = 1;
            header.frames = PacketFrames;
            header.reportedParticipantKey = stage & ReportKeyMask;
            header.reportedLossPermille = static_cast<std::uint16_t>(stage >> 24U);
            header.streamEpoch = 7;
            header.codec = VoiceCodec::Pcm16;
            const auto encoded = encodeAudioPacketHeader(header);
            std::vector<std::byte> packet(encoded.begin(), encoded.end());
            packet.insert(packet.end(), payload.begin(), payload.end());
            expect(sender.sendTo("127.0.0.1", network.localPort(), packet),
                   "the test server sends its measured mix");
        }

        auto diagnostics = network.diagnostics();
        constexpr auto CalibratedSamples = room_audio_contract::ReturnCalibrationPackets + 4U;
        const auto deadline = std::chrono::steady_clock::now() + std::chrono::seconds(1);
        while ((diagnostics.packetsReceived < 4 ||
                diagnostics.participants.front().returnSamples < CalibratedSamples) &&
               std::chrono::steady_clock::now() < deadline) {
            std::this_thread::sleep_for(std::chrono::milliseconds(1));
            diagnostics = network.diagnostics();
        }
        network.stop();
        expect(diagnostics.packetsReceived >= 4 &&
                   diagnostics.participants.front().returnSamples >= CalibratedSamples,
               "server-mix packets update the calibrated route");
        return diagnostics.advertisedTargetDelayFrames;
    };

    const auto immediate = requestedAfterWait(0);
    const auto delayed = requestedAfterWait(70);
    expect(immediate <= 80U * Rate / 1'000U && delayed <= 80U * Rate / 1'000U &&
               delayed == immediate,
           "relay collection time must not make an otherwise eligible route exceed 80 ms");
    expect(requestedAfterWait(70, true) < immediate,
           "an inaudible backup route must not set the active direct route's deadline");
}

void roomReturnRouteUsesSocketArrivalInsteadOfFutureRenderCursor() {
    constexpr std::uint32_t rate = 48'000, frames = 120;
    constexpr std::uint64_t token = 77;
    NetworkAudioEngine network;
    network.prepare(rate, 1, rate / 2U, frames, GenerationId{1});
    const auto localMicros = monotonicTicksNow() / 1'000;
    network.setRoomClock(1'790'000'000'000'000LL, localMicros);
    network.setSharedTimeline(true);
    network.setRoomPlayoutDelay(80.0F);
    network.setSessionToken(token);
    expect(network.addRemoteParticipant("__room_server_mix__"), "server mix joins");
    network.startReceive(0);
    std::vector<float> output(frames);
    const auto future = network.roomTimelineFrame(monotonicTicksNow() + 20'000'000, 0);
    (void)network.renderRemote(GenerationId{1}, output, frames, future - frames);

    UdpSocket sender;
    sender.bind(0);
    const auto payload = PcmVoiceCodec::encode(std::vector<float>(frames, 0.1F));
    const auto stages = encodeServerMixStageReport(20U * rate / 1'000U, 0);
    for (std::uint32_t sequence = 0; sequence < 8; ++sequence) {
        AudioPacketHeader header{};
        header.sequence = sequence;
        header.participantKey = NetworkTestAccess::key("__room_server_mix__");
        header.sessionToken = token;
        header.timestampFrame =
            (network.roomTimelineFrame(monotonicTicksNow(), 0) - 30U * rate / 1'000U) |
            SharedAudioTimelineFlag;
        header.channels = 1;
        header.frames = frames;
        header.reportedParticipantKey = stages & ReportKeyMask;
        header.reportedLossPermille = static_cast<std::uint16_t>(stages >> 24U);
        header.streamEpoch = 7;
        header.codec = VoiceCodec::Pcm16;
        const auto encoded = encodeAudioPacketHeader(header);
        std::vector<std::byte> datagram(encoded.begin(), encoded.end());
        datagram.insert(datagram.end(), payload.begin(), payload.end());
        expect(sender.sendTo("127.0.0.1", network.localPort(), datagram),
               "a staged server mix reaches the receiver");
    }
    auto diagnostics = network.diagnostics();
    const auto deadline = std::chrono::steady_clock::now() + std::chrono::seconds(1);
    while (diagnostics.participants.front().returnSamples < 8 &&
           std::chrono::steady_clock::now() < deadline) {
        std::this_thread::sleep_for(std::chrono::milliseconds(1));
        diagnostics = network.diagnostics();
    }
    network.stop();
    expect(diagnostics.participants.front().returnSamples == 8,
           "all staged packets contributed to the return-route measurement");
    expect(diagnostics.participants.front().returnP50Frames <= 20U * rate / 1'000U,
           "a future output-buffer cursor must not add its lead to the measured network return");
}

void roomLateCutDiagnosticsSeparateVoiceFromEmptyMix() {
    constexpr std::uint32_t rate = 48'000, block = 120;
    constexpr std::uint64_t token = 77, renderFrame = 10U * rate;
    for (const bool nonzero : {true, false}) {
        NetworkAudioEngine network;
        network.prepare(rate, 1, rate / 2U, block, GenerationId{1});
        network.setSharedTimeline(true);
        network.setRoomPlayoutDelay(60.0F);
        network.setSessionToken(token);
        expect(network.addRemoteParticipant("__room_server_mix__"), "server mix joins");
        NetworkTestAccess::primeSharedTimeline(network, "__room_server_mix__", block);
        NetworkTestAccess::setRemoteStreamEpoch(network, "__room_server_mix__", 1);
        network.startReceive(0);
        std::vector<float> output(block);
        (void)network.renderRemote(GenerationId{1}, output, block, renderFrame);

        UdpSocket sender;
        sender.bind(0);
        const auto payload = PcmVoiceCodec::encode(std::vector<float>(block, nonzero ? 0.1F : 0.0F));
        for (std::uint32_t sequence = 0; sequence < 8; ++sequence) {
            AudioPacketHeader header{};
            header.sequence = sequence;
            header.participantKey = NetworkTestAccess::key("__room_server_mix__");
            header.sessionToken = token;
            header.timestampFrame = (renderFrame - rate / 10U + sequence * block) |
                                    SharedAudioTimelineFlag;
            header.channels = 1;
            header.frames = block;
            header.streamEpoch = 1;
            header.codec = VoiceCodec::Pcm16;
            const auto encoded = encodeAudioPacketHeader(header);
            std::vector<std::byte> datagram(encoded.begin(), encoded.end());
            datagram.insert(datagram.end(), payload.begin(), payload.end());
            expect(sender.sendTo("127.0.0.1", network.localPort(), datagram),
                   "late mix reaches receiver");
        }

        auto diagnostics = network.diagnostics();
        const auto deadline = std::chrono::steady_clock::now() + std::chrono::seconds(1);
        while (diagnostics.participants.front().lateAudioCuts == 0 &&
               std::chrono::steady_clock::now() < deadline) {
            std::this_thread::sleep_for(std::chrono::milliseconds(1));
            diagnostics = network.diagnostics();
        }
        network.stop();
        const auto& mix = diagnostics.participants.front();
        expect(mix.lateAudioCuts > 0, "the packet is rejected at the fixed room deadline");
        expect(mix.lateNonzeroVoiceCuts == (nonzero ? mix.lateAudioCuts : 0U) &&
                   mix.lateEmptyMixPackets == (nonzero ? 0U : mix.lateAudioCuts) &&
                   mix.lateOtherAudioCuts == 0,
               "late diagnostics distinguish audible voice from an empty server mix");
    }
}

void roomVoiceResumesTimelyPacketsWithoutHalfSecondSilence() {
    constexpr std::uint32_t rate = 48'000, block = 120, token = 77;
    NetworkAudioEngine network;
    network.prepare(rate, 1, rate / 2U, block, GenerationId{1});
    network.setSharedTimeline(true);
    network.setRoomPlayoutDelay(60.0F);
    network.setSessionToken(token);
    expect(network.addRemoteParticipant("singer"), "the singer joins");
    NetworkTestAccess::excludeVoice(network, "singer");
    network.startReceive(0);
    UdpSocket sender;
    sender.bind(0);
    std::vector<float> tone(block), output(block);
    for (std::uint32_t frame = 0; frame < block; ++frame)
        tone[frame] = 0.5F * static_cast<float>(std::sin(2.0 * 3.14159265358979 * frame / block));
    const auto payload = PcmVoiceCodec::encode(tone);
    auto timeline = std::uint64_t{10U * rate};
    float peak = 0;
    for (std::uint32_t sequence = 0; sequence < 80; ++sequence, timeline += block) {
        const AudioPacketHeader header{sequence, NetworkTestAccess::key("singer"), token,
                                       (timeline - 480U) | SharedAudioTimelineFlag,
                                       1, block, 0, 1, VoiceCodec::Pcm16, 0};
        const auto encoded = encodeAudioPacketHeader(header);
        std::vector<std::byte> packet(encoded.begin(), encoded.end());
        packet.insert(packet.end(), payload.begin(), payload.end());
        expect(sender.sendTo("127.0.0.1", network.localPort(), packet), "timely packet sent");
        std::this_thread::sleep_for(std::chrono::microseconds(2'500));
        (void)network.renderRemote(GenerationId{1}, output, block, timeline);
        peak = std::max(peak, *std::ranges::max_element(output));
    }
    network.stop();
    expect(peak > 0.3F, "current timely voice is audible within 200 ms, without a 500 ms penalty");
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

void changingTheNegotiatedRoomDeadlineRealignsRemoteVoiceAtTheCurrentPosition() {
    NetworkAudioEngine network;
    constexpr std::uint32_t rate = 48'000, packet = 120;
    network.prepare(rate, 1, rate / 2U, packet, GenerationId{1});
    network.setSharedTimeline(true);
    network.setRoomPlayoutDelay(80.0F);
    expect(network.addRemoteParticipant("room-mix"), "the server mix joins");
    NetworkTestAccess::primeSharedTimeline(network, "room-mix", rate * 80U / 1'000U);

    network.setRoomPlayoutDelay(60.0F);

    expect(!NetworkTestAccess::timelineInitialized(network, "room-mix") &&
               NetworkTestAccess::queuedFrames(network, "room-mix") == 0,
           "a negotiated deadline change discards the old alignment instead of cutting it late");
}

void roomDeadlineRequestedDuringSongAppliesAfterStop() {
    NetworkAudioEngine network;
    constexpr std::uint32_t rate = 48'000, packet = 120;
    network.prepare(rate, 1, rate / 2U, packet, GenerationId{1});
    network.setSharedTimeline(true);
    network.setRoomPlayoutDelay(60.0F);
    expect(network.addRemoteParticipant("room-mix"), "the server mix joins");
    NetworkTestAccess::primeSharedTimeline(network, "room-mix", rate * 60U / 1'000U);
    network.startReceive(0);

    network.setFollowLocked(true);
    network.setRoomPlayoutDelay(120.0F);
    expect(network.roomPlayoutDelayFrames() == rate * 60U / 1'000U &&
               NetworkTestAccess::timelineInitialized(network, "room-mix"),
           "the active song keeps its original room deadline and queued alignment");

    network.setFollowLocked(false);
    const auto timeout = std::chrono::steady_clock::now() + std::chrono::milliseconds(500);
    while ((network.roomPlayoutDelayFrames() != rate * 120U / 1'000U ||
            NetworkTestAccess::timelineInitialized(network, "room-mix") ||
            NetworkTestAccess::queuedFrames(network, "room-mix") != 0) &&
           std::chrono::steady_clock::now() < timeout)
        std::this_thread::sleep_for(std::chrono::milliseconds(1));
    expect(network.roomPlayoutDelayFrames() == rate * 120U / 1'000U &&
               !NetworkTestAccess::timelineInitialized(network, "room-mix") &&
               NetworkTestAccess::queuedFrames(network, "room-mix") == 0,
           "the pending room deadline applies and realigns voice after the song stops");
    network.stop();
}

void diagnosticLateCutSeriesCanStartASeparatePostReconnectWindow() {
    NetworkAudioEngine network;
    network.prepare(48'000, 1, 24'000, 120, GenerationId{1});
    expect(network.addRemoteParticipant("room-mix"), "the diagnosed server mix joins");
    NetworkTestAccess::seedLateCutSeries(network, "room-mix", 7, 43);

    network.resetDiagnosticLateAudioCutSeries();

    expect(NetworkTestAccess::lateCutSeries(network, "room-mix") == std::pair{0U, 0U},
           "post-reconnect diagnostics start a fresh consecutive-cut window");
}

void diagnosticLateCutSeriesRearmsFrozenPacketTraceWithoutResettingTotals() {
    NetworkAudioEngine network;
    network.prepare(48'000, 1, 24'000, 120, GenerationId{1});
    expect(network.addRemoteParticipant("trace-singer"), "the traced direct singer joins");
    for (std::uint32_t sequence = 0; sequence < 140; ++sequence)
        NetworkTestAccess::noteVoiceDecision(network, "trace-singer", sequence, true);
    NetworkTestAccess::noteVoiceDecision(network, "trace-singer", 900, false);
    const auto before = network.diagnostics().participants.front();
    expect(!before.packetTrace.empty() && before.packetTrace.back().sequence != 900 &&
               before.lateAudioCuts == 140,
           "the first sustained cut series freezes a trace while lifetime counters continue");

    network.resetDiagnosticLateAudioCutSeries();
    NetworkTestAccess::noteVoiceDecision(network, "trace-singer", 1'000, false);
    const auto after = network.diagnostics().participants.front();
    expect(after.packetTrace.size() == 1 && after.packetTrace.front().sequence == 1'000,
           "an explicit diagnostic series reset rearms the trace for the current microphone capture");
    expect(after.lateAudioCuts == before.lateAudioCuts &&
               after.lateNonzeroVoiceCuts == before.lateNonzeroVoiceCuts &&
               after.firstLateAudioCutFrame == before.firstLateAudioCutFrame &&
               after.lastLateAudioCutFrame == before.lastLateAudioCutFrame,
           "rearming packet evidence never resets lifetime cut counters or their positions");
}

void returnPathTraceSeparatesReceiveProcessingAndQueueAdmission() {
    ReturnPathStageTrace trace;
    trace.note({1'000, 1'300, 1'700, 1'900});
    trace.note({3'500, 3'600, 3'900, 0});

    const auto snapshot = trace.snapshot();
    expect(snapshot.packets == 2 && snapshot.queueAdmissions == 1 &&
               snapshot.latestReceiveGapMicros == 2'500 &&
               snapshot.maximumReceiveGapMicros == 2'500 &&
               snapshot.latestSocketToProcessMicros == 100 &&
               snapshot.maximumSocketToProcessMicros == 300 &&
               snapshot.latestProcessToDecisionMicros == 300 &&
               snapshot.maximumProcessToDecisionMicros == 400 &&
               snapshot.latestProcessToQueueMicros == 600 &&
               snapshot.maximumProcessToQueueMicros == 600,
           "return diagnostics separate socket cadence, client scheduling, decision and queue "
           "admission instead of reporting one opaque return delay");
}

void roomPacketTraceExplainsFirstLateCut() {
    constexpr std::uint32_t rate = 48'000, block = 120, token = 77;
    _putenv_s("AD_VOICE_ROOM_PACKET_TRACE", "1");
    AudioService service{std::make_unique<FakeAudioBackend>()};
    service.start();
    (void)service.session().prepare({});
    auto& network = service.network();
    network.setSharedTimeline(true);
    network.setRoomPlayoutDelay(60.0F);
    network.setSessionToken(token);
    expect(network.addRemoteParticipant("__room_server_mix__"), "trace participant joins");
    network.startReceive(0);
    UdpSocket sender;
    sender.bind(0);
    const auto payload = PcmVoiceCodec::encode(std::vector<float>(block, 0.1F));
    std::vector<float> output(block);
    std::uint64_t timeline = 10U * rate;
    const auto stages = encodeServerMixStageReport(10U * rate / 1'000U,
                                                    5U * rate / 1'000U);
    const auto waitForProcessed = [&](std::uint64_t packets) {
        auto state = network.diagnostics();
        const auto deadline = std::chrono::steady_clock::now() + std::chrono::seconds(1);
        while (state.packetsReceived < packets && std::chrono::steady_clock::now() < deadline) {
            std::this_thread::yield();
            state = network.diagnostics();
        }
        if (state.packetsReceived != packets)
            std::printf("TRACE_PHASE expected=%llu received=%llu decoded=%llu lastSequence=%u lost=%llu late=%llu\n",
                        static_cast<unsigned long long>(packets),
                        static_cast<unsigned long long>(state.packetsReceived),
                        static_cast<unsigned long long>(state.participants.front().decodedNonzeroPackets),
                        state.participants.front().packetTrace.empty() ? UINT32_MAX :
                            state.participants.front().packetTrace.back().sequence,
                        static_cast<unsigned long long>(state.participants.front().jitter.lostPackets),
                        static_cast<unsigned long long>(state.participants.front().jitter.latePackets));
        expect(state.packetsReceived == packets,
               "all packets from this trace phase finish before its boundary");
    };
    for (std::uint32_t sequence = 0; sequence < 135; ++sequence, timeline += block) {
        if (sequence == 80) {
            waitForProcessed(80);
            network.setFollowLocked(true); // song start: trace must begin with this generation
        }
        const auto lateness = (sequence < 80 ? 30U : 100U) * rate / 1'000U;
        const AudioPacketHeader header{sequence,
                                       NetworkTestAccess::key("__room_server_mix__"),
                                       token,
                                       (timeline - lateness) | SharedAudioTimelineFlag,
                                       1,
                                       block,
                                       stages & ReportKeyMask,
                                       7,
                                       VoiceCodec::Pcm16,
                                       static_cast<std::uint16_t>(stages >> 24U)};
        const auto encoded = encodeAudioPacketHeader(header);
        std::vector<std::byte> packet(encoded.begin(), encoded.end());
        packet.insert(packet.end(), payload.begin(), payload.end());
        expect(sender.sendTo("127.0.0.1", network.localPort(), packet),
               "packet reaches the traced receiver");
        std::this_thread::sleep_for(std::chrono::microseconds(2'500));
        (void)network.renderRemote(GenerationId{1}, output, block, timeline);
    }
    waitForProcessed(135);
    const auto diagnostics = service.diagnostics();
    const auto retainedVoiceAfterEmpty =
        NetworkTestAccess::traceRetainsVoiceAfterEmptyLateCuts(network);
    network.stop();
    _putenv_s("AD_VOICE_ROOM_PACKET_TRACE", "");
    expect(diagnostics.find("RemotePacketTrace.__room_server_mix__:") != std::string::npos &&
               diagnostics.find("QUEUE_LATE") != std::string::npos &&
               diagnostics.find("serverIngressFrames=480") != std::string::npos &&
               diagnostics.find("socketTimelineFrame=") != std::string::npos &&
               diagnostics.find("receiveTimelineFrame=") != std::string::npos &&
               diagnostics.find("sequence=79;") == std::string::npos &&
               diagnostics.size() < 65'536,
           "bounded packet trace records stage timing, receiver timeline and exact late decision");
    expect(retainedVoiceAfterEmpty,
           "empty late mix packets cannot freeze the diagnostic trace before lost voice");
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

void pcmConsecutiveLossHasAFiniteEnvelopeForEveryChannel() {
    constexpr std::uint32_t Packet = 120;
    for (const auto channels : {1U, 2U, 6U}) {
        PcmLossConcealer concealment;
        std::vector<float> voice(960U * channels);
        for (std::uint32_t frame = 0; frame < 960; ++frame)
            for (std::uint32_t channel = 0; channel < channels; ++channel)
                voice[frame * channels + channel] =
                    (channel % 2U == 0 ? 0.25F : -0.1F) *
                    static_cast<float>(std::sin(frame * 2.0 * 3.14159265358979 / Packet));
        concealment.remember(voice, channels);
        float earlyPower = 0.0F, latePower = 0.0F;
        for (std::uint32_t packet = 0; packet < 64; ++packet) {
            const auto missing = concealment.conceal(Packet, channels);
            expect(missing.size() == Packet * channels, "every concealed packet retains its channel layout");
            for (const auto sample : missing) {
                if (packet < 8)
                    earlyPower += sample * sample;
                if (packet >= 40)
                    latePower += sample * sample;
            }
        }
        expect(earlyPower > 0.1F && latePower == 0.0F,
               "consecutive loss continues briefly, attenuates, and is exactly silent after 100 ms on all channels");
    }
}

void pcmRecoveryPreviewDoesNotCommitAnUnqueuedPacket() {
    PcmLossConcealer concealment;
    const std::vector<float> history(120, 0.2F);
    concealment.remember(history, 1);
    (void)concealment.conceal(120, 1);
    std::vector<float> rejected(120, -0.2F), admitted = rejected;
    concealment.smoothRecovery(rejected, 1);
    concealment.smoothRecovery(admitted, 1);
    expect(rejected == admitted && admitted.front() > -0.19F,
           "previewing a packet later rejected by the deadline cannot consume the recovery crossfade");
    concealment.remember(admitted, 1);
    std::vector<float> next(120, -0.2F);
    concealment.smoothRecovery(next, 1);
    expect(next.front() == -0.2F, "only admission of real PCM commits recovery");
}

void directRenderContinuityBoundsSavedGapDurations() {
    // These are the saved PCM gap durations, not a replay of unavailable packet arrival times.
    // No receive-side Lost event occurs: the realtime reader alone must cover the absent audio.
    constexpr std::uint32_t Rate = 48'000, Block = 64, SeedFrames = 4'800;
    constexpr std::uint32_t gaps[]{144, 4'448, 7'518}; // 3 / 92.667 / 156.625 ms
    const auto voice = [](std::uint64_t frame) {
        return 0.25F * static_cast<float>(std::sin(frame * 2.0 * 3.14159265358979 * 220.0 / Rate));
    };
    for (const auto gapFrames : gaps) {
        NetworkAudioEngine network;
        network.prepare(Rate, 1, Rate / 2U, 120, GenerationId{1});
        expect(network.addRemoteParticipant("singer"), "duration replay singer joins");
        NetworkTestAccess::bypassRemoteEffects(network, "singer");
        std::vector<float> seed(SeedFrames), output(Block), missing;
        for (std::uint32_t frame = 0; frame < SeedFrames; ++frame)
            seed[frame] = voice(frame);
        expect(NetworkTestAccess::queueVoice(network, "singer", seed), "rendered history is ready");
        std::uint64_t position = 0;
        RealtimeInstrumentation::reset();
        const auto render = [&](std::uint32_t frames) {
            RealtimeScope scope;
            (void)network.renderRemote(GenerationId{1}, output, frames, position);
            position += frames;
        };
        while (position < SeedFrames)
            render(static_cast<std::uint32_t>(std::min<std::uint64_t>(Block, SeedFrames - position)));
        for (std::uint32_t absent = 0; absent < gapFrames;) {
            const auto count = std::min(Block, gapFrames - absent);
            render(count);
            missing.insert(missing.end(), output.begin(), output.begin() + count);
            absent += count;
        }
        std::uint32_t zeroRun = 0, longestZero = 0, missingFrames = 0;
        for (std::size_t frame = 0; frame <= missing.size(); ++frame) {
            if (frame < missing.size() && std::abs(missing[frame]) <= 2.0F / 32767.0F) {
                ++zeroRun;
                continue;
            }
            if (zeroRun >= Rate / 1'000U) {
                longestZero = std::max(longestZero, zeroRun);
                missingFrames += zeroRun;
            }
            zeroRun = 0;
        }
        std::array<float, 256> current{};
        for (std::size_t frame = 0; frame < current.size(); ++frame)
            current[frame] = voice(position + frame);
        expect(NetworkTestAccess::queueVoice(network, "singer", current), "current voice resumes");
        float recoveredError = 0.0F;
        std::uint32_t recoveryFrames = 0;
        for (std::uint32_t offset = 0; offset < current.size(); offset += Block) {
            render(Block);
            for (std::uint32_t frame = 0; frame < Block; ++frame) {
                if (std::abs(output[frame] - current[offset + frame]) > 0.000001F)
                    recoveryFrames = offset + frame + 1U;
                if (offset >= 128)
                    recoveredError = std::max(recoveredError, std::abs(output[frame] - current[offset + frame]));
            }
        }
        const auto violations = RealtimeInstrumentation::snapshot();
        const auto diagnostics = network.diagnostics();
        std::printf("DURATION_REPLAY gapMs=%.6f missingPcmMs=%.6f longestZeroMs=%.6f "
                    "lateCuts=%llu recoveryMs=%.6f addedLatencyMs=0 driftFrames=0 queueFrames=%u\n",
                    gapFrames * 1'000.0 / Rate, missingFrames * 1'000.0 / Rate,
                    longestZero * 1'000.0 / Rate,
                    static_cast<unsigned long long>(diagnostics.participants.front().lateAudioCuts),
                    recoveryFrames * 1'000.0 / Rate,
                    diagnostics.participants.front().queueFillFrames);
        expect(gapFrames > Rate / 100U ? longestZero < Rate * 60U / 1'000U : longestZero == 0,
               "render starvation is concealed with a bounded tail instead of the entire PCM gap");
        expect(missingFrames < gapFrames / 2U,
               "bounded continuation substantially reduces absolute silence without claiming recovered phonemes");
        expect(recoveryFrames <= 120 && recoveredError < 0.000001F &&
                   diagnostics.participants.front().queueFillFrames == 0,
               "current audio resumes within one packet at its original sample position with no new queue");
        if (gapFrames > Rate / 10U) {
            const auto power = [&](std::uint32_t begin, std::uint32_t end) {
                float total = 0;
                for (auto frame = begin; frame < end; ++frame)
                    total += missing[frame] * missing[frame];
                return total / (end - begin);
            };
            expect(power(0, 960) > 0.005F && power(3'840, 4'800) < power(0, 960) / 8U &&
                       std::all_of(missing.begin() + 4'800, missing.end(),
                                   [](float sample) { return sample == 0.0F; }),
                   "short continuation becomes controlled attenuation and ends by 100 ms, never an endless pitch loop");
        }
        expect(violations.allocations == 0 && violations.deallocations == 0 &&
                   violations.blockingCalls == 0 && violations.diskIoCalls == 0,
               "starvation and recovery remain allocation-free and nonblocking in render");
    }
}

void directRenderContinuityCannotLeakAcrossMuteOrQueueReset() {
    constexpr std::uint32_t Rate = 48'000, Block = 120;
    NetworkAudioEngine network;
    network.prepare(Rate, 1, Rate / 2U, Block, GenerationId{1});
    expect(network.addRemoteParticipant("singer"), "reset regression singer joins");
    NetworkTestAccess::bypassRemoteEffects(network, "singer");
    std::vector<float> tone(960), output(Block);
    for (std::size_t frame = 0; frame < tone.size(); ++frame)
        tone[frame] = 0.25F * static_cast<float>(std::sin(frame * 0.03));
    std::uint64_t position = 0;
    const auto seed = [&] {
        expect(NetworkTestAccess::queueVoice(network, "singer", tone), "seed the previous voice");
        for (std::size_t offset = 0; offset < tone.size(); offset += Block, position += Block)
            (void)network.renderRemote(GenerationId{1}, output, Block, position);
    };
    seed();
    (void)network.renderRemote(GenerationId{1}, output, Block, position);
    expect(std::any_of(output.begin(), output.end(), [](float sample) { return std::abs(sample) > 0.001F; }),
           "the regression exercises an actual concealed tail before reset");
    expect(network.setRemoteMute("singer", true) && network.setRemoteMute("singer", false),
           "mute and unmute may happen between render callbacks");
    (void)network.renderRemote(GenerationId{1}, output, Block, position);
    expect(std::all_of(output.begin(), output.end(), [](float sample) { return sample == 0.0F; }),
           "mute clears old continuity even when no callback observed the muted state");
    seed();
    NetworkTestAccess::clearRemoteQueue(network, "singer");
    (void)network.renderRemote(GenerationId{1}, output, Block, position);
    expect(std::all_of(output.begin(), output.end(), [](float sample) { return sample == 0.0F; }),
           "stream epoch, generation and queue lifecycle resets cannot replay the old voice tail");
}

void directRenderContinuitySurvivesSocketSilenceAndRejectsStaleBacklog() {
    // Duration-constrained replay: the old captures did not record every UDP arrival.
    // Isolate playout continuity from reorder policy, which has separate regression coverage.
    constexpr std::uint32_t Rate = 48'000, Packet = 120, Token = 77;
    for (const auto [gapFrames, deadlineFrames] :
         {std::pair{4'448U, 2'640U}, std::pair{7'518U, 3'480U}}) {
        NetworkAudioEngine network;
        network.prepare(Rate, 1, Rate / 2U, Packet, GenerationId{1});
        network.setSharedTimeline(true);
        network.setRoomPlayoutDelay(deadlineFrames * 1'000.0F / Rate);
        network.setSessionToken(Token);
        expect(network.addRemoteParticipant("singer"), "socket-stall singer joins");
        NetworkTestAccess::bypassRemoteEffects(network, "singer");
        NetworkTestAccess::useSinglePacketReorder(network, "singer");
        network.startReceive(0);
        UdpSocket sender;
        sender.bind(0);
        std::vector<float> tone(Packet), output(Packet);
        for (std::uint32_t frame = 0; frame < Packet; ++frame)
            tone[frame] = 0.25F * static_cast<float>(std::sin(frame * 2.0 * 3.14159265358979 / Packet));
        const auto payload = PcmVoiceCodec::encode(tone);
        std::uint64_t timeline = 10U * Rate;
        std::uint32_t sequence = 0;
        (void)network.renderRemote(GenerationId{1}, output, Packet, timeline);
        timeline += Packet;
        const auto send = [&](std::uint64_t presentationFrame) {
            const AudioPacketHeader header{sequence++, NetworkTestAccess::key("singer"), Token,
                                           (presentationFrame - deadlineFrames) | SharedAudioTimelineFlag,
                                           1, Packet, 0, 1, VoiceCodec::Pcm16, 0};
            const auto encoded = encodeAudioPacketHeader(header);
            std::vector<std::byte> datagram(encoded.begin(), encoded.end());
            datagram.insert(datagram.end(), payload.begin(), payload.end());
            expect(sender.sendTo("127.0.0.1", network.localPort(), datagram), "real UDP packet arrives");
            const auto timeout = std::chrono::steady_clock::now() + std::chrono::seconds(1);
            while (network.diagnostics().packetsReceived < sequence &&
                   std::chrono::steady_clock::now() < timeout)
                std::this_thread::yield();
            expect(network.diagnostics().packetsReceived == sequence, "UDP receive and decision finish");
        };
        const auto render = [&](std::uint32_t frames) {
            RealtimeScope scope;
            (void)network.renderRemote(GenerationId{1}, output, frames, timeline);
            timeline += frames;
        };
        for (std::uint32_t packet = 0; packet < 40; ++packet) {
            send(timeline);
            render(Packet);
        }
        const auto gapStart = timeline;
        float earlyPower = 0.0F;
        RealtimeInstrumentation::reset();
        for (std::uint32_t absent = 0; absent < gapFrames;) {
            const auto count = std::min(Packet, gapFrames - absent);
            render(count);
            if (absent < Rate / 50U)
                for (std::uint32_t frame = 0; frame < count; ++frame)
                    earlyPower += output[frame] * output[frame];
            absent += count;
        }
        const auto violations = RealtimeInstrumentation::snapshot();
        // All three stale positions physically passed; they may update decoder state but must
        // never displace either continuity output or the first current packet in the FIFO.
        for (std::uint32_t packet = 0; packet < 3; ++packet)
            send(gapStart + packet * Packet);
        const auto afterBacklog = network.diagnostics();
        for (std::uint32_t packet = 0; packet < 3; ++packet)
            send(timeline + packet * Packet);
        render(Packet); // bounded recovery crossfade
        render(Packet);
        const auto decoded = PcmVoiceCodec::decode(payload, Packet);
        float currentError = 0.0F;
        for (std::uint32_t frame = 0; frame < Packet; ++frame)
            currentError = std::max(currentError, std::abs(output[frame] - decoded[frame]));
        render(Packet);
        const auto recovered = network.diagnostics();
        network.stop();
        expect(earlyPower > 1.0F, "no arriving packet is needed to conceal the beginning of a render gap");
        expect(afterBacklog.participants.front().lateAudioCuts == 3 &&
                   afterBacklog.participants.front().queueFillFrames == 0,
               "expired backlog is decoded and cut without being replayed later");
        expect(currentError < 0.000001F && recovered.participants.front().queueFillFrames == 0 &&
                   recovered.participants.front().queueAlignmentErrorFrames == 0 &&
                   recovered.roomPlayoutDelayFrames == deadlineFrames,
               "first current packet restores original alignment within one packet and no deadline or queue growth");
        expect(violations.allocations == 0 && violations.blockingCalls == 0,
               "socket silence does not add realtime allocation or waiting");
    }
}

void directConsecutiveSequenceLossUsesBoundedContinuity() {
    constexpr std::uint32_t Rate = 48'000, Packet = 120, Target = 2'640;
    constexpr std::array missingCounts{1U, 37U, 64U};
    for (const auto missingPackets : missingCounts) {
        NetworkAudioEngine network;
        network.prepare(Rate, 1, Rate / 2U, Packet, GenerationId{1});
        network.setSharedTimeline(true);
        network.setRoomPlayoutDelay(55.0F);
        expect(network.addRemoteParticipant("singer"), "consecutive-loss singer joins");
        NetworkTestAccess::bypassRemoteEffects(network, "singer");
        NetworkTestAccess::useSinglePacketReorder(network, "singer", 24);
        std::vector<float> tone(Packet), output(Packet), missing;
        for (std::uint32_t frame = 0; frame < Packet; ++frame)
            tone[frame] = 0.25F * static_cast<float>(std::sin(frame * 2.0 * 3.14159265358979 / Packet));
        const auto payload = PcmVoiceCodec::encode(tone);
        constexpr std::uint64_t Origin = 10U * Rate;
        auto cursor = Origin + Target;
        (void)network.renderRemote(GenerationId{1}, output, Packet, cursor - Packet);
        const auto receive = [&](std::uint32_t sequence) {
            NetworkTestAccess::pumpRemotePackets(
                network, "singer", NetworkAudioPacket{sequence,
                    (Origin + sequence * Packet) | SharedAudioTimelineFlag,
                    1, Packet, payload, VoiceCodec::Pcm16});
        };
        for (std::uint32_t sequence = 0; sequence < 40; ++sequence) {
            receive(sequence);
            expect(network.diagnostics().participants.front().queuedNonzeroPackets == sequence + 1U,
                   "real admitted PCM seeds consecutive-loss history before missing sequences");
            (void)network.renderRemote(GenerationId{1}, output, Packet, cursor);
            cursor += Packet;
        }
        receive(40U + missingPackets); // A future packet exposes the entire missing sequence span.
        for (std::uint32_t lost = 1; lost <= missingPackets; ++lost) {
            NetworkTestAccess::pumpRemotePackets(network, "singer");
            const auto queued = network.diagnostics().participants.front();
            expect(queued.jitter.lostPackets == lost && queued.queueFillFrames >= Packet,
                   "receive-side PLC occupies each missing position without render starvation");
            (void)network.renderRemote(GenerationId{1}, output, Packet, cursor);
            cursor += Packet;
            missing.insert(missing.end(), output.begin(), output.end());
        }
        std::uint32_t run = 0, longest = 0, missingFrames = 0;
        for (std::size_t frame = 0; frame <= missing.size(); ++frame) {
            if (frame < missing.size() && std::abs(missing[frame]) <= 2.0F / 32767.0F) {
                ++run;
                continue;
            }
            if (run >= Rate / 1'000U) {
                longest = std::max(longest, run);
                missingFrames += run;
            }
            run = 0;
        }
        const auto recovered = network.diagnostics().participants.front();
        (void)network.renderRemote(GenerationId{1}, output, Packet, cursor);
        expect(recovered.jitter.lostPackets == missingPackets &&
                   recovered.queueFillFrames == Packet &&
                   network.diagnostics().participants.front().queueFillFrames == 0,
               "the valid future packet resumes at its own position with no accumulated queue");
        expect(std::abs(output.back() - tone.back()) < 0.00004F,
               "the bounded one-packet recovery ends at the real PCM's original sample position");
        receive(41U + missingPackets);
        (void)network.renderRemote(GenerationId{1}, output, Packet, cursor + Packet);
        float recoveredError = 0.0F;
        for (std::uint32_t frame = 0; frame < Packet; ++frame)
            recoveredError = std::max(recoveredError, std::abs(output[frame] - tone[frame]));
        expect(recoveredError < 0.00004F,
               "after one recovery packet the following real PCM is unchanged and has no accumulated phase error");
        std::printf("CONSECUTIVE_LOSS packets=%u durationMs=%.3f missingPcmMs=%.3f longestZeroMs=%.3f\n",
                    missingPackets, missing.size() / 48.0, missingFrames / 48.0, longest / 48.0);
        expect(missingFrames < missing.size() / 2U && longest < Rate * 65U / 1'000U,
               "queued consecutive-loss PLC shares bounded continuity instead of early silence");
        if (missing.size() > Rate / 10U)
            expect(std::all_of(missing.begin() + Rate / 10U, missing.end(),
                               [](float sample) { return sample == 0.0F; }),
                   "consecutive queued loss also ends by 100 ms instead of repeating indefinitely");
    }
}

void directMixedLossCannotRestartTheContinuationBudget() {
    constexpr std::uint32_t Rate = 48'000, Packet = 120, Target = 2'640;
    NetworkAudioEngine network;
    network.prepare(Rate, 1, Rate / 2U, Packet, GenerationId{1});
    network.setSharedTimeline(true);
    network.setRoomPlayoutDelay(55.0F);
    expect(network.addRemoteParticipant("singer"), "mixed-loss singer joins");
    NetworkTestAccess::bypassRemoteEffects(network, "singer");
    NetworkTestAccess::useSinglePacketReorder(network, "singer", 24);
    std::vector<float> tone(Packet), output(Packet), missing;
    for (std::uint32_t frame = 0; frame < Packet; ++frame)
        tone[frame] = 0.25F * static_cast<float>(std::sin(frame * 2.0 * 3.14159265358979 / Packet));
    const auto payload = PcmVoiceCodec::encode(tone);
    constexpr std::uint64_t Origin = 10U * Rate;
    auto cursor = Origin + Target;
    (void)network.renderRemote(GenerationId{1}, output, Packet, cursor - Packet);
    const auto receive = [&](std::uint32_t sequence) {
        NetworkTestAccess::pumpRemotePackets(network, "singer", NetworkAudioPacket{
            sequence, (Origin + sequence * Packet) | SharedAudioTimelineFlag,
            1, Packet, payload, VoiceCodec::Pcm16});
    };
    for (std::uint32_t sequence = 0; sequence < 40; ++sequence) {
        receive(sequence);
        (void)network.renderRemote(GenerationId{1}, output, Packet, cursor);
        cursor += Packet;
    }
    receive(100); // It stays encoded while the first 50 ms of missing positions are concealed.
    RealtimeInstrumentation::reset();
    for (std::uint32_t packet = 0; packet < 60; ++packet) {
        if (packet < 20)
            NetworkTestAccess::pumpRemotePackets(network, "singer");
        {
            RealtimeScope realtime;
            (void)network.renderRemote(GenerationId{1}, output, Packet, cursor);
        }
        cursor += Packet;
        missing.insert(missing.end(), output.begin(), output.end());
    }
    const auto violations = RealtimeInstrumentation::snapshot();
    expect(std::any_of(missing.begin(), missing.begin() + Rate / 50U,
                       [](float sample) { return std::abs(sample) > 0.01F; }) &&
               std::all_of(missing.begin() + Rate / 10U, missing.end(),
                           [](float sample) { return sample == 0.0F; }),
           "50 ms of queued PLC followed by starvation shares one finite 100 ms continuation budget");
    expect(violations.allocations == 0 && violations.deallocations == 0 &&
               violations.blockingCalls == 0,
           "tracking the consumed concealment age cannot allocate or wait in render");
}

void queuedFutureVoiceCannotResetAnUnconsumedLossBudget() {
    constexpr std::uint32_t Rate = 48'000, Packet = 120;
    NetworkAudioEngine network;
    network.prepare(Rate, 1, Rate / 2U, Packet, GenerationId{1});
    expect(network.addRemoteParticipant("singer"), "future-voice singer joins");
    NetworkTestAccess::bypassRemoteEffects(network, "singer");
    std::vector<float> tone(960), synthetic(7'200, 0.1F), current(Packet), output(Packet), missing;
    for (std::uint32_t frame = 0; frame < tone.size(); ++frame)
        tone[frame] = 0.25F * static_cast<float>(std::sin(frame * 2.0 * 3.14159265358979 / Packet));
    std::copy_n(tone.begin(), Packet, current.begin());
    expect(NetworkTestAccess::queueVoice(network, "singer", tone), "real voice seeds continuity");
    std::uint64_t cursor = 0;
    for (std::uint32_t frame = 0; frame < tone.size(); frame += Packet, cursor += Packet)
        (void)network.renderRemote(GenerationId{1}, output, Packet, cursor);
    expect(NetworkTestAccess::queueVoice(network, "singer", synthetic, false) &&
               NetworkTestAccess::queueVoice(network, "singer", current),
           "a future real packet can already be queued behind missing positions");
    for (std::uint32_t frame = 0; frame < synthetic.size(); frame += Packet, cursor += Packet) {
        (void)network.renderRemote(GenerationId{1}, output, Packet, cursor);
        missing.insert(missing.end(), output.begin(), output.end());
    }
    expect(std::all_of(missing.begin() + Rate / 10U, missing.end(),
                       [](float sample) { return sample == 0.0F; }),
           "merely queued future voice cannot restart the finite continuation before being consumed");
    (void)network.renderRemote(GenerationId{1}, output, Packet, cursor);
    expect(std::abs(output.back() - current.back()) < 0.000001F,
           "the actual future voice restores its own phase when its FIFO position is consumed");
}

void queuedLossCannotEraseAnEarlierStarvationBudget() {
    constexpr std::uint32_t Rate = 48'000, Packet = 120;
    NetworkAudioEngine network;
    network.prepare(Rate, 1, Rate / 2U, Packet, GenerationId{1});
    expect(network.addRemoteParticipant("singer"), "interleaved-loss singer joins");
    NetworkTestAccess::bypassRemoteEffects(network, "singer");
    std::vector<float> tone(960), output(Packet), missing;
    for (std::uint32_t frame = 0; frame < tone.size(); ++frame)
        tone[frame] = 0.25F * static_cast<float>(std::sin(frame * 2.0 * 3.14159265358979 / Packet));
    expect(NetworkTestAccess::queueVoice(network, "singer", tone), "real PCM seeds render history");
    PcmLossConcealer receiveLoss;
    receiveLoss.remember(tone, 1);
    std::uint64_t cursor = 0;
    for (std::uint32_t frame = 0; frame < tone.size(); frame += Packet, cursor += Packet)
        (void)network.renderRemote(GenerationId{1}, output, Packet, cursor);
    // 20 ms without a queue, then 50 ms of receive-side PLC, then another 100 ms without a queue.
    for (std::uint32_t packet = 0; packet < 68; ++packet) {
        if (packet == 8)
            expect(NetworkTestAccess::queueVoice(network, "singer", receiveLoss.conceal(2'400, 1), false),
                   "receive PLC occupies queue frames without being classified as new real voice");
        (void)network.renderRemote(GenerationId{1}, output, Packet, cursor);
        cursor += Packet;
        missing.insert(missing.end(), output.begin(), output.end());
    }
    expect(std::all_of(missing.begin() + Rate / 10U, missing.end(),
                       [](float sample) { return sample == 0.0F; }),
           "queued PLC between starvation periods cannot restart the finite 100 ms budget");
}

void directSteadyQueuedRealVoiceCannotBecomeConcealment() {
    constexpr std::uint32_t Rate = 48'000, Packet = 120, Ahead = 2'400;
    NetworkAudioEngine network;
    network.prepare(Rate, 1, Rate / 2U, Packet, GenerationId{1});
    expect(network.addRemoteParticipant("singer"), "steady queued singer joins");
    NetworkTestAccess::bypassRemoteEffects(network, "singer");
    std::vector<float> initial(Ahead), packet(Packet), output(Packet);
    const auto voice = [](std::uint32_t frame) {
        return 0.25F * static_cast<float>(std::sin(frame * 2.0 * 3.14159265358979 / Packet));
    };
    for (std::uint32_t frame = 0; frame < Ahead; ++frame)
        initial[frame] = voice(frame);
    for (std::uint32_t frame = 0; frame < Packet; ++frame)
        packet[frame] = voice(frame);
    expect(NetworkTestAccess::queueVoice(network, "singer", initial), "50 ms of real PCM is queued");
    float error = 0.0F;
    for (std::uint32_t frame = 0; frame < Rate; frame += Packet) {
        expect(NetworkTestAccess::queueVoice(network, "singer", packet), "the real queue remains ahead");
        (void)network.renderRemote(GenerationId{1}, output, Packet, frame);
        for (std::uint32_t sample = 0; sample < Packet; ++sample)
            error = std::max(error, std::abs(output[sample] - voice(frame + sample)));
    }
    expect(error < 0.00001F && network.diagnostics().participants.front().queueFillFrames == Ahead,
           "one second of continuously queued real voice is never attenuated as synthetic loss");
}

void sharedVoiceReorderPreservesTimelyPacketsAndPumpsMissingOnes() {
    constexpr std::uint32_t Rate = 48'000, Frames = 120, Target = 55U * 48U;
    constexpr std::uint64_t Origin = 10U * Rate;
    constexpr std::uint32_t Ahead = 25U * 48U;
    struct Scenario {
        bool missingReturns;
        std::uint32_t futurePackets;
    };
    constexpr std::array scenarios{Scenario{true, 4}, Scenario{false, 1}};
    for (const auto scenario : scenarios) {
        NetworkAudioEngine network;
        network.prepare(Rate, 1, Rate / 2U, Frames, GenerationId{1});
        network.setSharedTimeline(true);
        network.setRoomPlayoutDelay(55.0F);
        expect(network.addRemoteParticipant("deadline-singer"), "the timed singer joins");
        network.startReceive(0);
        std::vector<float> voice(Frames), output(Frames);
        for (std::uint32_t frame = 0; frame < Frames; ++frame)
            voice[frame] = 0.3F * static_cast<float>(std::sin(2.0 * 3.14159265358979 * frame / Frames));
        const auto payload = PcmVoiceCodec::encode(voice);
        const auto stage = [&](std::uint32_t sequence, bool drain = true) {
            NetworkTestAccess::pumpRemotePackets(network, "deadline-singer", NetworkAudioPacket{
                sequence, (Origin + sequence * Frames) | SharedAudioTimelineFlag,
                1, Frames, payload, VoiceCodec::Pcm16}, drain);
        };
        const auto waitForDecoded = [&](std::uint64_t decoded) {
            auto diagnostics = network.diagnostics();
            const auto deadline = std::chrono::steady_clock::now() + std::chrono::seconds(1);
            while (diagnostics.participants.front().decodedNonzeroPackets < decoded &&
                   std::chrono::steady_clock::now() < deadline) {
                std::this_thread::yield();
                diagnostics = network.diagnostics();
            }
            return diagnostics;
        };
        auto cursor = Origin + Target - Ahead;
        (void)network.renderRemote(GenerationId{1}, output, Frames, cursor - Frames);
        for (std::uint32_t sequence = 0; sequence < 4; ++sequence)
            stage(sequence);
        expect(network.diagnostics().participants.front().queuedNonzeroPackets == 4,
               "the first four packets initialize the ordinary shared voice queue");
        // Stage exact jitter inputs so local UDP delivery cannot become an accidental loss.
        // Early draining is explicit; expiry below must come from the real receive worker.
        for (std::uint32_t offset = 0; offset < scenario.futurePackets; ++offset)
            stage(5U + offset);
        const auto waiting = network.diagnostics();
        expect(waiting.participants.front().jitter.fillPackets == scenario.futurePackets &&
                   waiting.participants.front().jitter.lostPackets == 0,
               "the engine cannot commit loss before the missing packet's presentation position");
        if (scenario.missingReturns) {
            stage(4);
            const auto recovered = network.diagnostics();
            expect(recovered.participants.front().jitter.lostPackets == 0 &&
                       recovered.participants.front().jitter.latePackets == 0 &&
                       recovered.participants.front().queuedNonzeroPackets == 9,
                   "the full-window delayed packet reaches the queue while its deadline is ahead");
        } else {
            for (std::uint32_t frame = 0; frame < Ahead + 4U * Frames; frame += Frames) {
                (void)network.renderRemote(GenerationId{1}, output, Frames, cursor);
                cursor += Frames;
            }
            // No datagram or helper drain: only the worker timeout can expire this position.
            const auto recovered = waitForDecoded(5);
            expect(recovered.participants.front().jitter.lostPackets == 1 &&
                       recovered.participants.front().queuedNonzeroPackets == 5 &&
                       recovered.participants.front().queueFillFrames == 2U * Frames &&
                       recovered.roomPlayoutDelayFrames == Target,
                   "the worker expires one missing position and queues current voice at the fixed deadline");
            stage(4, false);
            const auto stale = network.diagnostics();
            expect(stale.participants.front().jitter.latePackets == 1 &&
                       stale.participants.front().queuedNonzeroPackets == 5,
                   "expired original PCM cannot be rendered later after concealment");
        }
        network.stop();
    }
}

void sharedVoiceReadsReadyDatagramsBeforeExpiringMissingPositions() {
    constexpr std::uint32_t Rate = 48'000, Packet = 120, Target = 2'640, Token = 83;
    constexpr std::uint64_t Origin = 10U * Rate;
    NetworkAudioEngine network;
    network.prepare(Rate, 1, Rate / 2U, Packet, GenerationId{1});
    network.setSharedTimeline(true);
    network.setRoomPlayoutDelay(55.0F);
    network.setSessionToken(Token);
    expect(network.addRemoteParticipant("singer"), "socket-ready singer joins");
    NetworkTestAccess::useSinglePacketReorder(network, "singer", 24);
    std::vector<float> tone(Packet), output(Packet);
    for (std::uint32_t frame = 0; frame < Packet; ++frame)
        tone[frame] = 0.25F * static_cast<float>(std::sin(frame * 2.0 * 3.14159265358979 / Packet));
    const auto payload = PcmVoiceCodec::encode(tone);
    auto cursor = Origin + Target;
    (void)network.renderRemote(GenerationId{1}, output, Packet, cursor - Packet);
    for (std::uint32_t sequence = 0; sequence < 4; ++sequence) {
        NetworkTestAccess::pumpRemotePackets(network, "singer", NetworkAudioPacket{
            sequence, (Origin + sequence * Packet) | SharedAudioTimelineFlag,
            1, Packet, payload, VoiceCodec::Pcm16});
        (void)network.renderRemote(GenerationId{1}, output, Packet, cursor);
        cursor += Packet;
    }
    for (std::uint32_t sequence = 6; sequence <= 8; ++sequence)
        NetworkTestAccess::pumpRemotePackets(network, "singer", NetworkAudioPacket{
            sequence, (Origin + sequence * Packet) | SharedAudioTimelineFlag,
            1, Packet, payload, VoiceCodec::Pcm16}, false);
    NetworkTestAccess::bindReceiverBeforeWorker(network, "singer");
    UdpSocket sender;
    sender.bind(0);
    // The missing packet is already readable behind one newer datagram when the worker starts.
    for (const auto sequence : {5U, 4U}) {
        const AudioPacketHeader header{sequence, NetworkTestAccess::key("singer"), Token,
                                       (Origin + sequence * Packet) | SharedAudioTimelineFlag,
                                       1, Packet, 0, 1, VoiceCodec::Pcm16, 0};
        const auto encoded = encodeAudioPacketHeader(header);
        std::vector<std::byte> datagram(encoded.begin(), encoded.end());
        datagram.insert(datagram.end(), payload.begin(), payload.end());
        expect(sender.sendTo("127.0.0.1", network.localPort(), datagram), "the datagram is queued before receive begins");
    }
    NetworkTestAccess::startBoundReceiverWorker(network);
    auto diagnostics = network.diagnostics();
    const auto deadline = std::chrono::steady_clock::now() + std::chrono::seconds(1);
    while (diagnostics.participants.front().decodedNonzeroPackets < 9 &&
           std::chrono::steady_clock::now() < deadline) {
        std::this_thread::sleep_for(std::chrono::milliseconds(1));
        diagnostics = network.diagnostics();
    }
    network.stop();
    const auto& singer = diagnostics.participants.front();
    expect(singer.jitter.lostPackets == 0 && singer.jitter.latePackets == 0 &&
               singer.queuedNonzeroPackets == 9,
           "ready original PCM must be read before a timer-only expiry commits PLC at the render horizon");
}

void observedDirectPacketBurstKeepsBoundedPlayoutContinuity() {
    // Only the observed 96-packet window is replayed. Lost/RX-rejected packets and callback
    // wall times were not captured; recorded render cursors preserve the known consumer order.
    const auto base = std::filesystem::path{__FILE__}.parent_path() / "fixtures" /
                      "direct-late-observed-20261015";
    struct Packet {
        std::uint64_t arrivalMicros, timestamp, cursor, pcmOffset;
        std::uint32_t sequence, frames, pcmSamples, originalSkip, target;
    };
    std::vector<Packet> packets;
    std::ifstream packetFile(base.string() + ".csv");
    std::string line;
    std::getline(packetFile, line);
    while (std::getline(packetFile, line)) {
        std::replace(line.begin(), line.end(), ',', ' ');
        std::istringstream row(line);
        Packet packet{};
        expect(static_cast<bool>(row >> packet.arrivalMicros >> packet.sequence >> packet.timestamp >>
                                 packet.cursor >> packet.frames >> packet.pcmOffset >> packet.pcmSamples >>
                                 packet.originalSkip >> packet.target), "observed packet fixture is valid");
        packets.push_back(packet);
    }
    expect(packets.size() == 96, "the immutable real-route snippet contains 96 mapped packets");
    if (packets.size() != 96)
        return;
    std::ifstream pcmFile(base.string() + ".pcm16", std::ios::binary);
    std::vector<std::byte> pcm(static_cast<std::size_t>(std::filesystem::file_size(base.string() + ".pcm16")));
    pcmFile.read(reinterpret_cast<char*>(pcm.data()), static_cast<std::streamsize>(pcm.size()));
    expect(pcmFile.gcount() == static_cast<std::streamsize>(pcm.size()),
           "the fixture has exact sender microphone PCM for every observed packet");
    NetworkAudioEngine network;
    network.prepare(48'000, 1, 24'000, 120, GenerationId{1});
    network.setSharedTimeline(true);
    network.setRoomPlayoutDelay(packets.front().target / 48.0F);
    expect(network.addRemoteParticipant("singer"), "the observed physical-route singer joins");
    NetworkTestAccess::bypassRemoteEffects(network, "singer");
    std::ifstream renderFile(base.string() + ".render.csv");
    std::getline(renderFile, line);
    std::vector<float> output(480);
    std::size_t next = 0;
    std::uint32_t maximumQueue = 0, run = 0, longest = 0, missingFrames = 0;
    const auto firstDue = packets.front().timestamp + packets.front().target;
    const auto coveredEnd = packets.back().timestamp + packets.back().target + packets.back().frames;
    while (std::getline(renderFile, line)) {
        std::replace(line.begin(), line.end(), ',', ' ');
        std::istringstream row(line);
        std::uint64_t position = 0;
        std::uint32_t frames = 0;
        expect(static_cast<bool>(row >> position >> frames) && frames == output.size(),
               "the observed receiver render blocks retain their exact presentation positions");
        (void)network.renderRemote(GenerationId{1}, output, frames, position);
        for (std::uint32_t frame = 0; frame < frames; ++frame) {
            if (position + frame < firstDue || position + frame >= coveredEnd)
                continue;
            if (std::abs(output[frame]) <= 2.0F / 32767.0F) {
                ++run;
            } else {
                if (run >= 48) { longest = std::max(longest, run); missingFrames += run; }
                run = 0;
            }
        }
        NetworkTestAccess::pumpRemotePackets(network, "singer");
        while (next < packets.size() && packets[next].cursor <= position + frames) {
            const auto& packet = packets[next++];
            expect(packet.cursor == position + frames,
                   "every observed packet is replayed at its exact captured receiver cursor");
            const auto begin = pcm.begin() + static_cast<std::ptrdiff_t>(packet.pcmOffset * 2U);
            const auto end = begin + static_cast<std::ptrdiff_t>(packet.pcmSamples * 2U);
            NetworkTestAccess::pumpRemotePackets(network, "singer", NetworkAudioPacket{
                packet.sequence, packet.timestamp | SharedAudioTimelineFlag, 1, packet.frames,
                {begin, end}, VoiceCodec::Pcm16});
            maximumQueue = std::max(maximumQueue, network.diagnostics().participants.front().queueFillFrames);
        }
    }
    if (run >= 48) { longest = std::max(longest, run); missingFrames += run; }
    const auto diagnostics = network.diagnostics();
    const auto& participant = diagnostics.participants.front();
    std::printf("OBSERVED_PACKET_REPLAY packets=%zu originalLate=13 actualLate=%llu "
                "missingPcmMs=%.6f longestZeroMs=%.6f maxQueueFrames=%u finalQueueFrames=%u deadlineMs=%.3f\n",
                next, static_cast<unsigned long long>(participant.lateAudioCuts),
                missingFrames / 48.0, longest / 48.0, maximumQueue, participant.queueFillFrames,
                diagnostics.roomPlayoutDelayFrames / 48.0);
    expect(next == packets.size() && missingFrames == 0 && longest == 0 &&
               participant.lateAudioCuts == 13 && maximumQueue <= packets.front().target + 480 &&
               participant.queueFillFrames == 0 && diagnostics.roomPlayoutDelayFrames == packets.front().target,
           "the observed real packet burst has no PCM holes despite the same expired packets and unchanged deadline");
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
    expect(maximumInteractiveRoomDelayFrames(24'000, 240, 48'000, 1'440) == 12'000,
           "live room latency stays bounded even when a stale route fills a large queue");

    NetworkAudioEngine network;
    network.prepare(48'000, 1, 4'800, 240, GenerationId{1});
    network.setSharedTimeline(true);
    const auto diagnostics = network.diagnostics();
    expect(diagnostics.sharedTimeline && diagnostics.sharedTargetDelayFrames == 480,
           "karaoke starts from a low-latency ten millisecond room playout target");
}

void roomConversationDeadlineSupports250Milliseconds() {
    expect(maximumInteractiveRoomDelayFrames(24'000, 240, 48'000, 1'440) == 12'000,
           "conversation may use a bounded 250 ms deadline");

    NetworkAudioEngine network;
    network.prepare(48'000, 1, 24'000, 240, GenerationId{1});
    network.setRoomPlayoutDelay(250.0F);
    expect(network.diagnostics().roomPlayoutDelayFrames == 12'000,
           "the client applies the 250 ms server deadline without truncation");
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
    constexpr auto interactiveLimit = rate * 250U / 1'000U;
    const auto limit =
        maximumInteractiveRoomDelayFrames(rate / 2U, rate / 200U, rate, rate * 20U / 1'000U);

    expect(limit <= interactiveLimit, "a live room cannot turn route changes into more than 250 "
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
    for (const bool serverMixFirst : {false, true}) {
        NetworkAudioEngine network;
        network.prepare(48'000, 1, 24'000, 240, GenerationId{1});
        std::array<std::string_view, 2> participants{"remote-singer", "__room_server_mix__"};
        if (serverMixFirst)
            std::ranges::reverse(participants);
        for (const auto participant : participants)
            expect(network.addRemoteParticipant(std::string{participant}),
                   "the direct singer and server mix register before device recovery");
        network.setSharedTimeline(true);
        expect(network.setDirectPeer("remote-singer", "127.0.0.1", 9, 1) &&
                   network.setRemoteMute("__room_server_mix__", true),
               "the measured direct route is selected and the server backup is muted");
        NetworkTestAccess::seedRouteMeasurement(
            network, "remote-singer", StableLatenessHistory::BlockPackets * StableLatenessHistory::MinimumBlocks);
        const auto before = network.diagnostics();
        const auto beforeSinger = std::ranges::find_if(before.participants, [](const auto& participant) {
            return participant.participantId == "remote-singer";
        });
        const auto blocksBeforeRecovery = beforeSinger->stableBlocks;
        network.startReceive(0);
        network.startSend("127.0.0.1", 9);

        network.prepare(48'000, 1, 24'000, 240, GenerationId{2});

        const auto diagnostics = network.diagnostics();
        network.stop();
        const auto singer = std::ranges::find_if(diagnostics.participants, [](const auto& participant) {
            return participant.participantId == "remote-singer";
        });
        expect(diagnostics.transportRunning && diagnostics.sendEnabled && diagnostics.sharedTimeline &&
                   diagnostics.participants.size() == 2 && singer != diagnostics.participants.end(),
               "room voice transport and both participants survive an audio-device recovery");
        expect(singer != diagnostics.participants.end() &&
                   singer->stableBlocks == blocksBeforeRecovery && blocksBeforeRecovery != 0,
               "device recovery restores route history after mute properties regardless of slot order");
    }
}

void leavingRemoteParticipantRevokesItsDirectDestination() {
    NetworkAudioEngine engine;
    engine.prepare(48'000, 1, 24'000, 120, GenerationId{1});
    expect(engine.addRemoteParticipant("guest"), "register guest");
    expect(engine.setDirectPeer("guest", "127.0.0.1", 41002, 2), "register direct destination");
    expect(engine.diagnostics().directPeerCount == 1, "one direct destination");
    expect(engine.removeRemoteParticipant("guest"), "remove guest");
    expect(engine.diagnostics().directPeerCount == 0, "leaving stops microphone delivery to the old address");
}

void udpSocketShortPollingPreservesPacedDatagrams() {
    constexpr std::uint32_t Packets = 128;
    for (const auto timeoutMs : {100U, 2U}) {
        UdpSocket receiver, sender;
        receiver.bind(0);
        sender.bind(0);
        receiver.setReceiveTimeoutMs(timeoutMs);
        const auto port = receiver.localPort();
        std::atomic<bool> sentAll{true};
        std::thread producer([&] {
            const auto start = std::chrono::steady_clock::now() + std::chrono::milliseconds(5);
            std::array<std::byte, AudioPacketHeaderBytes + 240> packet{};
            for (std::uint32_t sequence = 0; sequence < Packets; ++sequence) {
                std::this_thread::sleep_until(start + std::chrono::microseconds(sequence * 2'500U));
                packet.front() = static_cast<std::byte>(sequence);
                if (!sender.sendTo("127.0.0.1", port, packet))
                    sentAll.store(false, std::memory_order_release);
            }
        });
        std::array<bool, Packets> seen{};
        std::uint32_t received = 0, timeouts = 0;
        std::array<std::byte, 512> bytes{};
        const auto deadline = std::chrono::steady_clock::now() + std::chrono::seconds(1);
        while (received < Packets && std::chrono::steady_clock::now() < deadline) {
            const auto count = receiver.receive(bytes);
            if (count == 0) {
                ++timeouts;
                continue;
            }
            const auto sequence = std::to_integer<std::uint32_t>(bytes.front());
            if (sequence < seen.size() && !seen[sequence]) {
                seen[sequence] = true;
                ++received;
            }
        }
        producer.join();
        std::printf("PACED_UDP timeoutMs=%u sent=%u received=%u timeoutReturns=%u\n",
                    timeoutMs, Packets, received, timeouts);
        expect(sentAll.load(std::memory_order_acquire) && received == Packets,
               "short receive polling preserves every paced loopback voice datagram");
    }
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
    const auto senderIdentity = UdpSocket::endpointIdentity("127.0.0.1", sender.localPort());
    expect(first.lastSourceIdentity() == senderIdentity && second.lastSourceIdentity() == senderIdentity,
           "received datagrams retain their actual IPv4 source endpoint identity");

    // `first` treats `second` as its relay; a packet from `sender` is a direct one.
    first.connect("127.0.0.1", second.localPort(), 0);
    expect(second.sendTo("127.0.0.1", first.localPort(), payload) &&
               first.receive(received) == payload.size() && first.lastFromDefaultPeer() &&
               first.lastSourceIdentity() == UdpSocket::endpointIdentity("127.0.0.1", second.localPort()),
           "a packet from the relay address is recognised as relayed");
    expect(sender.sendTo("127.0.0.1", first.localPort(), payload) &&
               first.receive(received) == payload.size() && !first.lastFromDefaultPeer() &&
               first.lastSourceIdentity() == senderIdentity,
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
           "rare stalls do not set the target: it is the level 99% of packets stayed within");
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

void oneSchedulerFreezeDoesNotBecomeTheRoomDelay() {
    constexpr std::int64_t stableRouteFrames = 2'400; // 50 ms at the transport's 48 kHz
    constexpr std::int64_t stalledRouteFrames = 6'240; // 130 ms while one callback is stalled
    constexpr std::uint32_t stalledPackets = 108; // the 270 ms streak observed in the live room
    VoiceLatenessTracker lateness;
    for (std::uint32_t packet = 0; packet < VoiceLatenessTracker::WindowPackets; ++packet) {
        const auto frozen = packet >= 4'000U && packet < 4'000U + stalledPackets;
        lateness.note(frozen ? stalledRouteFrames : stableRouteFrames);
    }

    expect(lateness.targetFrames() == stableRouteFrames + VoiceLatenessTracker::BinFrames,
           "one contiguous scheduler freeze is cut instead of advertising 130 ms for a 50 ms route");
}

void directContinuityBudgetRetainsBurstsAndExpiresThem() {
    VoiceLatenessTracker lateness;
    for (std::uint32_t i = 0; i < VoiceLatenessTracker::WindowPackets; ++i)
        lateness.note(i == 0 ? 4'608 : 1'440); // 96 ms burst on a 30 ms route
    expect(lateness.targetFrames() == 1'464,
           "legacy low-latency quantile still discards the rare burst");
    expect(lateness.continuityFrames() == 4'632,
           "direct continuity budget covers the observed burst instead of sacrificing voice");
    lateness.note(1'440);
    expect(lateness.continuityFrames() == 1'464,
           "expired bursts do not accumulate into an ever-growing buffer");
    lateness.note(100'000);
    expect(lateness.continuityFrames() == VoiceLatenessTracker::BinCount * VoiceLatenessTracker::BinFrames,
           "continuity measurement has a bounded range");
    lateness.reset();
    expect(lateness.continuityFrames() == 0, "a new device/session must calibrate anew");
}

void roomNetworkWorkersUseMultimediaScheduling() {
#ifdef _WIN32
    NetworkAudioEngine network;
    network.prepare(48'000, 1, 4'800, 240, GenerationId{1});
    network.startReceive(0);
    network.startSend("127.0.0.1", 9);
    bool scheduled = false;
    const auto deadline = std::chrono::steady_clock::now() + std::chrono::seconds(1);
    while (std::chrono::steady_clock::now() < deadline) {
        const auto diagnostics = network.diagnostics();
        if (diagnostics.sendMmcssActive && diagnostics.receiveMmcssActive) {
            scheduled = true;
            break;
        }
        std::this_thread::sleep_for(std::chrono::milliseconds(1));
    }
    network.stop();
    expect(scheduled, "live voice send and receive workers use multimedia scheduling");
    const auto stopped = network.diagnostics();
    expect(!stopped.sendMmcssActive && !stopped.receiveMmcssActive,
           "stopped voice workers release their multimedia scheduling registrations");
#endif
}

void directRoomDeadlineUsesReadyVoiceInsteadOfAnOldBurst() {
    NetworkAudioEngine network;
    network.prepare(48'000, 1, 24'000, 240, GenerationId{1});
    network.setSharedTimeline(true);
    expect(network.addRemoteParticipant("direct-singer"), "direct singer joins");
    expect(network.setDirectPeer("direct-singer", "127.0.0.1", 9, 1),
           "the peer uses the direct route");
    NetworkTestAccess::seedDirectReadyVoice(network, "direct-singer");
    const auto deadline = network.diagnostics().advertisedTargetDelayFrames;
    expect(deadline >= 75U * 48U && deadline <= 80U * 48U,
           "pre-song direct deadline includes decoding/queue readiness but not one old burst");
}

void directRoomFirstStartUsesMeasuredBootstrap() {
    struct FirstStart {
        std::uint32_t elapsedSeconds;
        StableLatenessSource source;
    };
    constexpr FirstStart starts[]{
        {0, StableLatenessSource::Unknown},
        {5, StableLatenessSource::Bootstrap},
        {15, StableLatenessSource::ShortWindow},
    };
    for (const auto& [elapsedSeconds, source] : starts) {
        NetworkAudioEngine network;
        network.prepare(48'000, 1, 24'000, 120, GenerationId{1});
        network.setSharedTimeline(true);
        expect(network.addRemoteParticipant("singer"), "the new singer joins");
        expect(network.setDirectPeer("singer", "127.0.0.1", 9, 1), "direct route is selected");
        NetworkTestAccess::seedRouteMeasurement(network, "singer",
                                               elapsedSeconds * VoicePacketsPerSecond);

        const auto diagnostics = network.diagnostics();
        const auto requirement = diagnostics.advertisedTargetDelayFrames;
        expect(elapsedSeconds == 0 ? requirement == 0
                                  : requirement >= 35U * 48U && requirement <= 45U * 48U,
               "first Play publishes available route measurements, or unknown zero, never conversation 250 ms");
        expect(diagnostics.requirementSource == source,
               "published first-start diagnostics distinguish unknown, bootstrap and short-window measurements");
    }
}

namespace {
void prepareMeasuredDirectRoute(NetworkAudioEngine& network, std::uint16_t port = 9) {
    network.prepare(48'000, 1, 24'000, 120, GenerationId{1});
    network.setSessionToken(77);
    network.setSharedTimeline(true);
    expect(network.addRemoteParticipant("singer"), "the measured singer joins");
    expect(network.setDirectPeer("singer", "127.0.0.1", port, 1), "the measured direct route is selected");
    NetworkTestAccess::seedRouteMeasurement(
        network, "singer", StableLatenessHistory::BlockPackets * StableLatenessHistory::MinimumBlocks);
}

NetworkDiagnostics receiveCurrentRoutePackets(NetworkAudioEngine& network, UdpSocket& sender,
                                               std::uint32_t epoch) {
    constexpr std::uint32_t Rate = 48'000, Frames = 120;
    constexpr std::uint64_t Timeline = 10U * Rate;
    if (!network.diagnostics().transportRunning)
        network.startReceive(0);
    std::array<float, Frames> output{};
    (void)network.renderRemote(GenerationId{1}, output, Frames, Timeline - Frames);
    const auto payload = PcmVoiceCodec::encode(std::vector<float>(Frames, 0.1F));
    for (std::uint32_t sequence = 0; sequence < 8; ++sequence) {
        const AudioPacketHeader header{sequence, NetworkTestAccess::key("singer"), 77,
                                       (Timeline - 480U + sequence * Frames) | SharedAudioTimelineFlag,
                                       1, Frames, 0, epoch, VoiceCodec::Pcm16, 0};
        const auto encoded = encodeAudioPacketHeader(header);
        std::vector<std::byte> packet(encoded.begin(), encoded.end());
        packet.insert(packet.end(), payload.begin(), payload.end());
        expect(sender.sendTo("127.0.0.1", network.localPort(), packet), "current route packet is sent");
    }
    auto diagnostics = network.diagnostics();
    const auto deadline = std::chrono::steady_clock::now() + std::chrono::seconds(1);
    while (diagnostics.packetsReceived < 8 && std::chrono::steady_clock::now() < deadline) {
        std::this_thread::sleep_for(std::chrono::milliseconds(1));
        diagnostics = network.diagnostics();
    }
    network.stop();
    expect(diagnostics.packetsReceived == 8 && diagnostics.participants.front().decodedNonzeroPackets > 0,
           "real packets pass through the receiving and decoding path");
    return diagnostics;
}
} // namespace

void roomRouteHistorySurvivesStreamEpoch() {
    UdpSocket sender;
    sender.bind(0);
    NetworkAudioEngine network;
    prepareMeasuredDirectRoute(network, sender.localPort());
    const auto before = network.diagnostics().participants.front().stableBlocks;

    const auto after = receiveCurrentRoutePackets(network, sender, 2);

    expect(after.participants.front().stableBlocks == before && before != 0,
           "a new stream epoch from the same direct endpoint preserves the measured route history");
    expect(after.requirementSource == StableLatenessSource::StableHistory,
           "the preserved route stays a stable-history measurement after a new stream epoch");
    expect(after.advertisedTargetDelayFrames >= 35U * 48U &&
               after.advertisedTargetDelayFrames <= 45U * 48U,
           "the new epoch publishes its preserved stable requirement immediately");
}

void roomRelayFallbackCannotFreshenDirectMeasurements() {
    UdpSocket relay;
    relay.bind(0);
    NetworkAudioEngine network;
    prepareMeasuredDirectRoute(network);
    NetworkTestAccess::expireRouteMeasurement(network, "singer");
    network.startReceive(0);
    network.startSend("127.0.0.1", relay.localPort());

    const auto after = receiveCurrentRoutePackets(network, relay, 1);

    expect(after.participants.front().relayFirstPackets == 8 &&
               after.advertisedTargetDelayFrames == 0 &&
               after.requirementSource == StableLatenessSource::Unknown,
           "fresh relay fallback cannot present an expired direct measurement as a fresh direct requirement");
}

void roomNewEndpointCannotUseOldPeerMeasurements() {
    UdpSocket oldPeer, newPeer;
    oldPeer.bind(0);
    newPeer.bind(0);
    NetworkAudioEngine network;
    prepareMeasuredDirectRoute(network, oldPeer.localPort());
    network.setRoomClock(10'000'000, monotonicTicksNow() / 1'000);
    expect(network.setDirectPeer("singer", "127.0.0.1", newPeer.localPort(), 1),
           "the participant moves to a genuinely different direct endpoint");

    const auto after = receiveCurrentRoutePackets(network, oldPeer, 1);

    expect(after.participants.front().routeHistorySamples == 0 &&
               after.advertisedTargetDelayFrames == 0 &&
               after.requirementSource == StableLatenessSource::Unknown,
           "in-flight packets from the old endpoint cannot bootstrap measurements of the new physical route");
}

void roomRouteHistoryFollowsSelectedAudibleRoute() {
    NetworkAudioEngine network;
    prepareMeasuredDirectRoute(network);
    expect(network.addRemoteParticipant("__room_server_mix__"), "the relay backup joins");
    expect(network.setRemoteMute("__room_server_mix__", true), "direct voice is the selected route");
    NetworkTestAccess::seedRouteMeasurement(
        network, "singer", StableLatenessHistory::BlockPackets * StableLatenessHistory::MinimumBlocks);
    NetworkTestAccess::seedMeasuredServerMixRoute(network, 0);
    const auto directBlocks = network.diagnostics().participants.front().stableBlocks;

    expect(network.setRemoteMute("singer", true) && network.setRemoteMute("singer", false),
           "the listener can mute and unmute the singer without changing the physical route");
    expect(network.diagnostics().participants.front().stableBlocks == directBlocks && directBlocks != 0,
           "an ordinary singer mute preserves physical-route history");

    expect(network.setRemoteMute("__room_server_mix__", false) && network.setRemoteMute("singer", true),
           "the real route-selection controls activate relay fallback");
    const auto relay = network.diagnostics();
    expect(relay.participants.front().stableBlocks == 0 &&
               relay.advertisedTargetDelayFrames == 80U * 48U,
           "audible direct-to-relay selection clears direct history and retains the measured relay requirement");

    NetworkTestAccess::seedRouteMeasurement(
        network, "singer", StableLatenessHistory::BlockPackets * StableLatenessHistory::MinimumBlocks);
    expect(network.setRemoteMute("__room_server_mix__", true) && network.setRemoteMute("singer", false),
           "the real route-selection controls return to direct voice");
    const auto direct = network.diagnostics();
    expect(direct.participants.front().stableBlocks == 0 &&
               direct.advertisedTargetDelayFrames == 0 &&
               direct.requirementSource == StableLatenessSource::Unknown,
           "relay-to-direct selection starts an unmeasured direct route instead of reusing the previous route");
}

void roomRouteHistorySurvivesSameRouteRecovery() {
    UdpSocket sender;
    sender.bind(0);
    NetworkAudioEngine network;
    prepareMeasuredDirectRoute(network, sender.localPort());
    network.setRoomPlayoutDelay(60.0F);
    const auto before = network.diagnostics().participants.front().stableBlocks;
    NetworkTestAccess::excludeVoice(network, "singer");
    network.setGeneration(GenerationId{2});
    network.setGeneration(GenerationId{1});

    const auto after = receiveCurrentRoutePackets(network, sender, 1);

    expect(!after.participants.front().timelineExcluded &&
               after.participants.front().stableBlocks == before && before != 0,
           "temporary exclusion and audio-generation recovery of the same route preserve history");
}

void roomRouteHistorySurvivesPlaybackBoundary() {
    NetworkAudioEngine network;
    prepareMeasuredDirectRoute(network);
    const auto before = network.diagnostics();
    for (std::uint32_t start = 0; start < 4; ++start) {
        network.setFollowLocked(true);
        network.setFollowLocked(false);
        network.setRoomPlayoutDelay(60.0F);
        network.setSharedTimeline(true);

        const auto after = network.diagnostics();
        expect(after.participants.front().stableBlocks == before.participants.front().stableBlocks &&
                   after.advertisedTargetDelayFrames == before.advertisedTargetDelayFrames &&
                   after.requirementSource == StableLatenessSource::StableHistory,
               "four identical playback boundaries preserve history and publish the same measured deadline");
    }
}

void roomRouteHistoryResetsWithRouteIdentity() {
    struct RouteChange {
        const char* message;
        void (*apply)(NetworkAudioEngine&);
        bool preserves = false;
    };
    const RouteChange changes[]{
        {"the same direct endpoint and credentials preserve history", [](auto& network) {
             expect(network.setDirectPeer("singer", "127.0.0.1", 9, 1), "same peer is accepted");
         }, true},
        {"a new direct endpoint discards history", [](auto& network) {
             expect(network.setDirectPeer("singer", "127.0.0.1", 10, 1), "new endpoint is accepted");
         }},
        {"a new direct address discards history", [](auto& network) {
             expect(network.setDirectPeer("singer", "127.0.0.2", 9, 1), "new address is accepted");
         }},
        {"new peer credentials discard history", [](auto& network) {
             expect(network.setDirectPeer("singer", "127.0.0.1", 9, 2), "new peer session is accepted");
         }},
        {"the same voice session preserves history", [](auto& network) { network.setSessionToken(77); }, true},
        {"a new voice session discards history", [](auto& network) { network.setSessionToken(78); }},
        {"direct to relay discards direct history", [](auto& network) { network.clearDirectPeers(); }},
        {"relay to direct discards relay history", [](auto& network) {
             network.clearDirectPeers();
             NetworkTestAccess::seedRouteMeasurement(
                 network, "singer", StableLatenessHistory::BlockPackets * StableLatenessHistory::MinimumBlocks);
             expect(network.setDirectPeer("singer", "127.0.0.1", 9, 1), "direct route returns");
         }},
        {"a new participant cannot inherit the previous singer's history", [](auto& network) {
             expect(network.removeRemoteParticipant("singer"), "old singer leaves");
             expect(network.addRemoteParticipant("new-singer"), "new singer joins the released slot");
         }},
    };
    for (const auto& change : changes) {
        NetworkAudioEngine network;
        prepareMeasuredDirectRoute(network);
        const auto before = network.diagnostics().participants.front().stableBlocks;

        change.apply(network);

        expect(network.diagnostics().participants.front().stableBlocks == (change.preserves ? before : 0U),
               change.message);
    }
}

} // namespace Tests
