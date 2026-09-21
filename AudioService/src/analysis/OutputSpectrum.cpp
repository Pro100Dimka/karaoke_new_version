#include "analysis/OutputSpectrum.hpp"

#include <algorithm>
#include <cmath>
#include <numbers>

namespace {
constexpr float LowestBandHz = 40.0F;
constexpr float HighestBandHz = 12000.0F;
constexpr float FloorDb = -60.0F;
constexpr float MinimumAmplitude = 1.0e-6F;
constexpr float SmoothingAttack = 0.6F;
constexpr float SmoothingRelease = 0.15F;
} // namespace

void OutputSpectrum::prepare(std::uint32_t sampleRateHz) noexcept {
    const auto rate = static_cast<float>(std::max(1U, sampleRateHz));
    const auto ratio =
        std::pow(HighestBandHz / LowestBandHz, 1.0F / static_cast<float>(BandCount - 1U));
    for (std::size_t band = 0; band < BandCount; ++band) {
        const auto frequency = LowestBandHz * std::pow(ratio, static_cast<float>(band));
        coefficient_[band] = 2.0F * std::cos(2.0F * std::numbers::pi_v<float> * frequency / rate);
        levels_[band].store(0.0F, std::memory_order_relaxed);
    }
    previous1_.fill(0.0F);
    previous2_.fill(0.0F);
    smoothed_.fill(0.0F);
    framesInWindow_ = 0;
}

void OutputSpectrum::observe(std::span<const float> interleaved, std::uint32_t channels) noexcept {
    if (channels == 0)
        return;
    const auto scale = 1.0F / static_cast<float>(channels);
    for (std::size_t frame = 0; frame + channels <= interleaved.size(); frame += channels) {
        float mono = 0.0F;
        for (std::uint32_t channel = 0; channel < channels; ++channel)
            mono += interleaved[frame + channel];
        mono *= scale;
        for (std::size_t band = 0; band < BandCount; ++band) {
            const auto current = mono + coefficient_[band] * previous1_[band] - previous2_[band];
            previous2_[band] = previous1_[band];
            previous1_[band] = current;
        }
        if (++framesInWindow_ < WindowFrames)
            continue;
        for (std::size_t band = 0; band < BandCount; ++band) {
            const auto power = previous1_[band] * previous1_[band] +
                               previous2_[band] * previous2_[band] -
                               coefficient_[band] * previous1_[band] * previous2_[band];
            const auto amplitude =
                2.0F * std::sqrt(std::max(0.0F, power)) / static_cast<float>(WindowFrames);
            const auto decibels = 20.0F * std::log10(std::max(amplitude, MinimumAmplitude));
            const auto level = std::clamp((decibels - FloorDb) / -FloorDb, 0.0F, 1.0F);
            const auto smoothing = level > smoothed_[band] ? SmoothingAttack : SmoothingRelease;
            smoothed_[band] += (level - smoothed_[band]) * smoothing;
            levels_[band].store(smoothed_[band], std::memory_order_relaxed);
        }
        previous1_.fill(0.0F);
        previous2_.fill(0.0F);
        framesInWindow_ = 0;
    }
}

OutputSpectrum::Levels OutputSpectrum::snapshot() const noexcept {
    Levels result{};
    for (std::size_t band = 0; band < BandCount; ++band)
        result[band] = levels_[band].load(std::memory_order_relaxed);
    return result;
}
