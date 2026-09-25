#pragma once

#include <atomic>
#include <cstdint>

struct ClockObservation {
    std::int64_t capturePosition{0};
    std::int64_t renderPosition{0};
    std::int64_t captureTimestamp{0};
    std::int64_t renderTimestamp{0};
    bool valid{true};
};

class ClockSynchronizer {
  public:
    void prepare(std::uint32_t captureSampleRateHz, std::uint32_t renderSampleRateHz) noexcept;
    void reset() noexcept;
    void observe(const ClockObservation& observation) noexcept;

    [[nodiscard]] double driftPpm() const noexcept {
        return driftPpm_.load(std::memory_order_relaxed);
    }
    [[nodiscard]] double correctionRatio() const noexcept {
        return correctionRatio_.load(std::memory_order_relaxed);
    }
    [[nodiscard]] std::uint64_t rejectedObservations() const noexcept {
        return rejected_.load(std::memory_order_relaxed);
    }

  private:
    std::uint32_t captureSampleRateHz_{0};
    std::uint32_t renderSampleRateHz_{0};
    bool initialized_{false};
    ClockObservation first_{};
    ClockObservation last_{};
    double filteredRatio_{1.0};
    std::atomic<double> driftPpm_{0.0};
    std::atomic<double> correctionRatio_{1.0};
    std::atomic<std::uint64_t> rejected_{0};
};
