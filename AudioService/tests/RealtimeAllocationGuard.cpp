#include "realtime/RealtimeInstrumentation.hpp"

#include <cstdlib>
#include <new>

void* operator new(std::size_t size) {
    RealtimeInstrumentation::reportAllocation();
    if (auto* memory = std::malloc(size))
        return memory;
    throw std::bad_alloc{};
}

void* operator new[](std::size_t size) {
    RealtimeInstrumentation::reportAllocation();
    if (auto* memory = std::malloc(size))
        return memory;
    throw std::bad_alloc{};
}

void operator delete(void* memory) noexcept {
    RealtimeInstrumentation::reportDeallocation();
    std::free(memory);
}

void operator delete[](void* memory) noexcept {
    RealtimeInstrumentation::reportDeallocation();
    std::free(memory);
}

void operator delete(void* memory, std::size_t) noexcept {
    RealtimeInstrumentation::reportDeallocation();
    std::free(memory);
}

void operator delete[](void* memory, std::size_t) noexcept {
    RealtimeInstrumentation::reportDeallocation();
    std::free(memory);
}
