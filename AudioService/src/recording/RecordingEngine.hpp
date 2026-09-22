#pragma once

#include "common/Types.hpp"
#include "realtime/PcmRingBuffer.hpp"
#include "realtime/RealtimeInstrumentation.hpp"
#include "recording/WavWriter.hpp"

#include <array>
#include <atomic>
#include <condition_variable>
#include <cstdint>
#include <mutex>
#include <span>
#include <string>
#include <thread>
#include <vector>

enum class RecordingState { Idle, Prepared, Recording, Paused, Finalizing, Finished, Failed };
enum class RecordingTap { RawInput, CleanVoice, ProcessedVoice, MasterMix, PerformanceMix };

struct RecordingGap {
    SessionFrame startFrame{0};
    std::uint64_t frameCount{0};
};
struct RecordingResult {
    std::string recordingId;
    std::string filePath;
    std::uint64_t durationFrames{0};
    double durationSeconds{0.0};
    std::uint32_t sampleRateHz{0};
    std::uint32_t channels{0};
    RecordingTap selectedTap{RecordingTap::RawInput};
    SessionFrame startSessionFrame{0};
    SessionFrame stopSessionFrame{0};
    std::uint64_t startPlaybackPosition{0};
    std::vector<RecordingGap> gaps;
    std::uint64_t overrunCount{0};
    std::uint64_t gapMetadataDropped{0};
    std::uint64_t staleBlocks{0};
    bool finalized{false};
    std::string errorMessage;
};

class RecordingEngine {
  public:
    RecordingEngine();
    ~RecordingEngine();
    void prepare(std::string recordingId, std::string filePath, std::uint32_t sampleRateHz,
                 std::uint32_t channels, RecordingTap tap, std::uint32_t queueFrames);
    void setGeneration(GenerationId generation) noexcept;
    void start(SessionFrame sessionFrame, std::uint64_t playbackPosition);
    void pause(SessionFrame sessionFrame);
    void resume(SessionFrame sessionFrame);
    RecordingResult stop(SessionFrame sessionFrame);
    void push(GenerationId generation, RecordingTap tap, SessionFrame sessionFrame,
              std::span<const float> samples, std::uint32_t frames) noexcept;
    [[nodiscard]] RecordingState state() const noexcept {
        return state_.load(std::memory_order_acquire);
    }
    [[nodiscard]] RecordingResult result() const;
    [[nodiscard]] std::uint32_t queueFillFrames() const noexcept {
        return queue_.availableFrames();
    }

  private:
    void startWorker();
    void stopWorker() noexcept;
    void workerMain() noexcept;
    PcmRingBuffer queue_;
    WavWriter writer_;
    std::thread worker_;
    mutable RealtimeMutex mutex_;
    std::condition_variable_any cv_;
    std::atomic<RecordingState> state_{RecordingState::Idle};
    RecordingResult result_{};
    std::atomic<RecordingTap> selectedTap_{RecordingTap::RawInput};
    std::uint32_t channels_{0};
    SessionFrame pauseStartFrame_{0};
    std::atomic<std::uint64_t> acceptedFrames_{0};
    static constexpr std::size_t MaxRecordedGaps = 1024;
    std::array<RecordingGap, MaxRecordedGaps> realtimeGaps_{};
    std::atomic<std::uint32_t> realtimeGapCount_{0};
    std::atomic<std::uint64_t> realtimeOverrunCount_{0};
    std::atomic<std::uint64_t> staleBlocks_{0};
    std::atomic<GenerationId> generation_{GenerationId{0}};
    bool terminate_{false};
};
