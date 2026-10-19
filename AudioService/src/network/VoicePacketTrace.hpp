#pragma once

#include "common/Types.hpp"
#include "network/NetworkPacket.hpp"

#include <atomic>
#include <cstddef>
#include <cstdint>
#include <span>
#include <string>
#include <vector>

// Diagnostic metadata only. Three independent single-producer lanes never affect audio queues.
// prepare/start/stop/export and lifetime changes belong to the serial control thread. The owning
// engine must stop its producers before destroying this object. Event views require stopped capture.
class VoicePacketTrace {
  public:
    static constexpr std::size_t SenderCapacity = 131'072;
    static constexpr std::size_t ReceiveCapacity = 1'048'576;
    static constexpr std::size_t RenderCapacity = 524'288;
    struct Capacities {
        std::size_t sender{SenderCapacity};
        std::size_t receive{ReceiveCapacity};
        std::size_t render{RenderCapacity};
    };
    struct PcmMetrics {
        std::uint64_t hash{0};
        double energy{0.0};
        float peak{0.0F};
        std::uint32_t zeroFrames{0};
    };
    struct PacketIdentity {
        GenerationId generation{0};
        std::uint32_t participantKey{0};
        std::uint32_t streamEpoch{0};
        std::uint32_t sequence{0};
        VoiceCodec codec{VoiceCodec::Pcm16};
    };
    struct QueueSpan {
        std::uint64_t epoch{0};
        std::uint64_t startFrame{0};
        std::uint32_t frames{0};
    };
    struct SenderEvent {
        PacketIdentity packet{};
        std::uint64_t captureFirstFrame{0};
        std::uint64_t captureEndFrame{0};
        std::uint64_t effectiveFrame{0};
        std::uint64_t payloadHash{0};
        std::uint64_t encodeStartMicros{0};
        std::uint64_t encodeEndMicros{0};
        std::uint64_t sendStartMicros{0};
        std::uint64_t sendEndMicros{0};
        std::uint64_t directEndpoint{0};
        PcmMetrics pcm{};
        std::uint32_t frames{0};
        std::uint32_t sourceFrames{0};
        bool captureClockValid{false};
        bool endsBeforeGap{false};
        bool relaySent{false};
        bool directSent{false};
    };
    enum class ReceiveStage : std::uint8_t { Socket, Reorder, Decision, Count };
    enum class ReceiveReason : std::uint8_t {
        Received, WrongSession, SelfEcho, Duplicate, UnknownParticipant, OldGeneration,
        EpochReset, ReorderAccepted, ReorderLate, ReorderDuplicate, ReorderOverflow,
        ReorderRebase, DecodeEmpty, InitialSkip, ExcludedWait, BeyondCeiling,
        QueueLate, Retimed, Queued, QueueFull, Count
    };
    enum class DecodedKind : std::uint8_t { None, Real, PcmLoss, OpusPlc, Count };
    struct ReceiveEvent {
        PacketIdentity packet{};
        std::uint64_t socketMicros{0};
        std::uint64_t processingMicros{0};
        std::uint64_t decisionMicros{0};
        std::uint64_t socketRoomFrame{0};
        std::uint64_t effectiveFrame{0};
        std::uint64_t sourceEndpoint{0};
        std::uint64_t wireHash{0};
        std::uint64_t payloadHash{0};
        std::uint64_t horizonFrame{0};
        QueueSpan queue{};
        PcmMetrics pcm{};
        std::int64_t dueInFrames{0};
        std::uint32_t targetDelayFrames{0};
        std::uint32_t packetFrames{0};
        std::uint32_t decodedFrames{0};
        std::uint32_t sourceOffsetFrames{0};
        std::uint32_t correctedFrames{0};
        std::uint32_t lateSkipFrames{0};
        std::uint32_t queueFillFrames{0};
        ReceiveStage stage{ReceiveStage::Socket};
        ReceiveReason reason{ReceiveReason::Received};
        DecodedKind decodedKind{DecodedKind::None};
        bool viaRelay{false};
        bool queueAccepted{false};
    };
    struct RenderEvent {
        GenerationId generation{0};
        std::uint32_t participantKey{0};
        QueueSpan queue{};
        std::uint64_t outputTimelineFrame{0};
        PcmMetrics before{};
        PcmMetrics after{};
        std::uint32_t frames{0};
        std::uint32_t tagZeroFrames{0};
        std::uint32_t tagOneFrames{0}; // real or existing Opus PLC; join admissions to distinguish
        std::uint32_t starvationFrames{0};
        std::uint32_t missingBeforeFrames{0};
        std::uint32_t missingAfterFrames{0};
        std::uint32_t recoveryFrames{0};
        float gain{1.0F};
        bool muted{false};
        bool reset{false};
    };
    struct Status {
        std::uint64_t captureEpoch{0};
        std::uint64_t senderEvents{0};
        std::uint64_t receiveEvents{0};
        std::uint64_t renderEvents{0};
        std::uint64_t senderOverflow{0};
        std::uint64_t receiveOverflow{0};
        std::uint64_t renderOverflow{0};
        bool prepared{false};
        bool active{false};
        [[nodiscard]] bool complete() const noexcept {
            return prepared && !active && captureEpoch != 0 && senderOverflow == 0 &&
                   receiveOverflow == 0 && renderOverflow == 0;
        }
    };

    void prepare();
    void prepare(Capacities capacities);
    void start();
    void stop() noexcept;
    [[nodiscard]] bool active() const noexcept;
    [[nodiscard]] std::uint64_t captureToken() const noexcept;
    [[nodiscard]] Status status() const noexcept;
    // Each append method has exactly one producer. No allocation, wait, mutex or file I/O.
    // Engines capture a token before assembling metadata and pass it here, so a delayed event
    // from the preceding take cannot enter a rearmed capture. Zero samples the current epoch.
    [[nodiscard]] bool appendSender(const SenderEvent& event, std::uint64_t captureToken = 0) noexcept;
    [[nodiscard]] bool appendReceive(const ReceiveEvent& event, std::uint64_t captureToken = 0) noexcept;
    [[nodiscard]] bool appendRender(const RenderEvent& event, std::uint64_t captureToken = 0) noexcept;
    [[nodiscard]] std::span<const SenderEvent> senderEvents() const;
    [[nodiscard]] std::span<const ReceiveEvent> receiveEvents() const;
    [[nodiscard]] std::span<const RenderEvent> renderEvents() const;
    // Writes prefix.sender.csv, prefix.receive.csv, prefix.render.csv, prefix.status.csv.
    void exportCsv(const std::string& pathPrefix) const;
    [[nodiscard]] static std::uint64_t hashBytes(std::span<const std::byte> bytes) noexcept;
    [[nodiscard]] static PcmMetrics measurePcm(std::span<const float> samples,
                                               std::uint32_t channels = 1,
                                               float gain = 1.0F) noexcept;

  private:
    template <typename Event> struct Lane {
        std::vector<Event> events;
        std::atomic<std::uint64_t> count{0};
        std::atomic<std::uint64_t> overflow{0};
    };
    template <typename Event>
    bool append(Lane<Event>& lane, const Event& event, std::uint64_t captureToken) noexcept;
    void requireStopped() const;
    Lane<SenderEvent> sender_;
    Lane<ReceiveEvent> receive_;
    Lane<RenderEvent> render_;
    std::atomic<std::uint64_t> lifecycleEpoch_{0}; // odd is recording; monotonically avoids ABA
    std::atomic<std::uint32_t> producers_{0};
    bool prepared_{false}; // control-owned; unchanged while producers are enabled
    bool captured_{false}; // preparation alone cannot claim completed evidence
};
