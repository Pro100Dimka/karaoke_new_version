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
            level = std::max(
                level, std::abs(samples[static_cast<std::size_t>(frame) * channels_ + channel]));
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
    sampleRateHz_ = sampleRateHz;
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
    currentSemitones_ = 0.0F;
    pitchAnalysis_.fill(0.0F);
    pitchCorrelations_.fill(-1.0F);
    pitchAnalysisSize_ = 0;
    decimationCount_ = 0;
    decimationSum_ = 0.0F;
    autoTuneCorrection_ = 0.0F;
}
std::uint32_t PitchShiftProcessor::latencyFrames() const noexcept {
    const auto amount = std::clamp(autoTuneAmount_.load(std::memory_order_relaxed), 0.0F, 1.0F);
    if (std::abs(semitones_.load(std::memory_order_relaxed)) < 0.001F && amount < 0.001F)
        return 0U;
    return static_cast<std::uint32_t>(
        std::round(static_cast<float>(windowFrames_) * (1.0F - 0.75F * amount)));
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
void PitchShiftProcessor::analyzePitch(std::span<const float> samples,
                                       std::uint32_t frames) noexcept {
    if (channels_ == 0 || sampleRateHz_ == 0)
        return;
    for (std::uint32_t frame = 0; frame < frames; ++frame) {
        decimationSum_ += samples[static_cast<std::size_t>(frame) * channels_];
        if (++decimationCount_ != PitchDecimation)
            continue;
        pitchAnalysis_[pitchAnalysisSize_++] = decimationSum_ / PitchDecimation;
        decimationCount_ = 0;
        decimationSum_ = 0.0F;
        if (pitchAnalysisSize_ == PitchAnalysisFrames) {
            autoTuneCorrection_ = detectedCorrection();
            // Keep an overlapping analysis window: at 48 kHz the target is refreshed every
            // millisecond instead of waiting roughly forty milliseconds for a new block.
            std::move(pitchAnalysis_.begin() + PitchAnalysisHop, pitchAnalysis_.end(),
                      pitchAnalysis_.begin());
            pitchAnalysisSize_ = PitchAnalysisFrames - PitchAnalysisHop;
        }
    }
}
float PitchShiftProcessor::detectedCorrection() noexcept {
    const auto analysisRate = sampleRateHz_ / PitchDecimation;
    const auto minimumLag = std::max(1U, analysisRate / 1000U);
    const auto maximumLag = std::min(PitchAnalysisFrames / 2U, analysisRate / 70U);
    double mean = 0.0;
    for (const auto sample : pitchAnalysis_)
        mean += sample;
    mean /= PitchAnalysisFrames;
    double energy = 0.0;
    for (const auto sample : pitchAnalysis_) {
        const auto centred = sample - mean;
        energy += centred * centred;
    }
    if (energy / PitchAnalysisFrames < 1.0e-5)
        return 0.0F;

    float bestCorrelation = -1.0F;
    std::uint32_t bestLag = 0;
    for (auto lag = minimumLag; lag <= maximumLag; ++lag) {
        double correlation = 0.0;
        double currentEnergy = 0.0;
        double delayedEnergy = 0.0;
        for (std::uint32_t frame = lag; frame < PitchAnalysisFrames; ++frame) {
            const auto current = static_cast<double>(pitchAnalysis_[frame]) - mean;
            const auto delayed = static_cast<double>(pitchAnalysis_[frame - lag]) - mean;
            correlation += current * delayed;
            currentEnergy += current * current;
            delayedEnergy += delayed * delayed;
        }
        const auto denominator = std::sqrt(currentEnergy * delayedEnergy);
        const auto normalized =
            denominator > 1.0e-12 ? static_cast<float>(correlation / denominator) : 0.0F;
        pitchCorrelations_[lag] = normalized;
        if (normalized > bestCorrelation) {
            bestCorrelation = normalized;
            bestLag = lag;
        }
    }
    if (bestLag == 0 || bestCorrelation < 0.72F)
        return 0.0F;

    const auto strongPeak = bestCorrelation * 0.92F;
    auto selectedLag = bestLag;
    for (auto lag = minimumLag + 1U; lag < bestLag; ++lag) {
        if (pitchCorrelations_[lag] >= strongPeak &&
            pitchCorrelations_[lag] >= pitchCorrelations_[lag - 1U] &&
            pitchCorrelations_[lag] >= pitchCorrelations_[lag + 1U]) {
            selectedLag = lag;
            break;
        }
    }
    float refinedLag = static_cast<float>(selectedLag);
    if (selectedLag > minimumLag && selectedLag < maximumLag) {
        const auto left = pitchCorrelations_[selectedLag - 1U];
        const auto centre = pitchCorrelations_[selectedLag];
        const auto right = pitchCorrelations_[selectedLag + 1U];
        const auto curvature = left - 2.0F * centre + right;
        if (std::abs(curvature) > 1.0e-6F)
            refinedLag += std::clamp(0.5F * (left - right) / curvature, -0.5F, 0.5F);
    }
    const auto pitchHz = static_cast<float>(analysisRate) / refinedLag;
    const auto midi = 69.0F + 12.0F * std::log2(pitchHz / 440.0F);
    return std::clamp(std::round(midi) - midi, -0.5F, 0.5F);
}
void PitchShiftProcessor::process(std::span<float> samples, std::uint32_t frames) noexcept {
    const auto amount = std::clamp(autoTuneAmount_.load(std::memory_order_relaxed), 0.0F, 1.0F);
    if (amount > 0.0F)
        analyzePitch(samples, frames);
    // The top half of the knob is intentionally a stylised robot-voice range rather than a
    // transparent correction range. At 100% it exaggerates the chromatic step sixfold.
    const auto autoTuneStrength = amount * (1.0F + 5.0F * amount);
    const auto targetSemitones = std::clamp(semitones_.load(std::memory_order_relaxed) +
                                                autoTuneCorrection_ * autoTuneStrength,
                                            -12.0F, 12.0F);
    if (capacityFrames_ == 0 || (amount < 0.001F && std::abs(targetSemitones) < 0.001F))
        return;
    // At 100% this is the deliberate Cher/T-Pain hard-tune sound. Lower knob values
    // lengthen the retune time so the same control can still be used more gently.
    const auto retuneSeconds = 0.050F - 0.0499F * amount;
    const auto smoothing = 1.0F - std::exp(-1.0F / (retuneSeconds * sampleRateHz_));
    const auto pitchWindowFrames = static_cast<double>(latencyFrames());
    for (std::uint32_t frame = 0; frame < frames; ++frame) {
        const auto writeIndexFrame = static_cast<std::uint32_t>(writeFrame_ % capacityFrames_);
        for (std::uint32_t ch = 0; ch < channels_; ++ch)
            delayLine_[static_cast<std::size_t>(writeIndexFrame) * channels_ + ch] =
                samples[static_cast<std::size_t>(frame) * channels_ + ch];
        currentSemitones_ =
            amount >= 0.999F
                ? targetSemitones
                : currentSemitones_ + (targetSemitones - currentSemitones_) * smoothing;
        const auto pitchRatio = std::pow(2.0, static_cast<double>(currentSemitones_) / 12.0);
        phase_ += (1.0 - pitchRatio) / pitchWindowFrames;
        phase_ -= std::floor(phase_);
        const auto phaseB = phase_ + 0.5 >= 1.0 ? phase_ - 0.5 : phase_ + 0.5;
        const auto gainA = 0.5 - 0.5 * std::cos(2.0 * static_cast<double>(Pi) * phase_);
        const auto gainB = 1.0 - gainA;
        const auto delayA = pitchWindowFrames * phase_ + pitchWindowFrames;
        const auto delayB = pitchWindowFrames * phaseB + pitchWindowFrames;
        for (std::uint32_t ch = 0; ch < channels_; ++ch) {
            samples[static_cast<std::size_t>(frame) * channels_ + ch] =
                readDelay(ch, delayA) * static_cast<float>(gainA) +
                readDelay(ch, delayB) * static_cast<float>(gainB);
        }
        ++writeFrame_;
    }
}
