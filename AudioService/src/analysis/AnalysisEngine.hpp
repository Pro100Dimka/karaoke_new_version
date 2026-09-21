#pragma once

#include "analysis/SignalMetrics.hpp"
#include "realtime/PcmRingBuffer.hpp"
#include "realtime/RealtimeInstrumentation.hpp"

#include <atomic>
#include <condition_variable>
#include <cstdint>
#include <mutex>
#include <span>
#include <thread>
#include <vector>

struct AnalysisSnapshot {
    SignalMetricsSnapshot signal{};
    float zeroCrossingRate{0.0F};
    std::uint64_t processedFrames{0};
    std::uint64_t droppedFrames{0};
    std::uint64_t staleFrames{0};
};

class AnalysisEngine {
  public:
    AnalysisEngine() = default;
    ~AnalysisEngine();

    void prepare(std::uint32_t channels, std::uint32_t queueFrames, GenerationId generation);
    void setGeneration(GenerationId generation) noexcept;
    void push(GenerationId generation, std::span<const float> samples,
              std::uint32_t frames) noexcept;
    [[nodiscard]] AnalysisSnapshot snapshot() const noexcept;

  private:
    void stopWorker() noexcept;
    void workerMain() noexcept;

    PcmRingBuffer queue_;
    std::condition_variable_any cv_;
    mutable RealtimeMutex mutex_;
    std::atomic<bool> terminate_{false};
    std::atomic<std::uint32_t> channels_{0};
    std::atomic<std::uint64_t> processedFrames_{0};
    std::atomic<std::uint64_t> droppedFrames_{0};
    std::atomic<std::uint64_t> staleFrames_{0};
    std::atomic<GenerationId> generation_{GenerationId{0}};
    std::atomic<float> zeroCrossingRate_{0.0F};
    SignalMetrics metrics_;
    std::thread worker_;
};
