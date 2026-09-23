#pragma once

#ifdef _WIN32
#ifndef WIN32_LEAN_AND_MEAN
#define WIN32_LEAN_AND_MEAN
#endif
#include <windows.h>

#include <atomic>
#include <deque>
#include <functional>
#include <future>
#include <mutex>
#include <thread>

class AsioComApartment {
  public:
    AsioComApartment() = default;
    ~AsioComApartment();
    AsioComApartment(const AsioComApartment&) = delete;
    AsioComApartment& operator=(const AsioComApartment&) = delete;

    [[nodiscard]] bool start();
    void invoke(std::function<void()> operation);
    [[nodiscard]] bool isCurrentThreadOwner() const noexcept;
    void reset() noexcept;

  private:
    struct Task {
        std::function<void()> operation;
        std::promise<void> completion;
    };

    void run(std::promise<bool> ready) noexcept;
    void drainTasks() noexcept;

    std::thread thread_;
    HANDLE wake_{nullptr};
    std::mutex mutex_;
    std::deque<Task> tasks_;
    std::atomic<DWORD> ownerThreadId_{0};
    std::atomic<bool> stopping_{false};
};
#endif
