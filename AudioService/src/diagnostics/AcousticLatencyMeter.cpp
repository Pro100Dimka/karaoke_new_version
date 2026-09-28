#include "diagnostics/AcousticLatencyMeter.hpp"

#include <algorithm>
#include <array>
#include <cmath>

namespace {
constexpr double Pi = 3.14159265358979323846;
// A quiet 50 ms sweep, well inside speaker and microphone bands.
constexpr double ChirpSeconds = 0.05;
constexpr double ChirpStartHz = 600.0;
constexpr double ChirpEndHz = 5'000.0;
constexpr float ChirpGain = 0.2F;
// Irregular spacing: the train matches itself only at the true offset.
constexpr std::array ChirpOffsetsSeconds{0.0, 0.33, 0.71};
constexpr double TrainSeconds = 0.71 + ChirpSeconds;
// Recording long enough for the whole train plus the slowest plausible round trip.
constexpr double MaxRoundTripSeconds = 0.5;
constexpr double RecordSeconds = TrainSeconds + MaxRoundTripSeconds + 0.2;
constexpr double MinimumConfidence = 0.3;
constexpr MonotonicTicks NanosecondsPerSecond = 1'000'000'000;
// A capture a few milliseconds before the presentation it echoes is timestamp noise, not physics.
constexpr MonotonicTicks EarliestPlausibleNs = -5'000'000;

std::uint32_t frames(double seconds, std::uint32_t rateHz) noexcept {
    return static_cast<std::uint32_t>(std::lround(seconds * rateHz));
}
} // namespace

std::vector<float> AcousticLatencyMeter::chirp(std::uint32_t rateHz) {
    const auto count = frames(ChirpSeconds, rateHz);
    std::vector<float> out(count);
    const auto sweep = (ChirpEndHz - ChirpStartHz) / ChirpSeconds;
    for (std::uint32_t index = 0; index < count; ++index) {
        const auto t = static_cast<double>(index) / rateHz;
        const auto window = 0.5 - 0.5 * std::cos(2.0 * Pi * index / (count - 1U));
        out[index] = static_cast<float>(
            window * std::sin(2.0 * Pi * (ChirpStartHz * t + 0.5 * sweep * t * t)));
    }
    return out;
}

void AcousticLatencyMeter::prepare(std::uint32_t renderRateHz, std::uint32_t captureRateHz) {
    renderRateHz_ = std::max(1U, renderRateHz);
    captureRateHz_ = std::max(1U, captureRateHz);
    const auto single = chirp(renderRateHz_);
    renderProbe_.assign(frames(TrainSeconds, renderRateHz_), 0.0F);
    for (const auto offset : ChirpOffsetsSeconds) {
        const auto start = frames(offset, renderRateHz_);
        for (std::size_t index = 0; index < single.size(); ++index)
            renderProbe_[start + index] += single[index] * ChirpGain;
    }
    captureChirp_ = chirp(captureRateHz_);
    recorded_.assign(frames(RecordSeconds, captureRateHz_), 0.0F);
    state_.store(State::Idle, std::memory_order_release);
}

bool AcousticLatencyMeter::start() noexcept {
    auto current = state_.load(std::memory_order_acquire);
    if (recorded_.empty() || current == State::Playing || current == State::Recorded)
        return false;
    renderPosition_ = 0;
    recordedFrames_ = 0;
    recordStartTicks_ = 0;
    probePresentedAt_.store(0, std::memory_order_relaxed);
    state_.store(State::Playing, std::memory_order_release);
    return true;
}

void AcousticLatencyMeter::render(std::span<float> output, std::uint32_t frameCount,
                                  std::uint32_t channels, MonotonicTicks presentationTicks) noexcept {
    if (state_.load(std::memory_order_acquire) != State::Playing ||
        renderPosition_ >= renderProbe_.size() || channels == 0)
        return;
    if (renderPosition_ == 0) {
        if (presentationTicks == 0) {
            state_.store(State::Failed, std::memory_order_release);
            return;
        }
        probePresentedAt_.store(presentationTicks, std::memory_order_release);
    }
    const auto count = std::min<std::uint32_t>(
        frameCount, static_cast<std::uint32_t>(renderProbe_.size()) - renderPosition_);
    for (std::uint32_t frame = 0; frame < count; ++frame) {
        const auto sample = renderProbe_[renderPosition_ + frame];
        for (std::uint32_t channel = 0; channel < channels; ++channel)
            output[static_cast<std::size_t>(frame) * channels + channel] += sample;
    }
    renderPosition_ += count;
}

void AcousticLatencyMeter::capture(std::span<const float> interleaved, std::uint32_t frameCount,
                                   std::uint32_t channels, MonotonicTicks captureTicks) noexcept {
    if (state_.load(std::memory_order_acquire) != State::Playing || channels == 0 ||
        probePresentedAt_.load(std::memory_order_acquire) == 0)
        return;
    if (recordedFrames_ == 0) {
        if (captureTicks == 0) {
            // Without device capture times the hidden latency cannot be separated from buffering.
            state_.store(State::Failed, std::memory_order_release);
            return;
        }
        recordStartTicks_ = captureTicks;
    }
    const auto count = std::min<std::uint32_t>(
        frameCount, static_cast<std::uint32_t>(recorded_.size()) - recordedFrames_);
    for (std::uint32_t frame = 0; frame < count; ++frame)
        recorded_[recordedFrames_ + frame] = interleaved[static_cast<std::size_t>(frame) * channels];
    recordedFrames_ += count;
    if (recordedFrames_ == recorded_.size())
        state_.store(State::Recorded, std::memory_order_release);
}

std::optional<std::pair<std::uint32_t, double>>
AcousticLatencyMeter::locate(std::span<const float> recorded, std::span<const float> single,
                             std::uint32_t rateHz) {
    std::array<std::uint32_t, ChirpOffsetsSeconds.size()> offsets{};
    for (std::size_t index = 0; index < offsets.size(); ++index)
        offsets[index] = frames(ChirpOffsetsSeconds[index], rateHz);
    const auto length = static_cast<std::uint32_t>(single.size());
    const auto train = offsets.back() + length;
    if (recorded.size() < train || length == 0)
        return std::nullopt;
    double chirpEnergy = 0.0;
    for (const auto value : single)
        chirpEnergy += static_cast<double>(value) * value;
    const auto lastLag = static_cast<std::uint32_t>(recorded.size()) - train;
    double bestScore = -1.0, bestWeakest = 0.0;
    std::uint32_t bestLag = 0;
    for (std::uint32_t lag = 0; lag <= lastLag; ++lag) {
        double score = 0.0, weakest = 1.0;
        for (const auto offset : offsets) {
            double dot = 0.0, energy = 0.0;
            const auto* window = recorded.data() + lag + offset;
            for (std::uint32_t index = 0; index < length; ++index) {
                dot += static_cast<double>(window[index]) * single[index];
                energy += static_cast<double>(window[index]) * window[index];
            }
            const auto ncc = energy > 0.0 ? dot / std::sqrt(energy * chirpEnergy) : 0.0;
            score += ncc;
            weakest = std::min(weakest, ncc);
        }
        if (score > bestScore) {
            bestScore = score;
            bestWeakest = weakest;
            bestLag = lag;
        }
    }
    if (bestWeakest < MinimumConfidence)
        return std::nullopt;
    return std::pair{bestLag, bestWeakest};
}

AcousticLatencyMeter::State AcousticLatencyMeter::poll(Result& result) {
    auto state = state_.load(std::memory_order_acquire);
    if (state == State::Recorded) {
        const auto found = locate(recorded_, captureChirp_, captureRateHz_);
        state = State::Failed;
        if (found) {
            const auto capturedAt = recordStartTicks_ + static_cast<MonotonicTicks>(found->first) *
                                                            NanosecondsPerSecond / captureRateHz_;
            const auto hidden = capturedAt - probePresentedAt_.load(std::memory_order_acquire);
            if (hidden >= EarliestPlausibleNs &&
                hidden <= static_cast<MonotonicTicks>(MaxRoundTripSeconds * NanosecondsPerSecond)) {
                result_ = {std::max<MonotonicTicks>(0, hidden), found->second};
                state = State::Done;
            }
        }
        state_.store(state, std::memory_order_release);
    }
    result = result_;
    return state;
}
