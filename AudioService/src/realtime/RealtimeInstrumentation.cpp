#include "realtime/RealtimeInstrumentation.hpp"

namespace {
thread_local std::uint32_t realtimeDepth = 0;
std::atomic<std::uint64_t> allocations{0};
std::atomic<std::uint64_t> deallocations{0};
std::atomic<std::uint64_t> blockingCalls{0};
std::atomic<std::uint64_t> diskIoCalls{0};
std::atomic<std::uint64_t> networkIoCalls{0};
std::atomic<std::uint64_t> ipcCalls{0};

void incrementIfRealtime(std::atomic<std::uint64_t>& counter) noexcept {
    if (RealtimeScope::active()) {
        counter.fetch_add(1, std::memory_order_relaxed);
    }
}
} // namespace

RealtimeScope::RealtimeScope() noexcept {
    ++realtimeDepth;
}
RealtimeScope::~RealtimeScope() noexcept {
    --realtimeDepth;
}
bool RealtimeScope::active() noexcept {
    return realtimeDepth != 0;
}

void RealtimeInstrumentation::reportAllocation() noexcept {
    incrementIfRealtime(allocations);
}
void RealtimeInstrumentation::reportDeallocation() noexcept {
    incrementIfRealtime(deallocations);
}
void RealtimeInstrumentation::reportBlockingCall() noexcept {
    incrementIfRealtime(blockingCalls);
}
void RealtimeInstrumentation::reportDiskIo() noexcept {
    incrementIfRealtime(diskIoCalls);
}
void RealtimeInstrumentation::reportNetworkIo() noexcept {
    incrementIfRealtime(networkIoCalls);
}
void RealtimeInstrumentation::reportIpc() noexcept {
    incrementIfRealtime(ipcCalls);
}

RealtimeViolationSnapshot RealtimeInstrumentation::snapshot() noexcept {
    return {
        allocations.load(std::memory_order_relaxed),
        deallocations.load(std::memory_order_relaxed),
        blockingCalls.load(std::memory_order_relaxed),
        diskIoCalls.load(std::memory_order_relaxed),
        networkIoCalls.load(std::memory_order_relaxed),
        ipcCalls.load(std::memory_order_relaxed),
    };
}

void RealtimeInstrumentation::reset() noexcept {
    allocations.store(0, std::memory_order_relaxed);
    deallocations.store(0, std::memory_order_relaxed);
    blockingCalls.store(0, std::memory_order_relaxed);
    diskIoCalls.store(0, std::memory_order_relaxed);
    networkIoCalls.store(0, std::memory_order_relaxed);
    ipcCalls.store(0, std::memory_order_relaxed);
}
