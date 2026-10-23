#pragma once

#include "analysis/SignalMetrics.hpp"
#include "realtime/PcmRingBuffer.hpp"
#include "realtime/RealtimeInstrumentation.hpp"

#include <atomic>
#include <cstdint>
#include <span>
#include <thread>
#include <vector>
#include <array>
#include <mutex>
#include <deque>

struct PitchObservation {
    std::uint64_t sequence{0};
    MonotonicTicks capturedAt{0};
    std::uint32_t frames{0};
    float pitchHz{0};
};

struct AnalysisSnapshot {
    SignalMetricsSnapshot signal{};
    float zeroCrossingRate{0.0F};
    std::uint64_t processedFrames{0};
    std::uint64_t droppedFrames{0};
    std::uint64_t staleFrames{0};
    float pitchHz{0.0F};
};

class AnalysisEngine {
  public:
    AnalysisEngine() = default;
    ~AnalysisEngine();

    void prepare(std::uint32_t channels, std::uint32_t sampleRateHz, std::uint32_t queueFrames,
                 GenerationId generation);
    void setGeneration(GenerationId generation) noexcept;
    void push(GenerationId generation, std::span<const float> samples,
              std::uint32_t frames, MonotonicTicks capturedAt = 0) noexcept;
    [[nodiscard]] AnalysisSnapshot snapshot() const noexcept;
    [[nodiscard]] std::vector<PitchObservation> pitchHistory() const;

  private:
    friend struct AnalysisTestAccess;
    void stopWorker() noexcept;
    void wakeWorker() noexcept;
    void workerMain() noexcept;

    PcmRingBuffer queue_;
    std::array<MonotonicTicks, MaxBlockFrames> captureTimes_{}; // sole realtime producer
    mutable std::mutex pitchMutex_; // analysis worker/control only; never taken by push()
    std::deque<PitchObservation> pitchHistory_;
    std::uint64_t pitchSequence_{0};
    std::atomic<std::uint64_t> wakeSequence_{0};
    std::atomic<bool> terminate_{false};
    std::atomic<std::uint32_t> channels_{0};
    std::atomic<std::uint32_t> sampleRateHz_{0};
    std::atomic<std::uint64_t> processedFrames_{0};
    std::atomic<std::uint64_t> droppedFrames_{0};
    std::atomic<std::uint64_t> staleFrames_{0};
    std::atomic<GenerationId> generation_{GenerationId{0}};
    std::atomic<float> zeroCrossingRate_{0.0F};
    std::atomic<float> pitchHz_{0.0F};
    SignalMetrics metrics_;
    std::thread worker_;
};
