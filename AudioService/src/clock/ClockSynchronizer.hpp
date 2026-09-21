#pragma once

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
        return driftPpm_;
    }
    [[nodiscard]] double correctionRatio() const noexcept {
        return correctionRatio_;
    }
    [[nodiscard]] std::uint64_t rejectedObservations() const noexcept {
        return rejected_;
    }

  private:
    std::uint32_t captureSampleRateHz_{48000};
    std::uint32_t renderSampleRateHz_{48000};
    bool initialized_{false};
    ClockObservation first_{};
    ClockObservation last_{};
    double filteredRatio_{1.0};
    double driftPpm_{0.0};
    double correctionRatio_{1.0};
    std::uint64_t rejected_{0};
};
