#include "analysis/AnalysisEngine.hpp"
#include "analysis/PitchEstimator.hpp"

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
    queue_.prepare(queueFrames, channels, true);
    queue_.reset(SourceGenerationId{generation.value()});
    {
        std::lock_guard lock(pitchMutex_);
        pitchHistorySize_ = pitchHistoryWrite_ = 0;
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
    std::lock_guard lock(pitchMutex_);
    queue_.reset(SourceGenerationId{generation.value()});
    generation_.store(generation, std::memory_order_release);
    pitchHistorySize_ = pitchHistoryWrite_ = 0;
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
    if (!queue_.push(SourceGenerationId{generation.value()}, samples, frames, {captureTimes_.data(), frames})) {
        droppedFrames_.fetch_add(frames, std::memory_order_relaxed);
        return;
    }
    wakeWorker();
}

std::vector<PitchObservation> AnalysisEngine::pitchHistory() const {
    std::lock_guard lock(pitchMutex_);
    std::vector<PitchObservation> result;
    result.reserve(pitchHistorySize_);
    const auto first =
        (pitchHistoryWrite_ + pitchHistory_.size() - pitchHistorySize_) % pitchHistory_.size();
    const auto firstCount = std::min(pitchHistorySize_, pitchHistory_.size() - first);
    const auto history = std::span<const PitchObservation>{pitchHistory_};
    const std::array parts{history.subspan(first, firstCount),
                           history.first(pitchHistorySize_ - firstCount)};
    for (const auto part : parts)
        result.insert(result.end(), part.begin(), part.end());
    return result;
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

} // namespace

void AnalysisEngine::workerMain() noexcept {
    const auto channels = channels_.load(std::memory_order_acquire);
    const auto rate = sampleRateHz_.load(std::memory_order_acquire);
    const auto windowFrames = std::max(4U, static_cast<std::uint32_t>(
        std::ceil(static_cast<double>(AnalysisWindowFrames) * rate / 48000)));
    const auto hopFrames = windowFrames / AnalysisOverlap;
    PitchEstimator pitchEstimator;
    pitchEstimator.prepare(windowFrames, rate);
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
                                      std::span<MonotonicTicks>{captureTimes}.subspan(retainedFrames));
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
        const auto pitch = audioActive ? pitchEstimator.estimate(scratch, channels, confidence) : 0.0F;
        {
            std::lock_guard lock(pitchMutex_);
            if (workGeneration != generation_.load(std::memory_order_acquire)) continue;
            pitchHz_.store(pitch, std::memory_order_relaxed);
            if (captureTimes[windowFrames / 2] > 0) {
                // Overlap improves refresh rate; each observation scores only one new hop.
                pitchHistory_[pitchHistoryWrite_] = {
                    ++pitchSequence_, captureTimes[windowFrames / 2], hopFrames, pitch, audioActive,
                    confidence, windowFrames, captureTimes.back() + 1'000'000'000 / rate};
                pitchHistoryWrite_ = (pitchHistoryWrite_ + 1U) % pitchHistory_.size();
                pitchHistorySize_ = std::min(pitchHistorySize_ + 1U, pitchHistory_.size());
            }
        }
        std::move(scratch.begin() + static_cast<std::size_t>(hopFrames) * channels, scratch.end(), scratch.begin());
        std::move(captureTimes.begin() + hopFrames, captureTimes.end(), captureTimes.begin());
        retainedFrames = windowFrames - hopFrames;
        processedFrames_.fetch_add(frames, std::memory_order_relaxed);
    }
}
