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
#include <string_view>
#include <thread>
#include <vector>

enum class RecordingState { Idle, Prepared, Recording, Paused, Finalizing, Finished, Failed };
enum class RecordingTap { RawInput, CleanVoice, ProcessedVoice, MasterMix, PerformanceMix, NetworkInput };

// All timeline fields use the 48 kHz room clock, separately from the WAV sample rate.
// NetworkInput records the effective packet position and the physical source capture interval;
// MasterMix records its scheduled device presentation position. Zero capture fields are unused.
struct RecordingTimeline {
    std::uint64_t frame{0};
    std::uint64_t captureFrame{0};
    std::uint64_t captureEndFrame{0};
    bool roomClockValid{false};
};

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
                 std::uint32_t channels, RecordingTap tap, std::uint32_t queueFrames,
                 bool backing = false);
    void setGeneration(GenerationId generation) noexcept;
    // Render-thread measurement of the processed, gained singer, before backing is mixed in.
    void observeVoicePeak(float peak) noexcept;
    /** leadInFrames: frames of the incoming stream to drop first. The aligned performance trails
     * the music by that lead, so dropping it keeps `playbackPosition` true for the first frame. */
    void start(SessionFrame sessionFrame, std::uint64_t playbackPosition,
               std::uint32_t leadInFrames = 0);
    void pause(SessionFrame sessionFrame);
    void resume(SessionFrame sessionFrame);
    RecordingResult stop(SessionFrame sessionFrame);
    // Control-side failure: stop producers and the writer before abandoning the partial file.
    void fail(std::string_view error) noexcept;
    // Control thread only, while the render-owned performance producer is suspended and drained.
    void appendPerformanceTail(SessionFrame cutoff, std::span<const float> samples,
                               std::uint32_t frames, std::span<const float> backing = {},
                               std::span<const float> dry = {});
    void push(GenerationId generation, RecordingTap tap, SessionFrame sessionFrame,
              std::span<const float> samples, std::uint32_t frames,
              RecordingTimeline timeline = {}, std::span<const float> backing = {},
              std::span<const float> dry = {}) noexcept;
    void markDryIncomplete() noexcept { dryComplete_.store(false, std::memory_order_relaxed); }
    [[nodiscard]] bool backingEnabled() const noexcept {
        return backingEnabled_.load(std::memory_order_relaxed);
    }
    [[nodiscard]] RecordingState state() const noexcept {
        return state_.load(std::memory_order_acquire);
    }
    [[nodiscard]] RecordingTap selectedTap() const noexcept {
        return selectedTap_.load(std::memory_order_relaxed);
    }
    [[nodiscard]] RecordingResult result() const;
    [[nodiscard]] std::uint32_t queueFillFrames() const noexcept {
        return queue_.availableFrames();
    }

  private:
    friend struct RecordingTestAccess;
    void startWorker();
    void stopWorker() noexcept;
    void workerMain() noexcept;
    void wakeWorker() noexcept;
    void releaseProducer() noexcept;
    void drainProducers() noexcept;
    void finalize(std::uint64_t writtenFrames);
    struct QueuedBlock {
        std::uint64_t timelineOffset{0};
        std::uint32_t frames{0};
        RecordingTimeline timeline{};
        bool dryPresent{false};
    };
    PcmRingBuffer queue_;
    PcmRingBuffer backingQueue_;
    PcmRingBuffer dryQueue_;
    // One descriptor per possible queued frame also supports arbitrarily small backend packets.
    std::vector<QueuedBlock> blocks_;
    std::vector<float> scratch_;
    std::vector<float> backingScratch_;
    std::atomic<std::uint64_t> blockWrite_{0};
    std::atomic<std::uint64_t> blockRead_{0};
    std::atomic<std::uint64_t> timelineFrames_{0};
    std::atomic<SessionFrame> lastSessionFrame_{SessionFrame{0}};
    std::atomic<std::uint64_t> epoch_{0};
    std::atomic<std::uint32_t> producers_{0};
    std::atomic<std::uint64_t> wakeSequence_{0};
    WavWriter writer_;
    WavWriter backingWriter_;
    WavWriter vocalWriter_;
    WavWriter dryWriter_;
    std::atomic<bool> dryComplete_{true};
    std::atomic<bool> backingEnabled_{false};
    std::ofstream timelineWriter_;
    std::uint32_t sampleRateHz_{0};
    std::thread worker_;
    mutable RealtimeMutex mutex_;
    std::condition_variable_any queueSpace_;
    std::uint32_t alignmentLeadFrames_{0}; // control thread; reapplied at segment resume
    std::atomic<RecordingState> state_{RecordingState::Idle};
    RecordingResult result_{};
    std::atomic<RecordingTap> selectedTap_{RecordingTap::RawInput};
    std::uint32_t channels_{0};
    SessionFrame pauseStartFrame_{0};
    static constexpr std::size_t MaxRecordedGaps = 1024;
    std::array<RecordingGap, MaxRecordedGaps> realtimeGaps_{};
    std::atomic<std::uint32_t> realtimeGapCount_{0};
    std::atomic<std::uint64_t> realtimeOverrunCount_{0};
    std::atomic<std::uint64_t> staleBlocks_{0};
    std::atomic<float> voicePeak_{0.0F};
    std::atomic<std::uint32_t> leadInRemaining_{0}; // written by start(), consumed by the producer
    std::atomic<GenerationId> generation_{GenerationId{0}};
    std::atomic<bool> terminate_{false};
};
