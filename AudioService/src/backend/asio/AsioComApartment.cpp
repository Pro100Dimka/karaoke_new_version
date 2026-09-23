#ifdef _WIN32
#include "backend/asio/AsioComApartment.hpp"

#include <objbase.h>
#include <stdexcept>
#include <utility>

AsioComApartment::~AsioComApartment() {
    reset();
}

bool AsioComApartment::start() {
    if (thread_.joinable())
        return true;
    wake_ = CreateEventW(nullptr, FALSE, FALSE, nullptr);
    if (!wake_)
        return false;
    stopping_.store(false, std::memory_order_release);
    std::promise<bool> ready;
    auto result = ready.get_future();
    thread_ = std::thread(&AsioComApartment::run, this, std::move(ready));
    if (result.get())
        return true;
    thread_.join();
    CloseHandle(wake_);
    wake_ = nullptr;
    return false;
}

void AsioComApartment::invoke(std::function<void()> operation) {
    if (!thread_.joinable())
        throw std::logic_error("ASIO COM apartment is not running");
    if (isCurrentThreadOwner()) {
        operation();
        return;
    }
    Task task{std::move(operation), {}};
    auto completion = task.completion.get_future();
    {
        std::lock_guard lock(mutex_);
        tasks_.push_back(std::move(task));
    }
    SetEvent(wake_);
    completion.get();
}

bool AsioComApartment::isCurrentThreadOwner() const noexcept {
    const auto owner = ownerThreadId_.load(std::memory_order_acquire);
    return owner != 0 && owner == GetCurrentThreadId();
}

void AsioComApartment::reset() noexcept {
    if (!thread_.joinable())
        return;
    stopping_.store(true, std::memory_order_release);
    SetEvent(wake_);
    thread_.join();
    CloseHandle(wake_);
    wake_ = nullptr;
    ownerThreadId_.store(0, std::memory_order_release);
}

void AsioComApartment::run(std::promise<bool> ready) noexcept {
    const auto result = CoInitializeEx(nullptr, COINIT_APARTMENTTHREADED);
    if (FAILED(result)) {
        ready.set_value(false);
        return;
    }
    ownerThreadId_.store(GetCurrentThreadId(), std::memory_order_release);
    ready.set_value(true);
    while (!stopping_.load(std::memory_order_acquire)) {
        const auto wait = MsgWaitForMultipleObjects(1, &wake_, FALSE, INFINITE, QS_ALLINPUT);
        if (wait == WAIT_OBJECT_0)
            drainTasks();
        else if (wait == WAIT_OBJECT_0 + 1U) {
            MSG message{};
            while (PeekMessageW(&message, nullptr, 0, 0, PM_REMOVE)) {
                TranslateMessage(&message);
                DispatchMessageW(&message);
            }
        }
    }
    drainTasks();
    ownerThreadId_.store(0, std::memory_order_release);
    CoUninitialize();
}

void AsioComApartment::drainTasks() noexcept {
    for (;;) {
        Task task;
        {
            std::lock_guard lock(mutex_);
            if (tasks_.empty())
                return;
            task = std::move(tasks_.front());
            tasks_.pop_front();
        }
        try {
            task.operation();
            task.completion.set_value();
        } catch (...) {
            task.completion.set_exception(std::current_exception());
        }
    }
}
#endif
