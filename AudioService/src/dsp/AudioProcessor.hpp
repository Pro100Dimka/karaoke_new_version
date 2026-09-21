#pragma once

#include <cstdint>
#include <span>

class IAudioProcessor {
  public:
    virtual ~IAudioProcessor() = default;
    virtual void prepare(std::uint32_t sampleRateHz, std::uint32_t maxFrames,
                         std::uint32_t channels) = 0;
    virtual void process(std::span<float> interleaved, std::uint32_t frames) noexcept = 0;
    virtual void reset() noexcept = 0;
    [[nodiscard]] virtual std::uint32_t latencyFrames() const noexcept = 0;
};
