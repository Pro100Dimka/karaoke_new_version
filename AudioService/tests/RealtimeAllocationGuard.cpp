#include "realtime/RealtimeInstrumentation.hpp"

#include <cstdlib>
#include <new>

namespace {
thread_local std::size_t failingAllocationSize = 0;
thread_local bool failingNextAllocation = false;
void checkFailure(std::size_t size) {
    if (failingNextAllocation || (size == failingAllocationSize && size != 0)) {
        failingNextAllocation = false;
        failingAllocationSize = 0;
        throw std::bad_alloc{};
    }
}
} // namespace
namespace Tests {
void failNextAllocation() {
    failingNextAllocation = true;
}
void failNextAllocationOfSize(std::size_t size) {
    failingAllocationSize = size;
}
} // namespace Tests

void* operator new(std::size_t size) {
    checkFailure(size);
    RealtimeInstrumentation::reportAllocation();
    if (auto* memory = std::malloc(size))
        return memory;
    throw std::bad_alloc{};
}

void* operator new[](std::size_t size) {
    checkFailure(size);
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
