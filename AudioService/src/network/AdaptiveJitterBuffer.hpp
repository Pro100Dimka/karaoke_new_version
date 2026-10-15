#pragma once

#include "network/NetworkPacket.hpp"

#include <cstddef>
#include <cstdint>
#include <optional>
#include <vector>

struct NetworkAudioPacket {
    std::uint32_t sequence{0};
    std::uint64_t timestampFrame{0};
    std::uint32_t channels{0};
    std::uint32_t frames{0};        // samples per channel this payload decodes to
    std::vector<std::byte> payload; // coded bytes, undecoded
    VoiceCodec codec{VoiceCodec::Opus};
    std::uint64_t socketReceiveMicros{0};
    std::uint64_t processingMicros{0};
    // Diagnostic capture only: both positions use the receiver's room-timeline clock.
    std::uint64_t socketTimelineFrame{0};
    std::uint64_t receiveTimelineFrame{0};
    std::uint32_t serverIngressFrames{0};
    std::uint32_t serverCollectionFrames{0};
    bool viaRelay{false}; // retain the winning route through reorder and decode
    std::uint64_t sourceIdentity{0};
};

// Empty: nothing ready to play yet. Delivered: the next packet in sequence, decode it normally.
// Lost: the next expected sequence never arrived; ask the decoder to conceal it instead of
// decoding.
enum class JitterPopOutcome { Empty, Delivered, Lost };

struct JitterBufferSnapshot {
    std::uint32_t minimumTargetPackets{2};
    std::uint32_t currentTargetPackets{2};
    std::uint32_t maximumTargetPackets{12};
    std::uint32_t fillPackets{0};
    std::uint64_t lostPackets{0};
    std::uint64_t latePackets{0};
    std::uint64_t duplicatePackets{0};
    std::uint64_t overflowPackets{0};
};

class AdaptiveJitterBuffer {
  public:
    void configure(std::uint32_t minimumTargetPackets, std::uint32_t maximumTargetPackets);
    void reset() noexcept;
    void push(NetworkAudioPacket packet);
    // Shared timestamps and the optional horizon use protocol frames. A missing packet is
    // retained until its presentation position; callers without a horizon keep count-based reorder.
    [[nodiscard]] JitterPopOutcome
    pop(NetworkAudioPacket& packet,
        std::optional<std::uint64_t> presentationHorizonFrame = std::nullopt,
        std::uint32_t playoutDelayFrames = 0, bool allowSequenceLoss = true);
    [[nodiscard]] JitterBufferSnapshot snapshot() const noexcept;

  private:
    void updateTarget(bool late) noexcept;

    std::vector<NetworkAudioPacket> packets_;
    std::uint32_t expectedSequence_{0};
    bool started_{false};
    std::uint32_t minTarget_{2};
    std::uint32_t target_{2};
    std::uint32_t maxTarget_{12};
    std::uint64_t lost_{0};
    std::uint64_t late_{0};
    std::uint64_t duplicates_{0};
    std::uint64_t overflows_{0};
    std::uint32_t stablePops_{0};
};
