#include "clock/ClockBridge.hpp"

#include <algorithm>
#include <cmath>

void ClockBridge::prepare(std::uint32_t capacityFrames, std::uint32_t targetFrames,
                          std::uint32_t channels) {
    channels_ = std::max<std::uint32_t>(1, channels);
    targetFrames_ = std::min(targetFrames, capacityFrames);
    ring_.prepare(capacityFrames, channels_);
    scratch_.assign(static_cast<std::size_t>(MaxBlockFrames + 8U) * channels_, 0.0F);
    reset();
}

void ClockBridge::reset() noexcept {
    ring_.clear();
    phase_ = 0.0;
    overruns_ = 0;
    underruns_ = 0;
}

bool ClockBridge::push(std::span<const float> samples, std::uint32_t frames) noexcept {
    if (!ring_.push(samples, frames)) {
        ++overruns_;
        return false;
    }
    return true;
}

std::uint32_t ClockBridge::pull(std::span<float> output, std::uint32_t outputFrames,
                                double correctionRatio) noexcept {
    if (channels_ == 0 || output.size() < static_cast<std::size_t>(outputFrames) * channels_)
        return 0;
    const auto ratio = std::clamp(correctionRatio, 0.5, 2.0);
    const auto endPosition = phase_ + static_cast<double>(outputFrames) * ratio;
    const auto needed = static_cast<std::uint32_t>(std::floor(endPosition)) + 2U;
    const auto toPeek = std::min({needed, ring_.availableFrames(), MaxBlockFrames + 8U});
    const auto read = ring_.peek(scratch_, toPeek);
    if (read < 2) {
        std::fill_n(output.data(), static_cast<std::size_t>(outputFrames) * channels_, 0.0F);
        ++underruns_;
        return 0;
    }
    std::uint32_t produced = 0;
    for (; produced < outputFrames; ++produced) {
        const auto position = phase_ + static_cast<double>(produced) * ratio;
        const auto index = static_cast<std::uint32_t>(position);
        if (index + 1U >= read)
            break;
        const auto fraction = static_cast<float>(position - static_cast<double>(index));
        for (std::uint32_t channel = 0; channel < channels_; ++channel) {
            const auto a = scratch_[static_cast<std::size_t>(index) * channels_ + channel];
            const auto b = scratch_[static_cast<std::size_t>(index + 1U) * channels_ + channel];
            output[static_cast<std::size_t>(produced) * channels_ + channel] =
                a + (b - a) * fraction;
        }
    }
    if (produced < outputFrames) {
        std::fill(output.begin() +
                      static_cast<std::ptrdiff_t>(static_cast<std::size_t>(produced) * channels_),
                  output.begin() + static_cast<std::ptrdiff_t>(
                                       static_cast<std::size_t>(outputFrames) * channels_),
                  0.0F);
        ++underruns_;
    }
    const auto consumedPosition = phase_ + static_cast<double>(produced) * ratio;
    const auto consume = static_cast<std::uint32_t>(std::floor(consumedPosition));
    (void)ring_.discard(consume);
    phase_ = consumedPosition - static_cast<double>(consume);
    return produced;
}

ClockBridgeSnapshot ClockBridge::snapshot() const noexcept {
    return {ring_.availableFrames(), targetFrames_, ring_.capacityFrames(), overruns_, underruns_};
}
