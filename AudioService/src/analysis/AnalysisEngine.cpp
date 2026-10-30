#include "analysis/AnalysisEngine.hpp"

#include <algorithm>
#include <cmath>
#include <numeric>

AnalysisEngine::~AnalysisEngine() {
    stopWorker();
}

void AnalysisEngine::stopWorker() noexcept {
    terminate_.store(true, std::memory_order_release);
    wakeWorker();
    if (worker_.joinable())
        worker_.join();
}

void AnalysisEngine::wakeWorker() noexcept {
    wakeSequence_.fetch_add(1, std::memory_order_release);
    wakeSequence_.notify_one();
}

void AnalysisEngine::prepare(std::uint32_t channels, std::uint32_t sampleRateHz,
                             std::uint32_t queueFrames, GenerationId generation) {
    stopWorker();
    queue_.prepare(queueFrames, channels, false, true);
    {
        std::lock_guard lock(pitchMutex_);
        pitchHistory_.clear();
    }
    channels_.store(channels, std::memory_order_release);
    sampleRateHz_.store(sampleRateHz, std::memory_order_release);
    processedFrames_.store(0, std::memory_order_relaxed);
    droppedFrames_.store(0, std::memory_order_relaxed);
    staleFrames_.store(0, std::memory_order_relaxed);
    metrics_.reset();
    generation_.store(generation, std::memory_order_release);
    zeroCrossingRate_.store(0.0F, std::memory_order_relaxed);
    pitchHz_.store(0.0F, std::memory_order_relaxed);
    terminate_.store(false, std::memory_order_release);
    worker_ = std::thread(&AnalysisEngine::workerMain, this);
}

void AnalysisEngine::setGeneration(GenerationId generation) noexcept {
    generation_.store(generation, std::memory_order_release);
    queue_.clear();
    std::lock_guard lock(pitchMutex_);
    pitchHistory_.clear();
    pitchHz_.store(0.0F, std::memory_order_relaxed);
}

void AnalysisEngine::push(GenerationId generation, std::span<const float> samples,
                          std::uint32_t frames, MonotonicTicks capturedAt) noexcept {
    if (generation != generation_.load(std::memory_order_acquire)) {
        staleFrames_.fetch_add(frames, std::memory_order_relaxed);
        return;
    }
    if (channels_.load(std::memory_order_acquire) == 0)
        return;
    const auto rate = sampleRateHz_.load(std::memory_order_relaxed);
    if (frames > captureTimes_.size() || rate == 0) {
        droppedFrames_.fetch_add(frames, std::memory_order_relaxed);
        return;
    }
    for (std::uint32_t frame = 0; frame < frames; ++frame)
        captureTimes_[frame] = capturedAt == 0 ? 0 : capturedAt + static_cast<MonotonicTicks>(frame) * 1'000'000'000 / rate;
    if (!queue_.push(samples, frames, 1, nullptr, {captureTimes_.data(), frames})) {
        droppedFrames_.fetch_add(frames, std::memory_order_relaxed);
        return;
    }
    wakeWorker();
}

std::vector<PitchObservation> AnalysisEngine::pitchHistory() const {
    std::lock_guard lock(pitchMutex_);
    return {pitchHistory_.begin(), pitchHistory_.end()};
}

AnalysisSnapshot AnalysisEngine::snapshot() const noexcept {
    return {metrics_.snapshot(),
            zeroCrossingRate_.load(std::memory_order_relaxed),
            processedFrames_.load(std::memory_order_relaxed),
            droppedFrames_.load(std::memory_order_relaxed),
            staleFrames_.load(std::memory_order_relaxed),
            pitchHz_.load(std::memory_order_relaxed)};
}

namespace {
constexpr std::uint32_t AnalysisWindowFrames = 2048;
constexpr std::uint32_t AnalysisOverlap = 4;
constexpr std::size_t PitchHistoryWindows = 64 * AnalysisOverlap;

float estimatePitch(const std::vector<float>& samples, std::uint32_t frames, std::uint32_t channels,
                    std::uint32_t sampleRateHz, float& confidence) noexcept {
    confidence = 0.0F;
    if (frames < 4 || channels == 0 || sampleRateHz == 0)
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
    std::vector<double> centred(frames);
    std::vector<double> energyPrefix(static_cast<std::size_t>(frames) + 1U, 0.0);
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
        centred[frame] = runningSum / (2U * radius + 1U) - mean;
        energyPrefix[frame + 1U] = energyPrefix[frame] + centred[frame] * centred[frame];
        runningSum += sampleAt(static_cast<std::int64_t>(frame) + radius + 1U) -
                      sampleAt(static_cast<std::int64_t>(frame) - radius);
    }
    const auto energy = energyPrefix.back();
    if (energy / frames < 1.0e-8)
        return 0.0F;

    std::vector<double> correlations(static_cast<std::size_t>(maximumLag) + 2U, -1.0);
    for (std::uint32_t lag = 0; lag <= maximumLag + 1; ++lag) {
        double correlation = 0.0;
        for (std::uint32_t frame = lag; frame < frames; ++frame) {
            correlation += centred[frame] * centred[frame - lag];
        }
        const auto currentEnergy = energyPrefix[frames] - energyPrefix[lag];
        const auto delayedEnergy = energyPrefix[frames - lag];
        const auto denominator = currentEnergy + delayedEnergy;
        const auto normalized = denominator > 1.0e-12 ? 2.0 * correlation / denominator : 0.0;
        correlations[lag] = normalized;
    }
    // McLeod/Wyvill NSDF key maxima: one strongest peak per positive lobe, after the initial lobe.
    // Taking the first small noisy peak inside a lobe systematically sharpens breathy voices.
    std::vector<std::uint32_t> peaks;
    bool initialLobe = true;
    std::uint32_t peak = 0;
    for (std::uint32_t lag = 1; lag <= maximumLag; ++lag) {
        if (initialLobe) {
            initialLobe = correlations[lag] > 0;
            continue;
        }
        if (correlations[lag] <= 0) {
            if (peak != 0) peaks.push_back(peak);
            peak = 0;
        } else if (lag >= minimumLag && correlations[lag] >= correlations[lag - 1] &&
                   correlations[lag] >= correlations[lag + 1] &&
                   (peak == 0 || correlations[lag] > correlations[peak])) {
            peak = lag;
        }
    }
    if (peak != 0) peaks.push_back(peak);
    double bestCorrelation = 0;
    for (const auto lag : peaks) bestCorrelation = std::max(bestCorrelation, correlations[lag]);
    if (bestCorrelation < 0.35) return 0.0F;
    const auto strongPeak = bestCorrelation * 0.92;
    std::uint32_t selectedLag = 0;
    for (const auto lag : peaks) {
        if (correlations[lag] >= strongPeak) {
            selectedLag = lag;
            break;
        }
    }
    // A monotone correlation slope is drift, not a period; never use the search boundary as a pitch.
    if (selectedLag == 0) return 0.0F;

    double refinedLag = selectedLag;
    if (selectedLag > minimumLag && selectedLag < maximumLag) {
        const auto left = correlations[selectedLag - 1U];
        const auto centre = correlations[selectedLag];
        const auto right = correlations[selectedLag + 1U];
        const auto curvature = left - 2.0 * centre + right;
        if (std::abs(curvature) > 1.0e-9)
            refinedLag += std::clamp(0.5 * (left - right) / curvature, -0.5, 0.5);
    }
    confidence = static_cast<float>(std::clamp(correlations[selectedLag], 0.0, 1.0));
    return static_cast<float>(static_cast<double>(sampleRateHz) / refinedLag);
}
} // namespace

void AnalysisEngine::workerMain() noexcept {
    const auto channels = channels_.load(std::memory_order_acquire);
    const auto rate = sampleRateHz_.load(std::memory_order_acquire);
    const auto windowFrames = std::max(4U, static_cast<std::uint32_t>(
        std::ceil(static_cast<double>(AnalysisWindowFrames) * rate / 48000)));
    const auto hopFrames = windowFrames / AnalysisOverlap;
    std::vector<float> scratch(static_cast<std::size_t>(windowFrames) * channels);
    std::vector<MonotonicTicks> captureTimes(windowFrames);
    // Match the reference track's 30 dB audible range, using a causal rolling 95th percentile.
    // A sustained quiet voice must not be learned as noise; one click must not set the gate either.
    const auto levelWindow = std::max(1U, rate * 10U / hopFrames);
    std::vector<float> levels(levelWindow), sortedLevels(levelWindow);
    std::uint32_t levelIndex = 0, levelCount = 0;
    std::uint32_t retainedFrames = 0;
    auto windowGeneration = generation_.load(std::memory_order_acquire);

    for (;;) {
        const auto sequence = wakeSequence_.load(std::memory_order_acquire);
        if (terminate_.load(std::memory_order_acquire))
            break;
        const auto workGeneration = generation_.load(std::memory_order_acquire);
        if (workGeneration != windowGeneration) {
            retainedFrames = 0;
            levelIndex = levelCount = 0;
            windowGeneration = workGeneration;
        }
        // Keep a full low-voice analysis window, but refresh it every ~11 ms instead of ~43 ms.
        const auto neededFrames = windowFrames - retainedFrames;
        if (queue_.availableFrames() < neededFrames) {
            wakeSequence_.wait(sequence, std::memory_order_acquire);
            continue;
        }

        const auto offset = static_cast<std::size_t>(retainedFrames) * channels;
        const auto frames = queue_.pop(std::span<float>{scratch}.subspan(offset), neededFrames,
                                      {}, nullptr, std::span<MonotonicTicks>{captureTimes}.subspan(retainedFrames));
        if (workGeneration != generation_.load(std::memory_order_acquire)) {
            staleFrames_.fetch_add(frames, std::memory_order_relaxed);
            continue;
        }
        const auto count = static_cast<std::size_t>(frames) * channels;
        metrics_.observe(std::span<const float>{scratch.data() + offset, count});
        retainedFrames += frames;
        if (retainedFrames < windowFrames) continue;
        const auto squareSum = std::inner_product(scratch.begin(), scratch.end(), scratch.begin(), 0.0);
        const auto rms = static_cast<float>(std::sqrt(squareSum / static_cast<double>(scratch.size())));
        levels[levelIndex] = rms;
        levelIndex = (levelIndex + 1U) % levelWindow;
        levelCount = std::min(levelCount + 1U, levelWindow);
        std::copy_n(levels.begin(), levelCount, sortedLevels.begin());
        const auto percentile = sortedLevels.begin() + (levelCount * 95U + 99U) / 100U - 1U;
        std::nth_element(sortedLevels.begin(), percentile, sortedLevels.begin() + levelCount);
        const auto audioActive = rms > std::max(0.0001F, *percentile * 0.031622777F);

        std::uint64_t crossings = 0;
        for (std::uint32_t frame = 1; frame < windowFrames; ++frame) {
            const auto previous = scratch[(static_cast<std::size_t>(frame) - 1U) * channels];
            const auto current = scratch[static_cast<std::size_t>(frame) * channels];
            if ((previous < 0.0F) != (current < 0.0F))
                ++crossings;
        }
        const auto zeroCrossingRate =
            static_cast<float>(crossings) / static_cast<float>(windowFrames - 1U);
        zeroCrossingRate_.store(zeroCrossingRate, std::memory_order_relaxed);
        float confidence = 0.0F;
        const auto pitch = audioActive ? estimatePitch(scratch, windowFrames, channels, rate, confidence) : 0.0F;
        {
            std::lock_guard lock(pitchMutex_);
            if (workGeneration != generation_.load(std::memory_order_acquire)) continue;
            pitchHz_.store(pitch, std::memory_order_relaxed);
            if (captureTimes[windowFrames / 2] > 0) {
                // Overlap improves refresh rate; each observation scores only one new hop.
                pitchHistory_.push_back({++pitchSequence_, captureTimes[windowFrames / 2], hopFrames, pitch, audioActive, confidence, windowFrames});
                while (pitchHistory_.size() > PitchHistoryWindows) pitchHistory_.pop_front();
            }
        }
        std::move(scratch.begin() + static_cast<std::size_t>(hopFrames) * channels, scratch.end(), scratch.begin());
        std::move(captureTimes.begin() + hopFrames, captureTimes.end(), captureTimes.begin());
        retainedFrames = windowFrames - hopFrames;
        processedFrames_.fetch_add(frames, std::memory_order_relaxed);
    }
}
