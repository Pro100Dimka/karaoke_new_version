#include "dsp/BasicProcessors.hpp"

#include <algorithm>
#include <cmath>

namespace {
constexpr float Pi = 3.14159265358979323846F;
float onePoleCoefficient(float hz, float sampleRate) noexcept {
    return 1.0F - std::exp(-2.0F * Pi * hz / sampleRate);
}
} // namespace

void HighPassProcessor::prepare(std::uint32_t sampleRateHz, std::uint32_t, std::uint32_t channels) {
    sampleRateHz_ = sampleRateHz;
    channels_ = std::min(channels, MaxAudioChannels);
    reset();
}
void HighPassProcessor::reset() noexcept {
    previousInput_.fill(0.0F);
    previousOutput_.fill(0.0F);
}
void HighPassProcessor::process(std::span<float> samples, std::uint32_t frames) noexcept {
    const auto cutoff = std::clamp(cutoffHz_.load(std::memory_order_relaxed), 10.0F, 1000.0F);
    const auto rc = 1.0F / (2.0F * Pi * cutoff);
    const auto dt = 1.0F / static_cast<float>(sampleRateHz_);
    const auto alpha = rc / (rc + dt);
    for (std::uint32_t frame = 0; frame < frames; ++frame) {
        for (std::uint32_t ch = 0; ch < channels_; ++ch) {
            const auto index = static_cast<std::size_t>(frame) * channels_ + ch;
            const auto input = samples[index];
            const auto output = alpha * (previousOutput_[ch] + input - previousInput_[ch]);
            previousInput_[ch] = input;
            previousOutput_[ch] = output;
            samples[index] = output;
        }
    }
}

void EqualizerProcessor::prepare(std::uint32_t sampleRateHz, std::uint32_t,
                                 std::uint32_t channels) {
    sampleRateHz_ = sampleRateHz;
    channels_ = std::min(channels, MaxAudioChannels);
    reset();
}
void EqualizerProcessor::reset() noexcept {
    lowState_.fill(0.0F);
    highState_.fill(0.0F);
}
void EqualizerProcessor::process(std::span<float> samples, std::uint32_t frames) noexcept {
    const auto lowAlpha = onePoleCoefficient(250.0F, static_cast<float>(sampleRateHz_));
    const auto highAlpha = onePoleCoefficient(4000.0F, static_cast<float>(sampleRateHz_));
    const auto lowGain = std::clamp(lowGain_.load(std::memory_order_relaxed), 0.0F, 4.0F);
    const auto midGain = std::clamp(midGain_.load(std::memory_order_relaxed), 0.0F, 4.0F);
    const auto highGain = std::clamp(highGain_.load(std::memory_order_relaxed), 0.0F, 4.0F);
    for (std::uint32_t frame = 0; frame < frames; ++frame) {
        for (std::uint32_t ch = 0; ch < channels_; ++ch) {
            const auto index = static_cast<std::size_t>(frame) * channels_ + ch;
            const auto input = samples[index];
            lowState_[ch] += lowAlpha * (input - lowState_[ch]);
            highState_[ch] += highAlpha * (input - highState_[ch]);
            const auto low = lowState_[ch];
            const auto high = input - highState_[ch];
            const auto mid = input - low - high;
            samples[index] = low * lowGain + mid * midGain + high * highGain;
        }
    }
}

void CompressorProcessor::prepare(std::uint32_t sampleRateHz, std::uint32_t,
                                  std::uint32_t channels) {
    sampleRateHz_ = sampleRateHz;
    channels_ = channels;
    reset();
}
void CompressorProcessor::reset() noexcept {
    envelope_ = 0.0F;
}
void CompressorProcessor::process(std::span<float> samples, std::uint32_t frames) noexcept {
    const auto threshold = std::clamp(threshold_.load(std::memory_order_relaxed), 0.01F, 1.0F);
    const auto ratio = std::clamp(ratio_.load(std::memory_order_relaxed), 1.0F, 20.0F);
    if (threshold >= 0.999F && ratio <= 1.001F)
        return;
    const auto attack = std::exp(-1.0F / (0.005F * static_cast<float>(sampleRateHz_)));
    const auto release = std::exp(-1.0F / (0.080F * static_cast<float>(sampleRateHz_)));
    const auto count = static_cast<std::size_t>(frames) * channels_;
    for (std::size_t index = 0; index < count; ++index) {
        const auto level = std::abs(samples[index]);
        envelope_ = level > envelope_ ? attack * envelope_ + (1.0F - attack) * level
                                      : release * envelope_ + (1.0F - release) * level;
        if (envelope_ > threshold) {
            const auto compressed = threshold + (envelope_ - threshold) / ratio;
            samples[index] *= compressed / std::max(envelope_, 1.0e-6F);
        }
    }
}

void GateProcessor::prepare(std::uint32_t sampleRateHz, std::uint32_t, std::uint32_t channels) {
    sampleRateHz_ = sampleRateHz;
    channels_ = channels;
    reset();
}
void GateProcessor::reset() noexcept {
    gain_ = 1.0F;
}
void GateProcessor::process(std::span<float> samples, std::uint32_t frames) noexcept {
    const auto threshold = std::clamp(threshold_.load(std::memory_order_relaxed), 0.0F, 0.5F);
    if (threshold <= 0.0F)
        return;
    const auto releaseMs = std::clamp(releaseMs_.load(std::memory_order_relaxed), 5.0F, 1000.0F);
    const auto release = std::exp(-1.0F / (releaseMs * 0.001F * static_cast<float>(sampleRateHz_)));
    for (std::uint32_t frame = 0; frame < frames; ++frame) {
        float level = 0.0F;
        for (std::uint32_t ch = 0; ch < channels_; ++ch)
            level = std::max(level,
                             std::abs(samples[static_cast<std::size_t>(frame) * channels_ + ch]));
        const auto target = level >= threshold ? 1.0F : 0.0F;
        gain_ = target > gain_ ? target : release * gain_;
        for (std::uint32_t ch = 0; ch < channels_; ++ch)
            samples[static_cast<std::size_t>(frame) * channels_ + ch] *= gain_;
    }
}

void NoiseProcessor::process(std::span<float> samples, std::uint32_t frames) noexcept {
    const auto threshold = std::clamp(threshold_.load(std::memory_order_relaxed), 0.0F, 0.25F);
    const auto reduction = std::clamp(reduction_.load(std::memory_order_relaxed), 0.0F, 1.0F);
    if (threshold <= 0.0F || reduction >= 0.999F)
        return;
    const auto envelopeAttack = std::exp(-1.0F / (0.001F * static_cast<float>(sampleRateHz_)));
    const auto release = std::exp(-1.0F / (0.080F * static_cast<float>(sampleRateHz_)));
    const auto gainAttack = std::exp(-1.0F / (0.005F * static_cast<float>(sampleRateHz_)));
    for (std::uint32_t frame = 0; frame < frames; ++frame) {
        float level = 0.0F;
        for (std::uint32_t channel = 0; channel < channels_; ++channel)
            level = std::max(level, std::abs(samples[static_cast<std::size_t>(frame) * channels_ + channel]));
        const auto envelopeCoefficient = level > envelope_ ? envelopeAttack : release;
        envelope_ = level + envelopeCoefficient * (envelope_ - level);
        const auto target = envelope_ >= threshold ? 1.0F : reduction;
        const auto coefficient = target > gain_ ? gainAttack : release;
        gain_ = target + coefficient * (gain_ - target);
        for (std::uint32_t channel = 0; channel < channels_; ++channel)
            samples[static_cast<std::size_t>(frame) * channels_ + channel] *= gain_;
    }
}

void ReverbProcessor::prepare(std::uint32_t sampleRateHz, std::uint32_t, std::uint32_t channels) {
    channels_ = channels;
    constexpr std::array<float, 3> delaySeconds{0.0297F, 0.0371F, 0.0411F};
    for (std::size_t i = 0; i < lines_.size(); ++i) {
        const auto frames = std::max(
            1U, static_cast<std::uint32_t>(delaySeconds[i] * static_cast<float>(sampleRateHz)));
        lines_[i].assign(static_cast<std::size_t>(frames) * channels_, 0.0F);
        positions_[i] = 0;
    }
}
void ReverbProcessor::reset() noexcept {
    for (auto& line : lines_)
        std::fill(line.begin(), line.end(), 0.0F);
    positions_.fill(0);
}
void ReverbProcessor::process(std::span<float> samples, std::uint32_t frames) noexcept {
    const auto mix = std::clamp(mix_.load(std::memory_order_relaxed), 0.0F, 1.0F);
    if (mix <= 0.0F)
        return;
    const auto decay = std::clamp(decay_.load(std::memory_order_relaxed), 0.0F, 0.85F);
    for (std::uint32_t frame = 0; frame < frames; ++frame) {
        for (std::uint32_t ch = 0; ch < channels_; ++ch) {
            const auto index = static_cast<std::size_t>(frame) * channels_ + ch;
            const auto dry = samples[index];
            float wet = 0.0F;
            for (std::size_t line = 0; line < lines_.size(); ++line) {
                const auto framesInLine =
                    static_cast<std::uint32_t>(lines_[line].size() / channels_);
                const auto delayIndex = static_cast<std::size_t>(positions_[line]) * channels_ + ch;
                const auto delayed = lines_[line][delayIndex];
                wet += delayed;
                lines_[line][delayIndex] = dry + delayed * decay;
                if (ch + 1U == channels_)
                    positions_[line] = (positions_[line] + 1U) % framesInLine;
            }
            wet /= static_cast<float>(lines_.size());
            samples[index] = dry * (1.0F - mix) + wet * mix;
        }
    }
}

void DelayProcessor::prepare(std::uint32_t sampleRateHz, std::uint32_t, std::uint32_t channels) {
    sampleRateHz_ = sampleRateHz;
    channels_ = channels;
    capacityFrames_ = sampleRateHz_ * 2U;
    delayLine_.assign(static_cast<std::size_t>(capacityFrames_) * channels_, 0.0F);
    reset();
}
void DelayProcessor::reset() noexcept {
    std::fill(delayLine_.begin(), delayLine_.end(), 0.0F);
    writeFrame_ = 0;
}
void DelayProcessor::process(std::span<float> samples, std::uint32_t frames) noexcept {
    if (capacityFrames_ == 0)
        return;
    const auto mix = std::clamp(mix_.load(std::memory_order_relaxed), 0.0F, 1.0F);
    if (mix <= 0.0F)
        return;
    const auto delayFrames =
        std::clamp(static_cast<std::uint32_t>(delayMs_.load(std::memory_order_relaxed) *
                                              static_cast<float>(sampleRateHz_) / 1000.0F),
                   1U, capacityFrames_ - 1U);
    const auto feedback = std::clamp(feedback_.load(std::memory_order_relaxed), 0.0F, 0.95F);
    for (std::uint32_t frame = 0; frame < frames; ++frame) {
        const auto readFrame = (writeFrame_ + capacityFrames_ - delayFrames) % capacityFrames_;
        for (std::uint32_t ch = 0; ch < channels_; ++ch) {
            const auto index = static_cast<std::size_t>(frame) * channels_ + ch;
            const auto writeIndex = static_cast<std::size_t>(writeFrame_) * channels_ + ch;
            const auto readIndex = static_cast<std::size_t>(readFrame) * channels_ + ch;
            const auto dry = samples[index];
            const auto wet = delayLine_[readIndex];
            delayLine_[writeIndex] = dry + wet * feedback;
            samples[index] = dry * (1.0F - mix) + wet * mix;
        }
        writeFrame_ = (writeFrame_ + 1U) % capacityFrames_;
    }
}

void PitchShiftProcessor::prepare(std::uint32_t sampleRateHz, std::uint32_t maxFrames,
                                  std::uint32_t channels) {
    channels_ = channels;
    windowFrames_ = std::clamp(sampleRateHz / 40U, 256U, 2048U);
    capacityFrames_ = windowFrames_ * 3U + maxFrames;
    delayLine_.assign(static_cast<std::size_t>(capacityFrames_) * channels_, 0.0F);
    reset();
}
void PitchShiftProcessor::reset() noexcept {
    std::fill(delayLine_.begin(), delayLine_.end(), 0.0F);
    writeFrame_ = 0;
    phase_ = 0.0;
}
std::uint32_t PitchShiftProcessor::latencyFrames() const noexcept {
    return std::abs(semitones_.load(std::memory_order_relaxed)) < 0.001F ? 0U : windowFrames_;
}
float PitchShiftProcessor::readDelay(std::uint32_t channel, double delayFrames) const noexcept {
    if (capacityFrames_ == 0)
        return 0.0F;
    const auto position = static_cast<double>(writeFrame_) - delayFrames;
    const auto floorPosition = std::floor(position);
    const auto fraction = position - floorPosition;
    const auto wrap = [this](std::int64_t frame) {
        const auto cap = static_cast<std::int64_t>(capacityFrames_);
        auto value = frame % cap;
        if (value < 0)
            value += cap;
        return static_cast<std::uint32_t>(value);
    };
    const auto aFrame = wrap(static_cast<std::int64_t>(floorPosition));
    const auto bFrame = wrap(static_cast<std::int64_t>(floorPosition) + 1);
    const auto a = delayLine_[static_cast<std::size_t>(aFrame) * channels_ + channel];
    const auto b = delayLine_[static_cast<std::size_t>(bFrame) * channels_ + channel];
    return static_cast<float>(a + (b - a) * fraction);
}
void PitchShiftProcessor::process(std::span<float> samples, std::uint32_t frames) noexcept {
    const auto semitones = std::clamp(semitones_.load(std::memory_order_relaxed), -12.0F, 12.0F);
    if (capacityFrames_ == 0 || std::abs(semitones) < 0.001F)
        return;
    const auto pitchRatio = std::pow(2.0, static_cast<double>(semitones) / 12.0);
    const auto phaseIncrement = (pitchRatio - 1.0) / static_cast<double>(windowFrames_);
    for (std::uint32_t frame = 0; frame < frames; ++frame) {
        const auto writeIndexFrame = static_cast<std::uint32_t>(writeFrame_ % capacityFrames_);
        for (std::uint32_t ch = 0; ch < channels_; ++ch)
            delayLine_[static_cast<std::size_t>(writeIndexFrame) * channels_ + ch] =
                samples[static_cast<std::size_t>(frame) * channels_ + ch];
        phase_ += phaseIncrement;
        phase_ -= std::floor(phase_);
        const auto phaseB = phase_ + 0.5 >= 1.0 ? phase_ - 0.5 : phase_ + 0.5;
        const auto gainA = 0.5 - 0.5 * std::cos(2.0 * static_cast<double>(Pi) * phase_);
        const auto gainB = 1.0 - gainA;
        const auto delayA =
            static_cast<double>(windowFrames_) * phase_ + static_cast<double>(windowFrames_);
        const auto delayB =
            static_cast<double>(windowFrames_) * phaseB + static_cast<double>(windowFrames_);
        for (std::uint32_t ch = 0; ch < channels_; ++ch) {
            samples[static_cast<std::size_t>(frame) * channels_ + ch] =
                readDelay(ch, delayA) * static_cast<float>(gainA) +
                readDelay(ch, delayB) * static_cast<float>(gainB);
        }
        ++writeFrame_;
    }
}
