#pragma once

#include <cstdint>
#include <vector>

struct NetworkAudioPacket {
    std::uint32_t sequence{0};
    std::uint64_t timestampFrame{0};
    std::uint32_t channels{0};
    std::vector<float> samples;
};

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
    [[nodiscard]] bool pop(NetworkAudioPacket& packet);
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
