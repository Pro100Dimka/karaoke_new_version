#include "recording/RecordingEngine.hpp"

#include <algorithm>
#include <exception>
#include <ranges>
#include <stdexcept>

RecordingEngine::RecordingEngine() = default;

RecordingEngine::~RecordingEngine() {
    stopWorker();
    writer_.abandon();
}

void RecordingEngine::startWorker() {
    {
        std::lock_guard lock(mutex_);
        terminate_ = false;
    }
    worker_ = std::thread(&RecordingEngine::workerMain, this);
}

void RecordingEngine::stopWorker() noexcept {
    {
        std::lock_guard lock(mutex_);
        terminate_ = true;
    }
    cv_.notify_all();
    if (worker_.joinable())
        worker_.join();
}

void RecordingEngine::prepare(std::string id, std::string path, std::uint32_t sampleRateHz,
                              std::uint32_t channels, RecordingTap tap, std::uint32_t queueFrames) {
    constexpr std::array activeStates{RecordingState::Recording, RecordingState::Paused,
                                      RecordingState::Finalizing};
    if (std::ranges::find(activeStates, state()) != activeStates.end()) {
        throw std::logic_error("recording is active");
    }

    stopWorker();
    writer_.open(path, sampleRateHz, channels);
    queue_.prepare(queueFrames, channels);
    channels_ = channels;
    selectedTap_.store(tap, std::memory_order_relaxed);
    acceptedFrames_.store(0, std::memory_order_relaxed);
    realtimeGapCount_.store(0, std::memory_order_relaxed);
    realtimeOverrunCount_.store(0, std::memory_order_relaxed);
    staleBlocks_.store(0, std::memory_order_relaxed);
    {
        std::lock_guard lock(mutex_);
        result_ = {};
        result_.recordingId = std::move(id);
        result_.filePath = std::move(path);
        result_.sampleRateHz = sampleRateHz;
        result_.channels = channels;
        result_.selectedTap = tap;
        result_.gaps.reserve(MaxRecordedGaps);
    }
    startWorker();
    state_.store(RecordingState::Prepared, std::memory_order_release);
}

void RecordingEngine::start(SessionFrame sessionFrame, std::uint64_t playbackPosition) {
    if (state() != RecordingState::Prepared) {
        throw std::logic_error("recording must be Prepared");
    }
    {
        std::lock_guard lock(mutex_);
        result_.startSessionFrame = sessionFrame;
        result_.startPlaybackPosition = playbackPosition;
    }
    state_.store(RecordingState::Recording, std::memory_order_release);
    cv_.notify_all();
}

void RecordingEngine::pause(SessionFrame sessionFrame) {
    if (state() != RecordingState::Recording) {
        throw std::logic_error("recording must be Recording");
    }
    pauseStartFrame_ = sessionFrame;
    state_.store(RecordingState::Paused, std::memory_order_release);
}

void RecordingEngine::resume(SessionFrame sessionFrame) {
    if (state() != RecordingState::Paused) {
        throw std::logic_error("recording must be Paused");
    }
    if (sessionFrame > pauseStartFrame_) {
        std::lock_guard lock(mutex_);
        if (result_.gaps.size() < MaxRecordedGaps) {
            result_.gaps.push_back({pauseStartFrame_, sessionFrame - pauseStartFrame_});
        } else {
            ++result_.gapMetadataDropped;
        }
    }
    state_.store(RecordingState::Recording, std::memory_order_release);
    cv_.notify_all();
}

RecordingResult RecordingEngine::stop(SessionFrame sessionFrame) {
    constexpr std::array stoppableStates{RecordingState::Recording, RecordingState::Paused};
    if (std::ranges::find(stoppableStates, state()) == stoppableStates.end()) {
        throw std::logic_error("recording is not active");
    }
    {
        std::lock_guard lock(mutex_);
        result_.stopSessionFrame = sessionFrame;
    }
    state_.store(RecordingState::Finalizing, std::memory_order_release);
    cv_.notify_all();

    std::unique_lock lock(mutex_);
    cv_.wait(lock, [this] { return state() != RecordingState::Finalizing; });
    return result_;
}

void RecordingEngine::setGeneration(GenerationId generation) noexcept {
    generation_.store(generation, std::memory_order_release);
    queue_.clear();
    cv_.notify_all();
}

void RecordingEngine::push(GenerationId generation, RecordingTap tap, SessionFrame sessionFrame,
                           std::span<const float> samples, std::uint32_t frames) noexcept {
    if (generation != generation_.load(std::memory_order_acquire)) {
        staleBlocks_.fetch_add(1, std::memory_order_relaxed);
        return;
    }
    if (state() != RecordingState::Recording ||
        tap != selectedTap_.load(std::memory_order_relaxed)) {
        return;
    }
    if (!queue_.push(samples, frames)) {
        // Realtime has one producer. Publish the count only after the gap data is complete.
        const auto index = realtimeGapCount_.load(std::memory_order_relaxed);
        if (index < MaxRecordedGaps) {
            realtimeGaps_[index] = {sessionFrame, frames};
            realtimeGapCount_.store(index + 1U, std::memory_order_release);
        }
        realtimeOverrunCount_.fetch_add(1, std::memory_order_relaxed);
        return;
    }
    acceptedFrames_.fetch_add(frames, std::memory_order_relaxed);
    cv_.notify_one();
}

RecordingResult RecordingEngine::result() const {
    std::lock_guard lock(mutex_);
    return result_;
}

void RecordingEngine::workerMain() noexcept {
    std::vector<float> scratch(static_cast<std::size_t>(2048U) * channels_);
    while (true) {
        {
            std::unique_lock lock(mutex_);
            cv_.wait(lock, [this] {
                const auto current = state();
                return terminate_ || current == RecordingState::Finalizing ||
                       ((current == RecordingState::Recording ||
                         current == RecordingState::Paused) &&
                        queue_.availableFrames() != 0);
            });
            if (terminate_)
                return;
        }

        while (queue_.availableFrames() != 0) {
            const auto workGeneration = generation_.load(std::memory_order_acquire);
            const auto frames = queue_.pop(scratch, 2048U);
            if (workGeneration != generation_.load(std::memory_order_acquire)) {
                staleBlocks_.fetch_add(1, std::memory_order_relaxed);
                continue;
            }
            try {
                writer_.write(std::span<const float>{scratch.data(),
                                                     static_cast<std::size_t>(frames) * channels_});
            } catch (const std::exception& error) {
                {
                    std::lock_guard lock(mutex_);
                    result_.errorMessage = error.what();
                }
                state_.store(RecordingState::Failed, std::memory_order_release);
                cv_.notify_all();
                break;
            }
        }

        if (state() != RecordingState::Finalizing || queue_.availableFrames() != 0) {
            continue;
        }

        try {
            writer_.close();
            {
                std::lock_guard lock(mutex_);
                result_.durationFrames = acceptedFrames_.load(std::memory_order_relaxed);
                result_.durationSeconds = result_.sampleRateHz == 0
                                              ? 0.0
                                              : static_cast<double>(result_.durationFrames) /
                                                    static_cast<double>(result_.sampleRateHz);
                result_.overrunCount = realtimeOverrunCount_.load(std::memory_order_relaxed);
                result_.staleBlocks = staleBlocks_.load(std::memory_order_relaxed);
                const auto gapCount =
                    std::min<std::uint32_t>(realtimeGapCount_.load(std::memory_order_acquire),
                                            static_cast<std::uint32_t>(MaxRecordedGaps));
                for (std::uint32_t index = 0; index < gapCount; ++index) {
                    if (result_.gaps.size() < MaxRecordedGaps) {
                        result_.gaps.push_back(realtimeGaps_[index]);
                    } else {
                        ++result_.gapMetadataDropped;
                    }
                }
                const auto unreportedRealtimeGaps =
                    realtimeOverrunCount_.load(std::memory_order_relaxed) - gapCount;
                result_.gapMetadataDropped += unreportedRealtimeGaps;
                result_.finalized = true;
            }
            state_.store(RecordingState::Finished, std::memory_order_release);
        } catch (const std::exception& error) {
            {
                std::lock_guard lock(mutex_);
                result_.errorMessage = error.what();
            }
            writer_.abandon();
            state_.store(RecordingState::Failed, std::memory_order_release);
        }
        cv_.notify_all();
    }
}
