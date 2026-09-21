#pragma once

#include <atomic>
#include <cstdint>
#include <span>

struct SignalMetricsSnapshot {
    float peak{0.0F};
    float rms{0.0F};
    float noiseFloor{0.0F};
    bool signalPresent{false};
    bool clipping{false};
    std::uint64_t clipCount{0};
};

class SignalMetrics {
  public:
    void observe(std::span<const float> samples) noexcept;
    [[nodiscard]] SignalMetricsSnapshot snapshot() const noexcept;

  private:
    std::atomic<float> peak_{0.0F};
    std::atomic<float> rms_{0.0F};
    std::atomic<float> noiseFloor_{0.0F};
    std::atomic<bool> signalPresent_{false};
    std::atomic<bool> clipping_{false};
    std::atomic<std::uint64_t> clipCount_{0};
};
