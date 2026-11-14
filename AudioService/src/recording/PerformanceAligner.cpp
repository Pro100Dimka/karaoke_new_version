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
    timelineFrame_ = 0;
    voice_ = {};
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

void PerformanceAligner::addVoice(std::span<const float> samples, std::uint32_t frames, float gain,
                                  std::uint32_t lateFrames) noexcept {
    if (capacityFrames_ == 0 || frames == 0 ||
        samples.size() < static_cast<std::size_t>(frames) * channels_)
        return;
    const auto target = timelineFrame_ + leadFrames_ - std::min(lateFrames, leadFrames_);
    const auto end = target + frames;
    const auto continuous = voice_.valid && timelineFrame_ == voice_.readFrame + voice_.frames;
    const auto start = continuous ? std::clamp(voice_.endFrame, timelineFrame_, end) : target;
    voice_ = {end, timelineFrame_, frames, true};
    const auto count = static_cast<std::uint32_t>(end - start);
    if (count == frames) {
        add(samples, frames, gain, lateFrames);
        return;
    }
    // Moving whole blocks leaves holes or sums adjacent samples. Keep this voice contiguous
    // and distribute its timing correction across the block, without delaying live audio.
    auto position = static_cast<std::uint32_t>(start % capacityFrames_);
    for (std::uint32_t frame = 0; frame < count; ++frame) {
        const auto sourcePosition = static_cast<double>(frame) * frames / count;
        const auto index = static_cast<std::uint32_t>(sourcePosition);
        const auto next = std::min(index + 1U, frames - 1U);
        const auto fraction = static_cast<float>(sourcePosition - index);
        for (std::uint32_t channel = 0; channel < channels_; ++channel) {
            const auto a = samples[static_cast<std::size_t>(index) * channels_ + channel];
            const auto b = samples[static_cast<std::size_t>(next) * channels_ + channel];
            ring_[static_cast<std::size_t>(position) * channels_ + channel] +=
                (a + (b - a) * fraction) * gain;
        }
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
    timelineFrame_ += frames;
}
