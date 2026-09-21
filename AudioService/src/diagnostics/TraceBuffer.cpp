#include "diagnostics/TraceBuffer.hpp"

#include <algorithm>
#include <thread>

void TraceBuffer::push(TraceEvent event) noexcept {
    if (gate_.test_and_set(std::memory_order_acquire)) {
        dropped_.fetch_add(1, std::memory_order_relaxed);
        return;
    }
    const auto sequence = sequence_.load(std::memory_order_relaxed);
    events_[static_cast<std::size_t>(sequence % Capacity)] = event;
    sequence_.store(sequence + 1U, std::memory_order_release);
    if (sequence >= Capacity)
        overwritten_.fetch_add(1, std::memory_order_relaxed);
    gate_.clear(std::memory_order_release);
}

TraceSnapshot TraceBuffer::snapshot() const {
    while (gate_.test_and_set(std::memory_order_acquire))
        std::this_thread::yield();
    TraceSnapshot out;
    const auto end = sequence_.load(std::memory_order_acquire);
    const auto count = std::min<std::uint64_t>(end, Capacity);
    const auto begin = end - count;
    out.events.reserve(static_cast<std::size_t>(count));
    for (auto sequence = begin; sequence < end; ++sequence)
        out.events.push_back(events_[static_cast<std::size_t>(sequence % Capacity)]);
    out.overwritten = overwritten_.load(std::memory_order_relaxed);
    out.dropped = dropped_.load(std::memory_order_relaxed);
    gate_.clear(std::memory_order_release);
    return out;
}

std::size_t TraceBuffer::size() const noexcept {
    return static_cast<std::size_t>(std::min<std::uint64_t>(
        sequence_.load(std::memory_order_acquire), static_cast<std::uint64_t>(Capacity)));
}
