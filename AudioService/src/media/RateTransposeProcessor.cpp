#include "media/RateTransposeProcessor.hpp"

#include <algorithm>
#include <cmath>

void RateTransposeProcessor::prepare(std::uint32_t inputSampleRateHz,
                                     std::uint32_t outputSampleRateHz, std::uint32_t channels,
                                     std::uint32_t maxInputFrames) {
    inputSampleRateHz_ = inputSampleRateHz;
    outputSampleRateHz_ = outputSampleRateHz;
    channels_ = std::clamp(channels, 1U, MaxAudioChannels);
    maxInputFrames_ = std::max(1U, maxInputFrames);
    pitchWindowFrames_ = std::clamp(outputSampleRateHz_ / 40U, 512U, 2048U);
    resampleScratch_.assign(static_cast<std::size_t>(maxInputFrames_ * 3U + 8U) * channels_, 0.0F);
    pitchDelay_.assign(static_cast<std::size_t>(pitchWindowFrames_ * 2U) * channels_, 0.0F);
    reset();
}
void RateTransposeProcessor::reset() noexcept {
    std::fill(pitchDelay_.begin(), pitchDelay_.end(), 0.0F);
    resamplePhase_ = 0.0;
    pitchWriteFrame_ = 0;
    pitchPhase_ = 0.0;
}
void RateTransposeProcessor::setRate(float rate) noexcept {
    rate_ = std::clamp(rate, 0.5F, 1.5F);
}
void RateTransposeProcessor::setTranspose(float semitones) noexcept {
    transpose_ = std::clamp(semitones, -12.0F, 12.0F);
}

float RateTransposeProcessor::delayedSample(std::uint32_t channel,
                                            float delayFrames) const noexcept {
    const auto capacity = pitchWindowFrames_ * 2U;
    const auto delay = std::clamp(delayFrames, 1.0F, static_cast<float>(capacity - 2U));
    auto position = static_cast<float>(pitchWriteFrame_) - delay;
    while (position < 0.0F)
        position += static_cast<float>(capacity);
    const auto aFrame = static_cast<std::uint32_t>(position) % capacity;
    const auto bFrame = (aFrame + 1U) % capacity;
    const auto fraction = position - std::floor(position);
    const auto a = pitchDelay_[static_cast<std::size_t>(aFrame) * channels_ + channel];
    const auto b = pitchDelay_[static_cast<std::size_t>(bFrame) * channels_ + channel];
    return a + (b - a) * fraction;
}
void RateTransposeProcessor::pushPitchSample(std::uint32_t channel, float sample) noexcept {
    const auto capacity = pitchWindowFrames_ * 2U;
    pitchDelay_[static_cast<std::size_t>(pitchWriteFrame_ % capacity) * channels_ + channel] =
        sample;
}

std::uint32_t RateTransposeProcessor::process(std::span<const float> input,
                                              std::uint32_t inputFrames,
                                              std::span<float> output) noexcept {
    if (inputFrames < 2 || channels_ == 0)
        return 0;
    const auto rate = static_cast<double>(rate_);
    const auto sourceStep =
        rate * static_cast<double>(inputSampleRateHz_) / static_cast<double>(outputSampleRateHz_);
    const auto resampledFrames = std::min<std::uint32_t>(
        static_cast<std::uint32_t>(static_cast<double>(inputFrames - 1U) / sourceStep),
        static_cast<std::uint32_t>(resampleScratch_.size() / channels_));
    for (std::uint32_t frame = 0; frame < resampledFrames; ++frame) {
        const auto position = resamplePhase_ + static_cast<double>(frame) * sourceStep;
        auto aFrame = static_cast<std::uint32_t>(position);
        if (aFrame + 1U >= inputFrames)
            aFrame = inputFrames - 2U;
        const auto fraction = static_cast<float>(position - static_cast<double>(aFrame));
        for (std::uint32_t ch = 0; ch < channels_; ++ch) {
            const auto a = input[static_cast<std::size_t>(aFrame) * channels_ + ch];
            const auto b = input[static_cast<std::size_t>(aFrame + 1U) * channels_ + ch];
            resampleScratch_[static_cast<std::size_t>(frame) * channels_ + ch] =
                a + (b - a) * fraction;
        }
    }
    const auto maxOutputFrames = static_cast<std::uint32_t>(output.size() / channels_);
    const auto frames = std::min(resampledFrames, maxOutputFrames);
    const auto desiredPitch = std::pow(2.0, static_cast<double>(transpose_) / 12.0);
    const auto correctionPitch = desiredPitch / rate;
    if (std::abs(correctionPitch - 1.0) < 1.0e-9) {
        std::copy_n(resampleScratch_.data(), static_cast<std::size_t>(frames) * channels_,
                    output.data());
        return frames;
    }
    const auto delta = 1.0 - correctionPitch;
    const auto window = static_cast<double>(pitchWindowFrames_);
    for (std::uint32_t frame = 0; frame < frames; ++frame) {
        const auto phaseA = std::fmod(pitchPhase_, 1.0);
        const auto phaseB = std::fmod(phaseA + 0.5, 1.0);
        const auto delayA = static_cast<float>((0.25 + phaseA) * window);
        const auto delayB = static_cast<float>((0.25 + phaseB) * window);
        const auto gainA =
            static_cast<float>(0.5 - 0.5 * std::cos(phaseA * 2.0 * 3.141592653589793));
        const auto gainB = 1.0F - gainA;
        for (std::uint32_t ch = 0; ch < channels_; ++ch) {
            const auto sample = resampleScratch_[static_cast<std::size_t>(frame) * channels_ + ch];
            pushPitchSample(ch, sample);
            const auto a = delayedSample(ch, delayA);
            const auto b = delayedSample(ch, delayB);
            output[static_cast<std::size_t>(frame) * channels_ + ch] = a * gainA + b * gainB;
        }
        pitchWriteFrame_ = (pitchWriteFrame_ + 1U) % (pitchWindowFrames_ * 2U);
        pitchPhase_ += delta / window;
        while (pitchPhase_ < 0.0)
            pitchPhase_ += 1.0;
        while (pitchPhase_ >= 1.0)
            pitchPhase_ -= 1.0;
    }
    return frames;
}

std::uint32_t RateTransposeProcessor::latencyFrames() const noexcept {
    const auto desiredPitch = std::pow(2.0, static_cast<double>(transpose_) / 12.0);
    const auto correctionPitch = desiredPitch / static_cast<double>(rate_);
    return std::abs(correctionPitch - 1.0) < 1.0e-9 ? 0U : pitchWindowFrames_ / 2U;
}
