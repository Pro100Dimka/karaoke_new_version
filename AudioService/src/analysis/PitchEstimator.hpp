#pragma once

#include <cstdint>
#include <span>
#include <vector>

/** Worker-owned NSDF pitch analysis. Prepared storage is reused without allocation per window. */
class PitchEstimator {
  public:
    void prepare(std::uint32_t frames, std::uint32_t sampleRateHz);
    [[nodiscard]] float estimate(std::span<const float> samples, std::uint32_t channels,
                                 float& confidence) noexcept;

  private:
    std::uint32_t sampleRateHz_{0};
    std::vector<double> centred_;
    std::vector<double> energyPrefix_;
    std::vector<double> correlations_;
    std::vector<std::uint32_t> peaks_;
};
