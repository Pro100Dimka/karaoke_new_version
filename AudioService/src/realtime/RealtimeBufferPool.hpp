#pragma once
#include <cstdint>
#include <span>
#include <vector>

class RealtimeBufferPool {
  public:
    void prepare(std::uint32_t bufferCount, std::uint32_t maxFrames, std::uint32_t channels);
    [[nodiscard]] std::span<float> buffer(std::uint32_t index, std::uint32_t frames) noexcept;
    [[nodiscard]] std::uint64_t bytes() const noexcept {
        return storage_.size() * sizeof(float);
    }
    [[nodiscard]] std::uint32_t maxFrames() const noexcept {
        return maxFrames_;
    }
    [[nodiscard]] std::uint32_t channels() const noexcept {
        return channels_;
    }

  private:
    std::vector<float> storage_;
    std::uint32_t bufferCount_{0};
    std::uint32_t maxFrames_{0};
    std::uint32_t channels_{0};
};
