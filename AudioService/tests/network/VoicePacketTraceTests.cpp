#include "TestHarness.hpp"
#include "network/VoicePacketTrace.hpp"
#include "realtime/RealtimeInstrumentation.hpp"

#include <array>
#include <atomic>
#include <filesystem>
#include <fstream>
#include <thread>

namespace Tests {
void fullSongTraceRetainsFirstMiddleAndLastPacketWithoutOverwrite() {
    VoicePacketTrace trace;
    constexpr std::uint32_t Packets = 161U * 400U;
    trace.prepare({Packets, Packets * 8U, Packets});
    trace.start();
    for (std::uint32_t sequence = 0; sequence < Packets; ++sequence) {
        VoicePacketTrace::SenderEvent event;
        event.packet.sequence = sequence;
        event.effectiveFrame = static_cast<std::uint64_t>(sequence) * 120U;
        (void)trace.appendSender(event);
        VoicePacketTrace::ReceiveEvent received;
        received.packet.sequence = sequence;
        for (std::uint32_t stage = 0; stage < 8; ++stage)
            (void)trace.appendReceive(received);
        VoicePacketTrace::RenderEvent rendered;
        rendered.outputTimelineFrame = event.effectiveFrame;
        (void)trace.appendRender(rendered);
    }
    trace.stop();
    const auto events = trace.senderEvents();
    expect(events.size() == Packets, "whole 161-second take must fit without overwriting packets");
    if (events.size() != Packets)
        return;
    expect(events.front().packet.sequence == 0 &&
               events[Packets / 2U].packet.sequence == Packets / 2U &&
               events.back().packet.sequence == Packets - 1U,
           "first, middle and final packet identity must survive full-song trace");
    expect(trace.status().complete(), "bounded full-song trace must declare complete coverage");
    expect(trace.status().receiveEvents == Packets * 8U &&
               trace.status().renderEvents == Packets,
           "full-duplex socket copies and decisions must survive alongside the sender trace");
}

void traceOverflowIsExplicitAndDoesNotOverwriteEarlierEvents() {
    VoicePacketTrace trace;
    trace.prepare({2, 2, 2});
    trace.start();
    for (std::uint32_t sequence = 0; sequence < 5; ++sequence) {
        VoicePacketTrace::ReceiveEvent event;
        event.packet.sequence = sequence;
        (void)trace.appendReceive(event);
    }
    trace.stop();
    expect(trace.status().receiveEvents == 2 && trace.status().receiveOverflow == 3,
           "every event beyond capacity must count as explicit trace overflow");
    expect(!trace.status().complete(), "overflowed capture cannot be accepted as complete");
    const auto events = trace.receiveEvents();
    expect(events.size() == 2 && events.front().packet.sequence == 0 &&
               events.back().packet.sequence == 1,
           "overflow must retain original evidence instead of replacing it");
}

void stoppedTraceRejectsPacketsAndNewTakeDoesNotInheritOldEvents() {
    VoicePacketTrace trace;
    trace.prepare({4, 4, 4});
    VoicePacketTrace::SenderEvent oldEvent;
    oldEvent.packet.sequence = 44;
    expect(!trace.appendSender(oldEvent), "prepared but unarmed trace must reject packets");
    trace.start();
    (void)trace.appendSender(oldEvent);
    trace.stop();
    const auto firstEpoch = trace.status().captureEpoch;
    expect(!trace.appendSender(oldEvent), "stopped trace must not accept a late packet");
    trace.start();
    VoicePacketTrace::SenderEvent newEvent;
    newEvent.packet.sequence = 88;
    (void)trace.appendSender(newEvent);
    trace.stop();
    const auto events = trace.senderEvents();
    expect(trace.status().captureEpoch > firstEpoch && events.size() == 1 &&
               events.front().packet.sequence == 88,
           "new trace epoch must contain only the new take");
}

void traceAppendDoesNotAllocateOrBlockOnRealtimeThread() {
    VoicePacketTrace trace;
    trace.prepare({64, 64, 64});
    trace.start();
    const auto before = RealtimeInstrumentation::snapshot();
    {
        RealtimeScope realtime;
        for (std::uint32_t index = 0; index < 32; ++index) {
            (void)trace.appendSender({});
            (void)trace.appendReceive({});
            (void)trace.appendRender({});
        }
    }
    trace.stop();
    const auto after = RealtimeInstrumentation::snapshot();
    expect(after.allocations == before.allocations &&
               after.deallocations == before.deallocations &&
               after.blockingCalls == before.blockingCalls &&
               after.diskIoCalls == before.diskIoCalls,
           "fixed trace append must not allocate, lock, wait or write files on realtime thread");
    expect(trace.status().senderEvents == 32 && trace.status().receiveEvents == 32 &&
               trace.status().renderEvents == 32,
           "all three producer lanes must publish their realtime metadata");
}

void stoppedTraceExportsExactPacketAndQueueJoinFields() {
    VoicePacketTrace trace;
    trace.prepare({2, 2, 2});
    trace.start();
    VoicePacketTrace::ReceiveEvent packet;
    packet.packet.sequence = 123;
    packet.packet.streamEpoch = 7;
    packet.stage = VoicePacketTrace::ReceiveStage::Decision;
    packet.reason = VoicePacketTrace::ReceiveReason::Retimed;
    packet.decodedKind = VoicePacketTrace::DecodedKind::Real;
    packet.sourceOffsetFrames = 9;
    packet.correctedFrames = 119;
    packet.queue = {4, 9876, 119};
    packet.queueAccepted = true;
    (void)trace.appendReceive(packet);
    trace.stop();
    const auto prefix = (std::filesystem::temp_directory_path() /
                         "ad-voice-packet-trace-export-test").string();
    trace.exportCsv(prefix);
    std::ifstream input(prefix + ".receive.csv");
    std::string header;
    std::string row;
    std::getline(input, header);
    std::getline(input, row);
    input.close();
    expect(header.find("queueStartFrame") != std::string::npos &&
               header.find("sourceOffsetFrames") != std::string::npos &&
               header.find("decodedKind") != std::string::npos &&
               row.find("RETIMED") != std::string::npos &&
               row.find("REAL") != std::string::npos && row.find("9876") != std::string::npos,
           "CSV must preserve sequence, admission positions, correction and PCM provenance");
    for (const auto* suffix : {".sender.csv", ".receive.csv", ".render.csv", ".status.csv"})
        std::filesystem::remove(prefix + suffix);
}

void traceStopAndRearmAreSafeAgainstConcurrentProducers() {
    VoicePacketTrace trace;
    trace.prepare({4096, 4096, 4096});
    std::atomic<bool> finished{false};
    std::atomic<std::uint64_t> attempts{0};
    std::thread producer([&] {
        while (!finished.load(std::memory_order_acquire)) {
            (void)trace.appendSender({});
            attempts.fetch_add(1, std::memory_order_release);
        }
    });
    for (std::uint32_t take = 0; take < 32; ++take) {
        trace.start();
        const auto before = attempts.load(std::memory_order_acquire);
        while (attempts.load(std::memory_order_acquire) == before)
            std::this_thread::yield();
        trace.stop();
        const auto stoppedCount = trace.status().senderEvents;
        const auto stoppedAttempts = attempts.load(std::memory_order_acquire);
        while (attempts.load(std::memory_order_acquire) == stoppedAttempts)
            std::this_thread::yield();
        expect(trace.status().senderEvents == stoppedCount,
               "after stop returns a racing producer cannot mutate the captured take");
    }
    finished.store(true, std::memory_order_release);
    producer.join();
    trace.start();
    VoicePacketTrace::SenderEvent finalPacket;
    finalPacket.packet.sequence = 991;
    (void)trace.appendSender(finalPacket);
    trace.stop();
    const auto events = trace.senderEvents();
    expect(events.size() == 1 && events.front().packet.sequence == 991,
           "rearm after a running producer retains only the final epoch");
}

void tracePcmMetricsIdentifyContentWithoutChangingSamples() {
    const std::array samples{0.0F, 0.5F, -0.5F, 0.0F};
    const auto metrics = VoicePacketTrace::measurePcm(samples);
    expect(metrics.hash != 0 && metrics.energy == 0.5 && metrics.peak == 0.5F &&
               metrics.zeroFrames == 2,
           "trace PCM metrics must identify real source activity and exact digital silence");
    const auto stereo = VoicePacketTrace::measurePcm(samples, 2);
    expect(stereo.zeroFrames == 0 && stereo.hash == metrics.hash,
           "a frame is silent only if every channel is exactly zero; channel layout does not alter hash");
    const auto quiet = VoicePacketTrace::measurePcm(samples, 1, 0.5F);
    const std::array expectedQuiet{0.0F, 0.25F, -0.25F, 0.0F};
    const auto expected = VoicePacketTrace::measurePcm(expectedQuiet);
    expect(quiet.hash == expected.hash && quiet.energy == 0.125 && quiet.peak == 0.25F &&
               quiet.zeroFrames == 2,
           "contribution metrics must describe the actual gain-multiplied PCM");
    const auto muted = VoicePacketTrace::measurePcm(samples, 1, 0.0F);
    expect(muted.energy == 0.0 && muted.peak == 0.0F && muted.zeroFrames == samples.size(),
           "zero gain must report a silent contribution rather than source activity");
    expect(samples == std::array{0.0F, 0.5F, -0.5F, 0.0F},
           "gain-aware diagnostic measurement must never alter the source samples");
}

void traceRejectsAnOldTakeTokenAfterImmediateRearm() {
    VoicePacketTrace trace;
    trace.prepare({4, 4, 4});
    trace.start();
    const auto oldToken = trace.captureToken();
    VoicePacketTrace::SenderEvent sender;
    sender.packet.sequence = 44;
    trace.stop();
    trace.start();
    const auto currentToken = trace.captureToken();
    expect(currentToken != 0 && currentToken != oldToken,
           "rearmed capture must publish a different token before event construction");
    expect(!trace.appendSender(sender, oldToken) &&
               !trace.appendReceive({}, oldToken) && !trace.appendRender({}, oldToken),
           "an event assembled during the prior take cannot enter the rearmed trace");
    sender.packet.sequence = 88;
    (void)trace.appendSender(sender, currentToken);
    trace.stop();
    const auto events = trace.senderEvents();
    expect(events.size() == 1 && events.front().packet.sequence == 88 &&
               trace.status().receiveEvents == 0 && trace.status().renderEvents == 0,
           "only the current take's event may survive the stop/rearm boundary");
}
} // namespace Tests
