#pragma once

#include "common/Types.hpp"

#include <array>
#include <cstdint>
#include <span>
#include <vector>

class RateTransposeProcessor {
  public:
    void prepare(std::uint32_t inputSampleRateHz, std::uint32_t outputSampleRateHz,
                 std::uint32_t channels, std::uint32_t maxInputFrames);
    void reset() noexcept;
    void setRate(float rate) noexcept;
    void setTranspose(float semitones) noexcept;
    // Input/output spans must not overlap. An empty input drains interpolation and the pitch tail.
    [[nodiscard]] std::uint32_t process(std::span<const float> input, std::uint32_t inputFrames,
                                        std::span<float> output) noexcept;
    [[nodiscard]] std::uint32_t maximumOutputFrames() const noexcept {
        return maximumOutputFrames_;
    }
    [[nodiscard]] std::uint32_t latencyFrames() const noexcept;

  private:
    float delayedSample(std::uint32_t channel, float delayFrames) const noexcept;
    void pushPitchSample(std::uint32_t channel, float sample) noexcept;

    std::uint32_t inputSampleRateHz_{0};
    std::uint32_t outputSampleRateHz_{0};
    std::uint32_t channels_{0};
    std::uint32_t maxInputFrames_{0};
    float rate_{1.0F};
    float transpose_{0.0F};
    // Every binary32 playback rate in [0.5, 1.5] is exact at this scale.
    static constexpr std::int64_t RateScale = 1LL << 24;
    std::int64_t resamplePhase_{0};
    std::int64_t phaseDenominator_{1};
    std::array<float, MaxAudioChannels> previousFrame_{};
    bool hasPreviousFrame_{false};
    std::uint32_t maximumOutputFrames_{0};
    std::vector<float> pitchDelay_;
    std::uint32_t pitchWindowFrames_{1024};
    std::uint32_t pitchWriteFrame_{0};
    double pitchPhase_{0.0};
};
