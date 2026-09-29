#include "diagnostics/PassiveLatencyEstimator.hpp"

#include "diagnostics/AcousticLatencyMeter.hpp"

#include <algorithm>
#include <cmath>
#include <numeric>

namespace {
constexpr MonotonicTicks NanosecondsPerSecond = 1'000'000'000;
// Laptop and desktop speakers and microphones all pass roughly 0.3-4 kHz; above it they differ.
// Analysing that band only needs a sample rate of twice its top.
constexpr double AnalysisBandHz = 4'000.0;
// One second of song per comparison, one comparison per second of new audio.
constexpr double WindowSeconds = 1.0;
constexpr double StepSeconds = 1.0;
// The first search runs this many times coarser; the match is then refined at the full rate.
constexpr std::uint32_t CoarseFactor = 4;
// A real echo stands far above the correlation of all other candidate delays; eight standard
// deviations over about a thousand candidates practically never happens by chance.
constexpr double MinimumProminence = 8.0;
// A hidden delay repeats to the sample. Three windows in a row within a millisecond are accepted.
constexpr double AgreementSeconds = 0.001;
// The worker takes the queue in pieces of this many analysis frames.
constexpr std::uint32_t ChunkFrames = 1'024;

// Mean-free first difference: a correlation peak one sample wide instead of a broad hill that
// follows the song's bass, and no offset from a microphone's DC.
std::vector<double> whitened(std::span<const float> signal, std::uint32_t factor) {
    const auto count = signal.size() / factor;
    std::vector<double> averaged(count);
    for (std::size_t index = 0; index < count; ++index) {
        const auto begin = signal.begin() + static_cast<std::ptrdiff_t>(index * factor);
        averaged[index] = std::accumulate(begin, begin + factor, 0.0) / factor;
    }
    std::vector<double> out(count > 0 ? count - 1 : 0);
    for (std::size_t index = 0; index < out.size(); ++index)
        out[index] = averaged[index + 1] - averaged[index];
    const auto mean = out.empty() ? 0.0 : std::accumulate(out.begin(), out.end(), 0.0) / out.size();
    for (auto& value : out)
        value -= mean;
    return out;
}

double energy(const double* values, std::size_t count) {
    return std::inner_product(values, values + count, values, 0.0);
}

// Normalised correlation of `speaker` with the microphone starting `lag` samples later.
double correlation(const std::vector<double>& speaker, double speakerEnergy,
                   const std::vector<double>& microphone, std::size_t lag) {
    const auto* window = microphone.data() + lag;
    const auto dot = std::inner_product(speaker.begin(), speaker.end(), window, 0.0);
    const auto micEnergy = energy(window, speaker.size());
    return micEnergy > 0.0 ? dot / std::sqrt(speakerEnergy * micEnergy) : 0.0;
}

struct LagRange {
    std::size_t first{0}, last{0};
};

// Microphone lags (samples at `rateHz`) that correspond to every plausible hidden delay.
std::optional<LagRange> plausibleLags(double leadSeconds, double rateHz, std::size_t speakerCount,
                                      std::size_t microphoneCount) {
    const auto earliest = static_cast<double>(AcousticLatencyMeter::EarliestPlausibleNs) /
                          NanosecondsPerSecond;
    const auto first = std::max(0.0, std::ceil((earliest + leadSeconds) * rateHz));
    const auto latest =
        std::floor((AcousticLatencyMeter::MaxRoundTripSeconds + leadSeconds) * rateHz);
    if (microphoneCount < speakerCount)
        return std::nullopt;
    const auto last = std::min(latest, static_cast<double>(microphoneCount - speakerCount));
    if (first > last)
        return std::nullopt;
    return LagRange{static_cast<std::size_t>(first), static_cast<std::size_t>(last)};
}
} // namespace

PassiveLatencyEstimator::~PassiveLatencyEstimator() {
    stopWorker();
}

void PassiveLatencyEstimator::stopWorker() noexcept {
    terminate_.store(true, std::memory_order_release);
    wakeSequence_.fetch_add(1, std::memory_order_release);
    wakeSequence_.notify_one();
    if (worker_.joinable())
        worker_.join();
}

void PassiveLatencyEstimator::prepare(std::uint32_t sampleRateHz) {
    stopWorker();
    decimation_ = std::max(1U, static_cast<std::uint32_t>(sampleRateHz / (2.0 * AnalysisBandHz)));
    rateHz_ = static_cast<double>(sampleRateHz) / decimation_;
    // Room for one window plus the latest speaker lead and hidden delay after it.
    historyFrames_ = static_cast<std::uint32_t>(
        std::ceil((WindowSeconds + 2.0 * AcousticLatencyMeter::MaxRoundTripSeconds) * rateHz_));
    queue_.prepare(historyFrames_, QueuedValues);
    pending_.assign(static_cast<std::size_t>(MaxBlockFrames / decimation_ + 1) * QueuedValues, 0.0F);
    speaker_.assign(historyFrames_, 0.0F);
    microphone_.assign(historyFrames_, 0.0F);
    lead_.assign(historyFrames_, 0.0);
    storedFrames_ = newFrames_ = 0;
    speakerSum_ = microphoneSum_ = 0.0;
    summed_ = 0;
    recentCount_ = 0;
    hiddenNs_.store(0, std::memory_order_relaxed);
    accepted_.store(0, std::memory_order_relaxed);
    attempts_.store(0, std::memory_order_relaxed);
    terminate_.store(false, std::memory_order_release);
    worker_ = std::thread(&PassiveLatencyEstimator::workerMain, this);
}

void PassiveLatencyEstimator::observe(std::span<const float> speaker,
                                      std::span<const float> microphone, std::uint32_t frames,
                                      std::uint32_t channels, MonotonicTicks presentedAt,
                                      MonotonicTicks capturedAt) noexcept {
    const auto samples = static_cast<std::size_t>(frames) * channels;
    if (rateHz_ == 0.0 || channels == 0 || frames > MaxBlockFrames || presentedAt == 0 ||
        capturedAt == 0 || speaker.size() < samples || microphone.size() < samples)
        return;
    const auto lead = static_cast<float>(static_cast<double>(presentedAt - capturedAt) /
                                         NanosecondsPerSecond);
    std::uint32_t produced = 0;
    for (std::uint32_t frame = 0; frame < frames; ++frame) {
        const auto offset = static_cast<std::size_t>(frame) * channels;
        double speakerMono = 0.0;
        for (std::uint32_t channel = 0; channel < channels; ++channel)
            speakerMono += speaker[offset + channel];
        speakerSum_ += speakerMono / channels;
        microphoneSum_ += microphone[offset];
        if (++summed_ < decimation_)
            continue;
        auto* out = pending_.data() + static_cast<std::size_t>(produced) * QueuedValues;
        out[0] = static_cast<float>(speakerSum_ / decimation_);
        out[1] = static_cast<float>(microphoneSum_ / decimation_);
        out[2] = lead;
        ++produced;
        speakerSum_ = microphoneSum_ = 0.0;
        summed_ = 0;
    }
    // A full queue means the worker is behind; those frames are simply not analysed.
    if (produced == 0 || !queue_.push(std::span<const float>{pending_.data(),
                                                             static_cast<std::size_t>(produced) *
                                                                 QueuedValues},
                                      produced))
        return;
    wakeSequence_.fetch_add(1, std::memory_order_release);
    wakeSequence_.notify_one();
}

PassiveLatencySnapshot PassiveLatencyEstimator::snapshot() const noexcept {
    return {hiddenNs_.load(std::memory_order_relaxed), accepted_.load(std::memory_order_relaxed),
            attempts_.load(std::memory_order_relaxed)};
}

std::optional<PassiveLatencyEstimator::Estimate>
PassiveLatencyEstimator::locate(std::span<const float> speaker, std::span<const float> microphone,
                                double speakerLeadSeconds, double rateHz) {
    // Coarse search over every plausible delay: the peak must stand out from all of them.
    const auto coarseSpeaker = whitened(speaker, CoarseFactor);
    const auto coarseMicrophone = whitened(microphone, CoarseFactor);
    const auto coarseRange = plausibleLags(speakerLeadSeconds, rateHz / CoarseFactor,
                                           coarseSpeaker.size(), coarseMicrophone.size());
    const auto coarseEnergy = energy(coarseSpeaker.data(), coarseSpeaker.size());
    if (!coarseRange || coarseEnergy <= 0.0)
        return std::nullopt;
    std::vector<double> scores;
    for (auto lag = coarseRange->first; lag <= coarseRange->last; ++lag)
        scores.push_back(correlation(coarseSpeaker, coarseEnergy, coarseMicrophone, lag));
    const auto best = std::max_element(scores.begin(), scores.end());
    const auto mean = std::accumulate(scores.begin(), scores.end(), 0.0) / scores.size();
    const auto variance = std::accumulate(scores.begin(), scores.end(), 0.0,
                                          [mean](double sum, double score) {
                                              return sum + (score - mean) * (score - mean);
                                          }) / scores.size();
    const auto prominence = variance > 0.0 ? (*best - mean) / std::sqrt(variance) : 0.0;
    if (prominence < MinimumProminence)
        return std::nullopt;
    // Refinement at the full analysis rate around the coarse peak.
    const auto fineSpeaker = whitened(speaker, 1);
    const auto fineMicrophone = whitened(microphone, 1);
    const auto fineRange = plausibleLags(speakerLeadSeconds, rateHz, fineSpeaker.size(),
                                         fineMicrophone.size());
    const auto fineEnergy = energy(fineSpeaker.data(), fineSpeaker.size());
    if (!fineRange || fineEnergy <= 0.0)
        return std::nullopt;
    const auto centre =
        (coarseRange->first + static_cast<std::size_t>(best - scores.begin())) * CoarseFactor;
    const auto first = std::max(fineRange->first, centre > 2 * CoarseFactor ? centre - 2 * CoarseFactor : 0);
    const auto last = std::min(fineRange->last, centre + 2 * CoarseFactor);
    auto bestLag = first;
    auto bestScore = -1.0;
    for (auto lag = first; lag <= last; ++lag) {
        const auto score = correlation(fineSpeaker, fineEnergy, fineMicrophone, lag);
        if (score > bestScore) {
            bestScore = score;
            bestLag = lag;
        }
    }
    return Estimate{static_cast<double>(bestLag) / rateHz - speakerLeadSeconds, prominence};
}

void PassiveLatencyEstimator::analyse() noexcept {
    const auto windowFrames = static_cast<std::size_t>(std::lround(WindowSeconds * rateHz_));
    const auto lead =
        std::accumulate(lead_.begin(), lead_.begin() + static_cast<std::ptrdiff_t>(windowFrames), 0.0) /
        static_cast<double>(windowFrames);
    attempts_.fetch_add(1, std::memory_order_relaxed);
    const auto found = locate(std::span<const float>{speaker_.data(), windowFrames},
                              std::span<const float>{microphone_.data(), microphone_.size()}, lead,
                              rateHz_);
    if (!found)
        return;
    // The latest few estimates slide; they are accepted once they all agree.
    std::rotate(recent_.begin(), recent_.begin() + 1, recent_.end());
    recent_.back() = found->hiddenSeconds;
    recentCount_ = std::min<std::uint32_t>(recentCount_ + 1, static_cast<std::uint32_t>(recent_.size()));
    if (recentCount_ < recent_.size())
        return;
    auto sorted = recent_;
    std::sort(sorted.begin(), sorted.end());
    if (sorted.back() - sorted.front() > AgreementSeconds)
        return;
    const auto median = sorted[sorted.size() / 2];
    hiddenNs_.store(static_cast<MonotonicTicks>(std::llround(std::max(0.0, median) * NanosecondsPerSecond)),
                    std::memory_order_relaxed);
    accepted_.fetch_add(1, std::memory_order_relaxed);
}

void PassiveLatencyEstimator::workerMain() noexcept {
    std::vector<float> chunk(static_cast<std::size_t>(ChunkFrames) * QueuedValues);
    const auto stepFrames = static_cast<std::uint32_t>(std::lround(StepSeconds * rateHz_));
    for (;;) {
        const auto sequence = wakeSequence_.load(std::memory_order_acquire);
        if (terminate_.load(std::memory_order_acquire))
            break;
        const auto read = queue_.pop(chunk, std::min(queue_.availableFrames(), ChunkFrames));
        if (read == 0) {
            wakeSequence_.wait(sequence, std::memory_order_acquire);
            continue;
        }
        // The history keeps the newest frames; older ones slide out at the front.
        const auto keep = std::min<std::uint32_t>(storedFrames_, historyFrames_ - read);
        const auto drop = storedFrames_ - keep;
        std::copy(speaker_.begin() + drop, speaker_.begin() + storedFrames_, speaker_.begin());
        std::copy(microphone_.begin() + drop, microphone_.begin() + storedFrames_, microphone_.begin());
        std::copy(lead_.begin() + drop, lead_.begin() + storedFrames_, lead_.begin());
        for (std::uint32_t frame = 0; frame < read; ++frame) {
            const auto* in = chunk.data() + static_cast<std::size_t>(frame) * QueuedValues;
            speaker_[keep + frame] = in[0];
            microphone_[keep + frame] = in[1];
            lead_[keep + frame] = in[2];
        }
        storedFrames_ = keep + read;
        newFrames_ += read;
        if (storedFrames_ == historyFrames_ && newFrames_ >= stepFrames) {
            newFrames_ = 0;
            analyse();
        }
    }
}
