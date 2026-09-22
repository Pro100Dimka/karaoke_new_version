#pragma once

#include "common/Types.hpp"
#include "media/IAudioDecoder.hpp"
#include "media/RateTransposeProcessor.hpp"
#include "realtime/PcmRingBuffer.hpp"
#include "realtime/RealtimeInstrumentation.hpp"

#include <array>
#include <atomic>
#include <condition_variable>
#include <cstdint>
#include <memory>
#include <mutex>
#include <span>
#include <string>
#include <thread>
#include <vector>

enum class PlaybackState { Empty, Loading, Ready, Playing, Paused, Stopping, Finished, Failed };
enum class MediaFailureCode { None, DecoderError, Unknown };

struct MediaSourceSnapshot {
    PlaybackState state{PlaybackState::Empty};
    SourceGenerationId generation{0};
    std::uint64_t sourcePositionFrames{0};
    std::uint64_t totalSourceFrames{0};
    std::uint32_t bufferFillFrames{0};
    std::uint64_t underruns{0};
    float rate{1.0F};
    float transpose{0.0F};
    MediaFailureCode failureCode{MediaFailureCode::None};
    std::array<char, 160> failureMessage{};
};

class MediaSource {
  public:
    explicit MediaSource(std::unique_ptr<IAudioDecoder> decoder);
    ~MediaSource();
    MediaSource(const MediaSource&) = delete;
    MediaSource& operator=(const MediaSource&) = delete;

    void prepareOutput(std::uint32_t outputSampleRateHz, std::uint32_t outputChannels,
                       std::uint32_t bufferFrames);
    void load(std::string path);
    void unload() noexcept;
    void play();
    void pause();
    void stop() noexcept;
    void seek(std::uint64_t sourceFrame);
    void setRate(float rate) noexcept;
    void setTranspose(float semitones) noexcept;
    void setLoop(bool enabled, std::uint64_t startFrame, std::uint64_t endFrame);
    [[nodiscard]] std::uint32_t render(std::span<float> output, std::uint32_t frames) noexcept;
    [[nodiscard]] MediaSourceSnapshot snapshot() const noexcept;
    [[nodiscard]] std::uint64_t timelineFrame() const noexcept;
    [[nodiscard]] PlaybackState waitUntilReady();

  private:
    void workerMain() noexcept;
    [[nodiscard]] bool waitForWorkerRequest(std::string& loadPath, bool& doLoad, bool& doSeek,
                                            bool& doUnload, std::uint64_t& seekFrame);
    void applyUnload();
    void applyLoad(const std::string& loadPath);
    void applySeek(std::uint64_t seekFrame);
    void decodeChunk();
    void setFailure(MediaFailureCode code, std::string_view message) noexcept;
    void clearFailure() noexcept;
    void requestWake() noexcept;
    void requestUnloadAndWait() noexcept;
    [[nodiscard]] SourceGenerationId advanceGeneration() noexcept;

    std::unique_ptr<IAudioDecoder> decoder_;
    GenerationPcmRingBuffer ring_;
    RateTransposeProcessor processor_;
    std::thread worker_;
    mutable RealtimeMutex mutex_;
    mutable std::atomic_flag failureLock_ = ATOMIC_FLAG_INIT;
    std::condition_variable_any cv_;
    std::string path_;
    DecodedAudioFormat format_{};
    std::vector<float> decodeScratch_;
    std::vector<float> processScratch_;
    std::vector<float> mappedScratch_;
    std::atomic<PlaybackState> state_{PlaybackState::Empty};
    std::atomic<SourceGenerationId> generation_{SourceGenerationId{0}};
    std::atomic<std::uint64_t> playedOutputFrames_{0};
    std::atomic<std::uint64_t> baseSourceFrame_{0};
    std::atomic<std::uint64_t> totalSourceFrames_{0};
    std::atomic<std::uint64_t> underruns_{0};
    std::atomic<float> rate_{1.0F};
    std::atomic<float> transpose_{0.0F};
    std::atomic<bool> loopEnabled_{false};
    std::atomic<std::uint64_t> loopStartFrame_{0};
    std::atomic<std::uint64_t> loopEndFrame_{0};
    std::uint64_t decoderFrame_{0};
    std::uint32_t outputSampleRateHz_{0};
    std::uint32_t outputChannels_{0};
    bool terminate_{false};
    bool loadRequested_{false};
    bool seekRequested_{false};
    bool unloadRequested_{false};
    bool unloadCompleted_{true};
    bool decoderEof_{false};
    std::uint64_t seekFrame_{0};
    std::atomic<MediaFailureCode> failureCode_{MediaFailureCode::None};
    std::array<char, 160> failureMessage_{};
};
