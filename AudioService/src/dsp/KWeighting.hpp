#pragma once

#include <algorithm>
#include <array>
#include <cmath>
#include <cstdint>

/**
 * ITU-R BS.1770 "K" frequency weighting (the filter behind LUFS): a high shelf for the head's
 * effect and a high pass for the ear's low-frequency insensitivity, derived for any sample rate.
 * Music and voices spread their energy differently across frequencies; comparing their raw RMS
 * misjudges how loud each sounds, comparing K-weighted power does not.
 */
class KWeighting {
  public:
    void prepare(std::uint32_t sampleRateHz) noexcept {
        constexpr double Pi = 3.14159265358979323846;
        const auto rate = static_cast<double>(std::max(1U, sampleRateHz));
        {
            constexpr double GainDb = 3.999843853973347, Q = 0.7071752369554196;
            constexpr double CenterHz = 1681.974450955533;
            const auto k = std::tan(Pi * CenterHz / rate);
            const auto vh = std::pow(10.0, GainDb / 20.0);
            const auto vb = std::pow(vh, 0.4996667741545416);
            const auto a0 = 1.0 + k / Q + k * k;
            shelf_ = {(vh + vb * k / Q + k * k) / a0, 2.0 * (k * k - vh) / a0,
                      (vh - vb * k / Q + k * k) / a0, 2.0 * (k * k - 1.0) / a0,
                      (1.0 - k / Q + k * k) / a0};
        }
        {
            constexpr double Q = 0.5003270373238773, CornerHz = 38.13547087602444;
            const auto k = std::tan(Pi * CornerHz / rate);
            const auto a0 = 1.0 + k / Q + k * k;
            highPass_ = {1.0, -2.0, 1.0, 2.0 * (k * k - 1.0) / a0, (1.0 - k / Q + k * k) / a0};
        }
        reset();
    }
    void reset() noexcept {
        shelfState_ = highPassState_ = {};
    }
    [[nodiscard]] double process(double sample) noexcept {
        return run(highPass_, highPassState_, run(shelf_, shelfState_, sample));
    }

  private:
    struct Biquad {
        double b0{1.0}, b1{0.0}, b2{0.0}, a1{0.0}, a2{0.0};
    };
    // Transposed direct form II.
    [[nodiscard]] static double run(const Biquad& filter, std::array<double, 2>& state,
                                    double input) noexcept {
        const auto output = filter.b0 * input + state[0];
        state[0] = filter.b1 * input - filter.a1 * output + state[1];
        state[1] = filter.b2 * input - filter.a2 * output;
        return output;
    }
    Biquad shelf_{}, highPass_{};
    std::array<double, 2> shelfState_{}, highPassState_{};
};
