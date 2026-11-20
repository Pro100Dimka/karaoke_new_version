#include "analysis/PitchEstimator.hpp"

#include <algorithm>
#include <array>
#include <cmath>

void PitchEstimator::prepare(std::uint32_t frames, std::uint32_t sampleRateHz) {
    sampleRateHz_ = sampleRateHz;
    centred_.assign(frames, 0.0);
    energyPrefix_.assign(static_cast<std::size_t>(frames) + 1U, 0.0);
    const auto maximumLag = std::min(frames / 2U, sampleRateHz / 60U);
    correlations_.resize(static_cast<std::size_t>(maximumLag) + 2U);
    peaks_.clear();
    peaks_.reserve(maximumLag);
}

float PitchEstimator::estimate(std::span<const float> samples, std::uint32_t channels,
                               float& confidence) noexcept {
    const auto frames = static_cast<std::uint32_t>(centred_.size());
    const auto sampleRateHz = sampleRateHz_;
    confidence = 0.0F;
    if (frames < 4 || channels == 0 || sampleRateHz == 0 ||
        samples.size() < static_cast<std::size_t>(frames) * channels)
        return 0.0F;
    const auto minimumLag = std::max(1U, sampleRateHz / 1200U);
    const auto maximumLag = std::min(frames / 2U, sampleRateHz / 60U);
    if (minimumLag >= maximumLag)
        return 0.0F;
    double mean = 0.0;
    for (std::uint32_t frame = 0; frame < frames; ++frame) {
        mean += samples[static_cast<std::size_t>(frame) * channels];
    }
    mean /= frames;
    // A centred moving average removes out-of-range breath/hiss before correlation, without
    // shifting the capture-window timestamp. The first zero is about 3 kHz at every device rate.
    const auto radius = std::max(1U, sampleRateHz / 6000U);
    const auto sampleAt = [&](std::int64_t frame) {
        const auto bounded = std::clamp<std::int64_t>(frame, 0, frames - 1U);
        return samples[static_cast<std::size_t>(bounded) * channels];
    };
    double runningSum = 0;
    for (auto frame = -static_cast<std::int64_t>(radius); frame <= radius; ++frame)
        runningSum += sampleAt(frame);
    for (std::uint32_t frame = 0; frame < frames; ++frame) {
        centred_[frame] = runningSum / (2U * radius + 1U) - mean;
        energyPrefix_[frame + 1U] = energyPrefix_[frame] + centred_[frame] * centred_[frame];
        runningSum += sampleAt(static_cast<std::int64_t>(frame) + radius + 1U) -
                      sampleAt(static_cast<std::int64_t>(frame) - radius);
    }
    const auto energy = energyPrefix_.back();
    if (energy / frames < 1.0e-8)
        return 0.0F;

    // Each lag still accumulates in the same sample order. Independent lags in one block
    // let the compiler vectorize across lags without reassociating floating-point additions.
    constexpr std::uint32_t LagsPerBlock = 8;
    std::uint32_t lag = 0;
    for (; lag + LagsPerBlock <= maximumLag + 2U; lag += LagsPerBlock) {
        std::array<double, LagsPerBlock> sums{};
        const auto commonStart = lag + LagsPerBlock - 1U;
        for (std::uint32_t offset = 0; offset < LagsPerBlock; ++offset)
            for (auto frame = lag + offset; frame < commonStart; ++frame)
                sums[offset] += centred_[frame] * centred_[frame - lag - offset];
        for (auto frame = commonStart; frame < frames; ++frame)
            for (std::uint32_t offset = 0; offset < LagsPerBlock; ++offset)
                sums[offset] += centred_[frame] * centred_[frame - lag - offset];
        std::copy(sums.begin(), sums.end(), correlations_.begin() + lag);
    }
    for (; lag <= maximumLag + 1U; ++lag) {
        double correlation = 0.0;
        for (std::uint32_t frame = lag; frame < frames; ++frame)
            correlation += centred_[frame] * centred_[frame - lag];
        correlations_[lag] = correlation;
    }
    for (lag = 0; lag <= maximumLag + 1U; ++lag) {
        const auto currentEnergy = energyPrefix_[frames] - energyPrefix_[lag];
        const auto delayedEnergy = energyPrefix_[frames - lag];
        const auto denominator = currentEnergy + delayedEnergy;
        correlations_[lag] = denominator > 1.0e-12 ? 2.0 * correlations_[lag] / denominator : 0.0;
    }
    // McLeod/Wyvill NSDF key maxima: one strongest peak per positive lobe, after the initial lobe.
    // Taking the first small noisy peak inside a lobe systematically sharpens breathy voices.
    peaks_.clear();
    bool initialLobe = true;
    std::uint32_t peak = 0;
    for (std::uint32_t lag = 1; lag <= maximumLag; ++lag) {
        if (initialLobe) {
            initialLobe = correlations_[lag] > 0;
            continue;
        }
        if (correlations_[lag] <= 0) {
            if (peak != 0) peaks_.push_back(peak);
            peak = 0;
        } else if (lag >= minimumLag && correlations_[lag] >= correlations_[lag - 1] &&
                   correlations_[lag] >= correlations_[lag + 1] &&
                   (peak == 0 || correlations_[lag] > correlations_[peak])) {
            peak = lag;
        }
    }
    if (peak != 0) peaks_.push_back(peak);
    double bestCorrelation = 0;
    for (const auto lag : peaks_) bestCorrelation = std::max(bestCorrelation, correlations_[lag]);
    if (bestCorrelation < 0.35) return 0.0F;
    const auto strongPeak = bestCorrelation * 0.92;
    std::uint32_t selectedLag = 0;
    for (const auto lag : peaks_) {
        if (correlations_[lag] >= strongPeak) {
            selectedLag = lag;
            break;
        }
    }
    // A monotone correlation slope is drift, not a period; never use the search boundary as a pitch.
    if (selectedLag == 0) return 0.0F;

    double refinedLag = selectedLag;
    if (selectedLag > minimumLag && selectedLag < maximumLag) {
        const auto left = correlations_[selectedLag - 1U];
        const auto centre = correlations_[selectedLag];
        const auto right = correlations_[selectedLag + 1U];
        const auto curvature = left - 2.0 * centre + right;
        if (std::abs(curvature) > 1.0e-9)
            refinedLag += std::clamp(0.5 * (left - right) / curvature, -0.5, 0.5);
    }
    confidence = static_cast<float>(std::clamp(correlations_[selectedLag], 0.0, 1.0));
    return static_cast<float>(static_cast<double>(sampleRateHz) / refinedLag);
}
