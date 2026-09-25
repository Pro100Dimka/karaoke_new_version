#include "media/RateTransposeProcessor.hpp"

#include <algorithm>
#include <cmath>
#include <limits>
#include <stdexcept>

void RateTransposeProcessor::prepare(std::uint32_t inputSampleRateHz,
                                     std::uint32_t outputSampleRateHz, std::uint32_t channels,
                                     std::uint32_t maxInputFrames) {
    if (inputSampleRateHz == 0 || outputSampleRateHz == 0 || channels == 0 ||
        channels > MaxAudioChannels || maxInputFrames == 0)
        throw std::invalid_argument("Invalid media resampler format");
    inputSampleRateHz_ = inputSampleRateHz;
    outputSampleRateHz_ = outputSampleRateHz;
    channels_ = std::clamp(channels, 1U, MaxAudioChannels);
    maxInputFrames_ = std::max(1U, maxInputFrames);
    phaseDenominator_ = static_cast<std::int64_t>(outputSampleRateHz_) * RateScale;
    const auto maximumStep = static_cast<std::int64_t>(inputSampleRateHz_) * (RateScale * 3 / 2);
    if (static_cast<std::uint64_t>(maxInputFrames_) + 1U >
        static_cast<std::uint64_t>((std::numeric_limits<std::int64_t>::max() - maximumStep) /
                                   phaseDenominator_))
        throw std::length_error("Media resampling phase exceeds integer capacity");
    pitchWindowFrames_ = std::clamp(outputSampleRateHz_ / 40U, 512U, 2048U);
    const auto maximumFrames = std::ceil((static_cast<double>(maxInputFrames_) + 1.0) *
                                         outputSampleRateHz_ / (inputSampleRateHz_ * 0.5)) +
                               1.0;
    if (maximumFrames > std::numeric_limits<std::uint32_t>::max())
        throw std::length_error("Media resampling block exceeds frame capacity");
    maximumOutputFrames_ = static_cast<std::uint32_t>(maximumFrames);
    pitchDelay_.assign(static_cast<std::size_t>(pitchWindowFrames_ * 2U) * channels_, 0.0F);
    reset();
}
void RateTransposeProcessor::reset() noexcept {
    std::fill(pitchDelay_.begin(), pitchDelay_.end(), 0.0F);
    resamplePhase_ = 0;
    hasPreviousFrame_ = false;
    pitchWriteFrame_ = 0;
    pitchPhase_ = 0.0;
}
void RateTransposeProcessor::setRate(float rate) noexcept {
    if (!std::isfinite(rate))
        return;
    rate_ = std::clamp(rate, 0.5F, 1.5F);
}
void RateTransposeProcessor::setTranspose(float semitones) noexcept {
    if (!std::isfinite(semitones))
        return;
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
    if (channels_ == 0 || inputFrames > maxInputFrames_ ||
        input.size() < static_cast<std::size_t>(inputFrames) * channels_ ||
        (inputFrames == 0 && !hasPreviousFrame_))
        return 0;
    const auto rate = static_cast<double>(rate_);
    const auto sourceStep = static_cast<std::int64_t>(rate * RateScale) * inputSampleRateHz_;
    const auto distance =
        (static_cast<std::int64_t>(inputFrames) - 1) * phaseDenominator_ - resamplePhase_;
    const auto available =
        inputFrames == 0
            ? (resamplePhase_ < 0 ? (-resamplePhase_ + sourceStep - 1) / sourceStep : 0)
            : (distance >= 0 ? distance / sourceStep + 1 : 0);
    const auto frames = static_cast<std::uint32_t>(available);
    if (output.size() / channels_ < frames)
        return 0; // Caller can retry the same input with the advertised output capacity.
    auto position = resamplePhase_;
    const auto phaseScale = 1.0 / static_cast<double>(phaseDenominator_);
    for (std::uint32_t frame = 0; frame < frames; ++frame) {
        const auto aFrame = position < 0 ? -1 : position / phaseDenominator_;
        const auto fraction =
            static_cast<float>((position - aFrame * phaseDenominator_) * phaseScale);
        for (std::uint32_t ch = 0; ch < channels_; ++ch) {
            const auto a = aFrame < 0 || inputFrames == 0
                               ? previousFrame_[ch]
                               : input[static_cast<std::size_t>(aFrame) * channels_ + ch];
            const auto b = inputFrames == 0 ? previousFrame_[ch]
                                            : input[static_cast<std::size_t>(std::min<std::int64_t>(
                                                        aFrame + 1, inputFrames - 1U)) *
                                                        channels_ +
                                                    ch];
            output[static_cast<std::size_t>(frame) * channels_ + ch] = a + (b - a) * fraction;
        }
        position += sourceStep;
    }
    resamplePhase_ = position - static_cast<std::int64_t>(inputFrames) * phaseDenominator_;
    if (inputFrames != 0) {
        std::copy_n(input.data() + static_cast<std::size_t>(inputFrames - 1U) * channels_,
                    channels_, previousFrame_.data());
    }
    hasPreviousFrame_ = inputFrames != 0;
    const auto desiredPitch = std::pow(2.0, static_cast<double>(transpose_) / 12.0);
    const auto correctionPitch = desiredPitch / rate;
    if (std::abs(correctionPitch - 1.0) < 1.0e-9) {
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
            const auto sample = output[static_cast<std::size_t>(frame) * channels_ + ch];
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
