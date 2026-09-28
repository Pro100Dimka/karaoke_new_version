#include "recording/PerformanceAligner.hpp"

#include <algorithm>

void PerformanceAligner::prepare(std::uint32_t channels, std::uint32_t leadFrames,
                                 std::uint32_t maxBlockFrames) {
    channels_ = std::max(1U, channels);
    leadFrames_ = leadFrames;
    // A block written at the full lead must not wrap onto the block being read.
    capacityFrames_ = leadFrames + maxBlockFrames * 2U;
    ring_.assign(static_cast<std::size_t>(capacityFrames_) * channels_, 0.0F);
    reset();
}

void PerformanceAligner::reset() noexcept {
    std::fill(ring_.begin(), ring_.end(), 0.0F);
    readFrame_ = 0;
}

void PerformanceAligner::add(std::span<const float> samples, std::uint32_t frames, float gain,
                             std::uint32_t lateFrames) noexcept {
    if (capacityFrames_ == 0 || samples.size() < static_cast<std::size_t>(frames) * channels_)
        return;
    // A voice later than the whole lead is placed as early as the ring allows.
    const auto offset = leadFrames_ - std::min(lateFrames, leadFrames_);
    auto position = (readFrame_ + offset) % capacityFrames_;
    for (std::uint32_t frame = 0; frame < frames; ++frame) {
        auto* target = ring_.data() + static_cast<std::size_t>(position) * channels_;
        const auto* source = samples.data() + static_cast<std::size_t>(frame) * channels_;
        for (std::uint32_t channel = 0; channel < channels_; ++channel)
            target[channel] += source[channel] * gain;
        position = position + 1U == capacityFrames_ ? 0U : position + 1U;
    }
}

void PerformanceAligner::read(std::span<float> output, std::uint32_t frames) noexcept {
    if (capacityFrames_ == 0 || output.size() < static_cast<std::size_t>(frames) * channels_)
        return;
    for (std::uint32_t frame = 0; frame < frames; ++frame) {
        auto* source = ring_.data() + static_cast<std::size_t>(readFrame_) * channels_;
        std::copy_n(source, channels_, output.data() + static_cast<std::size_t>(frame) * channels_);
        std::fill_n(source, channels_, 0.0F);
        readFrame_ = readFrame_ + 1U == capacityFrames_ ? 0U : readFrame_ + 1U;
    }
}
