#pragma once

#include "common/Types.hpp"

#include <atomic>
#include <cstddef>
#include <cstdint>
#include <span>
#include <vector>

#ifdef _MSC_VER
#pragma warning(push)
#pragma warning(disable : 4324)
#endif

class PcmRingBuffer {
  public:
    PcmRingBuffer() = default;
    PcmRingBuffer(std::uint32_t capacityFrames, std::uint32_t channels);

    void prepare(std::uint32_t capacityFrames, std::uint32_t channels);
    void clear() noexcept;
    [[nodiscard]] bool push(std::span<const float> interleaved, std::uint32_t frames) noexcept;
    [[nodiscard]] std::uint32_t pop(std::span<float> output, std::uint32_t frames) noexcept;
    [[nodiscard]] std::uint32_t peek(std::span<float> output, std::uint32_t frames) const noexcept;
    std::uint32_t discard(std::uint32_t frames) noexcept;
    [[nodiscard]] std::uint32_t availableFrames() const noexcept;
    [[nodiscard]] std::uint32_t freeFrames() const noexcept;
    [[nodiscard]] std::uint32_t capacityFrames() const noexcept {
        return capacityFrames_;
    }
    [[nodiscard]] std::uint32_t channels() const noexcept {
        return channels_;
    }
    [[nodiscard]] std::uint64_t epoch() const noexcept {
        return epoch_.load(std::memory_order_acquire);
    }

  private:
    std::vector<float> data_;
    std::uint32_t capacityFrames_{0};
    std::uint32_t channels_{0};
    alignas(64) std::atomic<std::uint64_t> writeFrame_{0};
    alignas(64) std::atomic<std::uint64_t> readFrame_{0};
    std::atomic<std::uint64_t> epoch_{0};
};

#ifdef _MSC_VER
#pragma warning(pop)
#endif

class GenerationPcmRingBuffer {
  public:
    void prepare(std::uint32_t capacityFrames, std::uint32_t channels);
    void reset(SourceGenerationId generation) noexcept;
    [[nodiscard]] bool push(SourceGenerationId generation, std::span<const float> samples,
                            std::uint32_t frames) noexcept;
    [[nodiscard]] std::uint32_t pop(std::span<float> output, std::uint32_t frames) noexcept;
    [[nodiscard]] std::uint32_t peek(std::span<float> output, std::uint32_t frames) const noexcept;
    std::uint32_t discard(std::uint32_t frames) noexcept;
    [[nodiscard]] std::uint32_t availableFrames() const noexcept {
        return ring_.availableFrames();
    }
    [[nodiscard]] std::uint32_t capacityFrames() const noexcept {
        return ring_.capacityFrames();
    }
    [[nodiscard]] SourceGenerationId generation() const noexcept {
        return generation_.load(std::memory_order_acquire);
    }

  private:
    PcmRingBuffer ring_;
    std::atomic<SourceGenerationId> generation_{SourceGenerationId{0}};
};
