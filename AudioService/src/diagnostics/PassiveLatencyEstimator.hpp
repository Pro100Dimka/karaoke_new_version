#pragma once

#include "common/Types.hpp"
#include "realtime/PcmRingBuffer.hpp"

#include <array>
#include <atomic>
#include <cstdint>
#include <optional>
#include <span>
#include <thread>
#include <vector>

struct PassiveLatencySnapshot {
    MonotonicTicks hiddenLatencyNs{0}; // the latest agreed estimate
    std::uint64_t accepted{0};          // agreed estimates so far; 0 until the first one
    std::uint64_t attempts{0};          // windows analysed, found or not
};

/**
 * Measures the round-trip latency the audio devices do not report without any test signal: while
 * the speakers play the song, the microphone hears it too. Comparing what was sent to the speakers
 * with what the microphone recorded, on the devices' own timestamps, gives the same hidden delay the
 * chirp measurement finds. With headphones the microphone hears nothing and no estimate is made.
 *
 * Threads: observe() on the render thread (no allocation or locking); the comparison runs on this
 * estimator's own worker; snapshot() from any thread.
 */
class PassiveLatencyEstimator {
  public:
    struct Estimate {
        double hiddenSeconds{0.0};
        double prominence{0.0}; // correlation peak in standard deviations of all candidate delays
    };

    PassiveLatencyEstimator() = default;
    ~PassiveLatencyEstimator();
    PassiveLatencyEstimator(const PassiveLatencyEstimator&) = delete;
    PassiveLatencyEstimator& operator=(const PassiveLatencyEstimator&) = delete;

    void prepare(std::uint32_t sampleRateHz);
    /**
     * One render block: `speaker` is what the speakers play without the monitored microphone,
     * `microphone` the unprocessed microphone pulled for the same block (interleaved, first channel
     * used). `presentedAt` is when the speaker block's first sample is heard, `capturedAt` when the
     * microphone block's first sample was recorded.
     */
    void observe(std::span<const float> speaker, std::span<const float> microphone,
                 std::uint32_t frames, std::uint32_t channels, MonotonicTicks presentedAt,
                 MonotonicTicks capturedAt) noexcept;
    [[nodiscard]] PassiveLatencySnapshot snapshot() const noexcept;

    /**
     * Hidden delay of `microphone` against `speaker` (both at `rateHz`, same sample index = same
     * render block position). `speakerLeadSeconds` is how much later each speaker sample is heard
     * than the paired microphone sample was recorded. Nullopt without a clear, unique match.
     */
    [[nodiscard]] static std::optional<Estimate> locate(std::span<const float> speaker,
                                                        std::span<const float> microphone,
                                                        double speakerLeadSeconds,
                                                        double rateHz);

  private:
    // Each queued frame: speaker sample, microphone sample, speaker lead in seconds.
    static constexpr std::uint32_t QueuedValues = 3;
    void stopWorker() noexcept;
    void workerMain() noexcept;
    void analyse() noexcept;

    PcmRingBuffer queue_;
    std::uint32_t decimation_{1};
    double rateHz_{0.0}; // analysis rate after decimation
    // Render thread decimation state.
    double speakerSum_{0.0}, microphoneSum_{0.0};
    std::uint32_t summed_{0};
    std::vector<float> pending_;
    // Worker state: the analysed history and the latest agreeing candidates.
    std::vector<float> speaker_, microphone_;
    std::vector<double> lead_;
    std::uint32_t historyFrames_{0}, storedFrames_{0}, newFrames_{0};
    // How many successive estimates must agree before one is accepted.
    std::array<double, 3> recent_{};
    std::uint32_t recentCount_{0};
    std::atomic<MonotonicTicks> hiddenNs_{0};
    std::atomic<std::uint64_t> accepted_{0}, attempts_{0};
    std::atomic<std::uint64_t> wakeSequence_{0};
    std::atomic<bool> terminate_{false};
    std::thread worker_;
};
