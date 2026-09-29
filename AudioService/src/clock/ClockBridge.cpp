#include "clock/ClockBridge.hpp"

#include <algorithm>
#include <cmath>
#include <limits>

namespace {
// Policy limits: at most 0.1% temporary speed change, slewed over a quarter second.
// The low-water window ignores the normal sawtooth of unequal capture/render packets.
constexpr double MaxFillCorrection = 0.001;
constexpr double FillWindowSeconds = 0.25;
constexpr double FillResponseSeconds = 1.0;
constexpr double ResidualClockError = 0.0005; // compensated by the fill loop in addition to device clocks

double fillWindowFrames(std::uint32_t capacityFrames, std::uint32_t sampleRateHz) noexcept {
    return std::max(sampleRateHz * FillWindowSeconds, capacityFrames / 2.0);
}
} // namespace

std::uint32_t ClockBridge::recommendedTargetFrames(std::uint32_t capacityFrames,
                                                   std::uint32_t inputSampleRateHz) noexcept {
    // Keep at least 1 ms while regulating, covering rate-estimation error, controller reaction
    // and interpolation lookahead. This is a safety reserve, not a device latency measurement.
    const auto reserve = std::max(inputSampleRateHz / 1000.0, std::ceil(
        inputSampleRateHz * ResidualClockError * FillResponseSeconds +
        fillWindowFrames(capacityFrames, inputSampleRateHz) * MaxFillCorrection) + 2.0);
    return static_cast<std::uint32_t>(std::min(std::ceil(reserve), static_cast<double>(capacityFrames)));
}

void ClockBridge::prepare(std::uint32_t capacityFrames, std::uint32_t targetFrames,
                          std::uint32_t channels, std::uint32_t inputSampleRateHz) {
    channels_ = std::max<std::uint32_t>(1, channels);
    targetFrames_ = std::min(targetFrames, capacityFrames);
    sampleRateHz_ = std::max(1U, inputSampleRateHz);
    windowFrames_ = fillWindowFrames(capacityFrames, sampleRateHz_);
    ring_.prepare(capacityFrames, channels_);
    scratch_.assign(static_cast<std::size_t>(ring_.capacityFrames()) * channels_, 0.0F);
    reset();
}

void ClockBridge::reset() noexcept {
    ring_.clear();
    phase_ = 0.0;
    observedFrames_ = 0.0;
    minimumResidualFrames_ = std::numeric_limits<double>::infinity();
    desiredFillCorrection_ = 0.0;
    largestDemandFrames_ = 0.0;
    fillCorrection_.store(0.0, std::memory_order_relaxed);
    fillControlActive_ = false;
    overruns_.store(0, std::memory_order_relaxed);
    underruns_.store(0, std::memory_order_relaxed);
    droppedFrames_.store(0, std::memory_order_relaxed);
}

double ClockBridge::regulateFill(std::uint32_t available, std::uint32_t outputFrames,
                                 double deviceRatio) noexcept {
    const auto demand = outputFrames * deviceRatio;
    // A render side that sometimes takes two packets at once (a late wake-up) needs that much in
    // reserve before every pull, not just the current demand, or the larger pull finds it empty.
    largestDemandFrames_ = std::max(largestDemandFrames_, demand);
    const auto residual = available - largestDemandFrames_;
    // An exact, balanced clock stays on the zero-lookahead copy path with no added reserve.
    fillControlActive_ = fillControlActive_ || deviceRatio != 1.0 ||
                         residual > targetFrames_;
    if (!fillControlActive_)
        return deviceRatio;
    minimumResidualFrames_ = std::min(minimumResidualFrames_, residual);
    observedFrames_ += demand;
    if (observedFrames_ >= windowFrames_) {
        auto error = minimumResidualFrames_ - targetFrames_;
        // A backlog of more than a whole pull that the speed change cannot remove within one
        // response time (the render side stalled while capture went on, e.g. after a device
        // switch) is stale microphone audio: it would keep every later word late for minutes, so
        // it is dropped at once. Smaller excess, the normal phase wander, is regulated smoothly.
        if (error > std::max(sampleRateHz_ * MaxFillCorrection * FillResponseSeconds,
                             largestDemandFrames_)) {
            droppedFrames_.fetch_add(ring_.discard(static_cast<std::uint32_t>(error)),
                                     std::memory_order_relaxed);
            error = 0.0;
        }
        desiredFillCorrection_ = std::abs(error) <= 1.0 ? 0.0 : std::clamp(
            error / (sampleRateHz_ * FillResponseSeconds), -MaxFillCorrection, MaxFillCorrection);
        observedFrames_ = 0.0;
        minimumResidualFrames_ = std::numeric_limits<double>::infinity();
    }
    const auto previous = fillCorrection_.load(std::memory_order_relaxed);
    const auto step = MaxFillCorrection * demand / windowFrames_;
    const auto correction = previous + std::clamp(desiredFillCorrection_ - previous, -step, step);
    fillCorrection_.store(correction, std::memory_order_relaxed);
    return deviceRatio * (1.0 + correction);
}

bool ClockBridge::push(std::span<const float> samples, std::uint32_t frames) noexcept {
    if (!ring_.push(samples, frames)) {
        overruns_.fetch_add(1, std::memory_order_relaxed);
        return false;
    }
    return true;
}

std::uint32_t ClockBridge::pull(std::span<float> output, std::uint32_t outputFrames,
                                double correctionRatio) noexcept {
    if (channels_ == 0 || output.size() < static_cast<std::size_t>(outputFrames) * channels_)
        return 0;
    if (!std::isfinite(correctionRatio) || correctionRatio <= 0.0) {
        std::fill_n(output.data(), static_cast<std::size_t>(outputFrames) * channels_, 0.0F);
        underruns_.fetch_add(1, std::memory_order_relaxed);
        return 0;
    }
    const auto ratio = regulateFill(ring_.availableFrames(), outputFrames, correctionRatio);
    if (ratio == 1.0 && phase_ == 0.0) {
        // Equal clocks need no interpolation/lookahead. Consume the complete current packet
        // directly instead of retaining its final sample until the next capture callback.
        const auto produced = ring_.pop(output, outputFrames);
        if (produced < outputFrames) {
            std::fill(output.begin() + static_cast<std::ptrdiff_t>(produced * channels_),
                      output.begin() + static_cast<std::ptrdiff_t>(outputFrames * channels_), 0.0F);
            underruns_.fetch_add(1, std::memory_order_relaxed);
        }
        return produced;
    }
    const auto endPosition = phase_ + static_cast<double>(outputFrames) * ratio;
    const auto needed = static_cast<std::uint32_t>(std::min(
        std::floor(endPosition) + 2.0, static_cast<double>(ring_.capacityFrames())));
    const auto toPeek = std::min(needed, ring_.availableFrames());
    const auto read = ring_.peek(scratch_, toPeek);
    if (read < 2) {
        std::fill_n(output.data(), static_cast<std::size_t>(outputFrames) * channels_, 0.0F);
        underruns_.fetch_add(1, std::memory_order_relaxed);
        return 0;
    }
    std::uint32_t produced = 0;
    for (; produced < outputFrames; ++produced) {
        const auto position = phase_ + static_cast<double>(produced) * ratio;
        if (position >= static_cast<double>(read - 1U))
            break;
        const auto index = static_cast<std::uint32_t>(position);
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
        underruns_.fetch_add(1, std::memory_order_relaxed);
    }
    const auto consumedPosition = phase_ + static_cast<double>(produced) * ratio;
    const auto consume = static_cast<std::uint32_t>(
        std::min(std::floor(consumedPosition), static_cast<double>(read)));
    (void)ring_.discard(consume);
    phase_ = consumedPosition - static_cast<double>(consume);
    return produced;
}

ClockBridgeSnapshot ClockBridge::snapshot() const noexcept {
    return {ring_.availableFrames(), targetFrames_, ring_.capacityFrames(),
            overruns_.load(std::memory_order_relaxed), underruns_.load(std::memory_order_relaxed),
            1.0 + fillCorrection_.load(std::memory_order_relaxed),
            droppedFrames_.load(std::memory_order_relaxed)};
}
