#include "analysis/AnalysisEngine.hpp"

#include <algorithm>
#include <cmath>

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
constexpr std::uint32_t AnalysisWindowFrames = 2048;

float estimatePitch(const std::vector<float>& samples, std::uint32_t frames,
                    std::uint32_t channels, std::uint32_t sampleRateHz) noexcept {
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
    for (std::uint32_t frame = 0; frame < frames; ++frame) {
        centred[frame] = samples[static_cast<std::size_t>(frame) * channels] - mean;
        energyPrefix[frame + 1U] = energyPrefix[frame] + centred[frame] * centred[frame];
    }
    const auto energy = energyPrefix.back();
    if (energy / frames < 1.0e-5)
        return 0.0F;

    std::uint32_t bestLag = 0;
    double bestCorrelation = -1.0;
    std::vector<double> correlations(static_cast<std::size_t>(maximumLag) + 1U, -1.0);
    for (std::uint32_t lag = minimumLag; lag <= maximumLag; ++lag) {
        double correlation = 0.0;
        for (std::uint32_t frame = lag; frame < frames; ++frame) {
            correlation += centred[frame] * centred[frame - lag];
        }
        const auto currentEnergy = energyPrefix[frames] - energyPrefix[lag];
        const auto delayedEnergy = energyPrefix[frames - lag];
        const auto denominator = std::sqrt(currentEnergy * delayedEnergy);
        const auto normalized = denominator > 1.0e-12 ? correlation / denominator : 0.0;
        correlations[lag] = normalized;
        if (normalized > bestCorrelation) {
            bestCorrelation = normalized;
            bestLag = lag;
        }
    }
    // Noise always has some accidental positive maximum. Requiring a strong periodic correlation keeps
    // fan noise, consonants and backing-track bleed from producing arbitrary green karaoke notes.
    if (bestLag == 0 || bestCorrelation < 0.6)
        return 0.0F;

    // Prefer the first strong local peak. The global maximum often occurs at a later multiple of the
    // period; selecting that multiple would report a subharmonic and make the marker jump by an octave.
    const auto strongPeak = bestCorrelation * 0.92;
    auto selectedLag = bestLag;
    for (auto lag = minimumLag + 1U; lag < bestLag; ++lag) {
        if (correlations[lag] >= strongPeak && correlations[lag] >= correlations[lag - 1U] &&
            correlations[lag] >= correlations[lag + 1U]) {
            selectedLag = lag;
            break;
        }
    }

    double refinedLag = selectedLag;
    if (selectedLag > minimumLag && selectedLag < maximumLag) {
        const auto left = correlations[selectedLag - 1U];
        const auto centre = correlations[selectedLag];
        const auto right = correlations[selectedLag + 1U];
        const auto curvature = left - 2.0 * centre + right;
        if (std::abs(curvature) > 1.0e-9)
            refinedLag += std::clamp(0.5 * (left - right) / curvature, -0.5, 0.5);
    }
    return static_cast<float>(static_cast<double>(sampleRateHz) / refinedLag);
}
} // namespace

void AnalysisEngine::workerMain() noexcept {
    const auto channels = channels_.load(std::memory_order_acquire);
    std::vector<float> scratch(static_cast<std::size_t>(AnalysisWindowFrames) * channels);

    for (;;) {
        const auto sequence = wakeSequence_.load(std::memory_order_acquire);
        if (terminate_.load(std::memory_order_acquire))
            break;
        // Real devices normally deliver 128-512 frames at a time. Estimating each period separately
        // makes an ordinary 100-300 Hz singing voice mathematically impossible to detect because the
        // correlation window is shorter than even one useful period. Keep those callback blocks in the
        // queue until one complete analysis window is available.
        if (queue_.availableFrames() < AnalysisWindowFrames) {
            wakeSequence_.wait(sequence, std::memory_order_acquire);
            continue;
        }

        const auto workGeneration = generation_.load(std::memory_order_acquire);
        const auto frames = queue_.pop(scratch, AnalysisWindowFrames);
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
