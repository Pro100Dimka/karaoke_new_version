#pragma once

#include "common/Types.hpp"

#include <array>
#include <atomic>
#include <cstddef>
#include <cstdint>
#include <vector>

struct TraceEvent {
    MonotonicTicks timestamp{0};
    SessionFrame sessionFrame{0};
    GenerationId generationId{0};
    std::uint32_t type{0};
    std::uint32_t payload{0};
};

struct TraceSnapshot {
    std::vector<TraceEvent> events;
    std::uint64_t overwritten{0};
    std::uint64_t dropped{0};
};

class TraceBuffer {
  public:
    static constexpr std::size_t Capacity = 32;
    void push(TraceEvent event) noexcept;
    [[nodiscard]] TraceSnapshot snapshot() const;
    [[nodiscard]] std::size_t size() const noexcept;

  private:
    std::array<TraceEvent, Capacity> events_{};
    mutable std::atomic_flag gate_ = ATOMIC_FLAG_INIT;
    std::atomic<std::uint64_t> sequence_{0};
    std::atomic<std::uint64_t> overwritten_{0};
    std::atomic<std::uint64_t> dropped_{0};
};
