#pragma once

#include <atomic>
#include <cstdint>
#include <mutex>

class RealtimeScope {
  public:
    RealtimeScope() noexcept;
    ~RealtimeScope() noexcept;
    RealtimeScope(const RealtimeScope&) = delete;
    RealtimeScope& operator=(const RealtimeScope&) = delete;
    [[nodiscard]] static bool active() noexcept;
};

struct RealtimeViolationSnapshot {
    std::uint64_t allocations{0};
    std::uint64_t deallocations{0};
    std::uint64_t blockingCalls{0};
    std::uint64_t diskIoCalls{0};
    std::uint64_t networkIoCalls{0};
    std::uint64_t ipcCalls{0};
};

class RealtimeInstrumentation {
  public:
    static void reportAllocation() noexcept;
    static void reportDeallocation() noexcept;
    static void reportBlockingCall() noexcept;
    static void reportDiskIo() noexcept;
    static void reportNetworkIo() noexcept;
    static void reportIpc() noexcept;
    [[nodiscard]] static RealtimeViolationSnapshot snapshot() noexcept;
    static void reset() noexcept;
};

class RealtimeMutex {
  public:
    void lock() {
        RealtimeInstrumentation::reportBlockingCall();
        mutex_.lock();
    }

    [[nodiscard]] bool try_lock() {
        return mutex_.try_lock();
    }

    void unlock() noexcept {
        mutex_.unlock();
    }

  private:
    std::mutex mutex_;
};
