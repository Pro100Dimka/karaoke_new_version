#pragma once

#include <array>
#include <atomic>
#include <cstddef>
#include <cstdint>
#include <span>

/**
 * Band levels of the final output mix for visual feedback. A Goertzel resonator per band keeps the realtime cost
 * fixed and allocation-free; levels are published as atomics for the control thread.
 * Threading: prepare() and observe() belong to the render thread, snapshot() may be called from any thread.
 */
class OutputSpectrum {
  public:
    static constexpr std::size_t BandCount = 18;
    using Levels = std::array<float, BandCount>;

    void prepare(std::uint32_t sampleRateHz) noexcept;
    /// Interleaved samples; channels are averaged to mono.
    void observe(std::span<const float> interleaved, std::uint32_t channels) noexcept;
    [[nodiscard]] Levels snapshot() const noexcept;

  private:
    static constexpr std::uint32_t WindowFrames = 1024;

    std::array<float, BandCount> coefficient_{};
    std::array<float, BandCount> previous1_{};
    std::array<float, BandCount> previous2_{};
    std::array<float, BandCount> smoothed_{};
    std::uint32_t framesInWindow_{0};
    std::array<std::atomic<float>, BandCount> levels_{};
};
