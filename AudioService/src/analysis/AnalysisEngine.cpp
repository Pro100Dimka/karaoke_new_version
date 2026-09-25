#include "analysis/AnalysisEngine.hpp"

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
    queue_.prepare(queueFrames, channels);
    channels_.store(channels, std::memory_order_release);
    sampleRateHz_.store(sampleRateHz, std::memory_order_release);
    processedFrames_.store(0, std::memory_order_relaxed);
    droppedFrames_.store(0, std::memory_order_relaxed);
    staleFrames_.store(0, std::memory_order_relaxed);
    generation_.store(generation, std::memory_order_release);
    zeroCrossingRate_.store(0.0F, std::memory_order_relaxed);
    pitchHz_.store(0.0F, std::memory_order_relaxed);
    terminate_.store(false, std::memory_order_release);
    worker_ = std::thread(&AnalysisEngine::workerMain, this);
}

void AnalysisEngine::setGeneration(GenerationId generation) noexcept {
    generation_.store(generation, std::memory_order_release);
    queue_.clear();
}

void AnalysisEngine::push(GenerationId generation, std::span<const float> samples,
                          std::uint32_t frames) noexcept {
    if (generation != generation_.load(std::memory_order_acquire)) {
        staleFrames_.fetch_add(frames, std::memory_order_relaxed);
        return;
    }
    if (channels_.load(std::memory_order_acquire) == 0)
        return;
    if (!queue_.push(samples, frames)) {
        droppedFrames_.fetch_add(frames, std::memory_order_relaxed);
        return;
    }
    wakeWorker();
}

AnalysisSnapshot AnalysisEngine::snapshot() const noexcept {
    return {metrics_.snapshot(), zeroCrossingRate_.load(std::memory_order_relaxed),
            processedFrames_.load(std::memory_order_relaxed),
            droppedFrames_.load(std::memory_order_relaxed),
            staleFrames_.load(std::memory_order_relaxed),
            pitchHz_.load(std::memory_order_relaxed)};
}

namespace {
float estimatePitch(const std::vector<float>& samples, std::uint32_t frames,
                    std::uint32_t channels, std::uint32_t sampleRateHz) noexcept {
    if (frames < 4 || channels == 0 || sampleRateHz == 0)
        return 0.0F;
    const auto minimumLag = std::max(1U, sampleRateHz / 1200U);
    const auto maximumLag = std::min(frames / 2U, sampleRateHz / 60U);
    if (minimumLag >= maximumLag)
        return 0.0F;
    double energy = 0.0;
    for (std::uint32_t frame = 0; frame < frames; ++frame) {
        const auto sample = samples[static_cast<std::size_t>(frame) * channels];
        energy += static_cast<double>(sample) * sample;
    }
    if (energy / frames < 1.0e-5)
        return 0.0F;
    std::uint32_t bestLag = 0;
    double bestCorrelation = 0.0;
    for (std::uint32_t lag = minimumLag; lag <= maximumLag; ++lag) {
        double correlation = 0.0;
        for (std::uint32_t frame = lag; frame < frames; ++frame) {
            const auto current = samples[static_cast<std::size_t>(frame) * channels];
            const auto delayed = samples[static_cast<std::size_t>(frame - lag) * channels];
            correlation += static_cast<double>(current) * delayed;
        }
        if (correlation > bestCorrelation) {
            bestCorrelation = correlation;
            bestLag = lag;
        }
    }
    return bestLag == 0 ? 0.0F : static_cast<float>(sampleRateHz) / static_cast<float>(bestLag);
}
} // namespace

void AnalysisEngine::workerMain() noexcept {
    const auto channels = channels_.load(std::memory_order_acquire);
    std::vector<float> scratch(static_cast<std::size_t>(2048U) * channels);

    for (;;) {
        const auto sequence = wakeSequence_.load(std::memory_order_acquire);
        if (terminate_.load(std::memory_order_acquire))
            break;
        if (queue_.availableFrames() == 0) {
            wakeSequence_.wait(sequence, std::memory_order_acquire);
            continue;
        }

        const auto workGeneration = generation_.load(std::memory_order_acquire);
        const auto frames = queue_.pop(scratch, 2048U);
        if (workGeneration != generation_.load(std::memory_order_acquire)) {
            staleFrames_.fetch_add(frames, std::memory_order_relaxed);
            continue;
        }
        const auto count = static_cast<std::size_t>(frames) * channels;
        metrics_.observe(std::span<const float>{scratch.data(), count});

        std::uint64_t crossings = 0;
        for (std::uint32_t frame = 1; frame < frames; ++frame) {
            const auto previous = scratch[(static_cast<std::size_t>(frame) - 1U) * channels];
            const auto current = scratch[static_cast<std::size_t>(frame) * channels];
            if ((previous < 0.0F) != (current < 0.0F))
                ++crossings;
        }
        const auto zeroCrossingRate =
            frames > 1 ? static_cast<float>(crossings) / static_cast<float>(frames - 1U) : 0.0F;
        zeroCrossingRate_.store(zeroCrossingRate, std::memory_order_relaxed);
        pitchHz_.store(estimatePitch(scratch, frames, channels,
                                     sampleRateHz_.load(std::memory_order_relaxed)),
                       std::memory_order_relaxed);
        processedFrames_.fetch_add(frames, std::memory_order_relaxed);
    }
}
