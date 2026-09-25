#include "recording/RecordingEngine.hpp"

#include <algorithm>
#include <exception>
#include <ranges>
#include <stdexcept>

RecordingEngine::RecordingEngine() = default;

RecordingEngine::~RecordingEngine() {
    try {
        if (state() != RecordingState::Idle)
            stop(SessionFrame{0});
    } catch (...) {
    }
    stopWorker();
    drainProducers();
    writer_.abandon();
}

void RecordingEngine::startWorker() {
    terminate_.store(false);
    worker_ = std::thread(&RecordingEngine::workerMain, this);
}

void RecordingEngine::stopWorker() noexcept {
    terminate_.store(true);
    wakeWorker();
    if (worker_.joinable())
        worker_.join();
}

void RecordingEngine::wakeWorker() noexcept {
    wakeSequence_.fetch_add(1, std::memory_order_release);
    wakeSequence_.notify_one();
}

void RecordingEngine::releaseProducer() noexcept {
    if (producers_.fetch_sub(1) == 1 && state_.load() != RecordingState::Recording) {
        producers_.notify_all();
        wakeWorker();
    }
}

void RecordingEngine::drainProducers() noexcept {
    for (auto count = producers_.load(); count != 0; count = producers_.load())
        producers_.wait(count);
}

void RecordingEngine::prepare(std::string id, std::string path, std::uint32_t sampleRateHz,
                              std::uint32_t channels, RecordingTap tap, std::uint32_t queueFrames) {
    constexpr std::array activeStates{RecordingState::Recording, RecordingState::Paused,
                                      RecordingState::Finalizing};
    if (std::ranges::find(activeStates, state()) != activeStates.end()) {
        throw std::logic_error("recording is active");
    }

    epoch_.fetch_add(1);
    drainProducers();
    stopWorker();
    {
        std::lock_guard lock(mutex_);
        result_.finalized = false;
    }
    try {
        writer_.open(path, sampleRateHz, channels);
        queue_.prepare(queueFrames, channels);
        blocks_.resize(queue_.capacityFrames());
        scratch_.resize(static_cast<std::size_t>(2048U) * channels);
        blockWrite_.store(0);
        blockRead_.store(0);
        timelineFrames_.store(0);
        lastSessionFrame_.store(SessionFrame{0});
        channels_ = channels;
        selectedTap_.store(tap, std::memory_order_relaxed);
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
        state_.store(RecordingState::Prepared, std::memory_order_release);
        startWorker();
    } catch (...) {
        state_.store(RecordingState::Failed);
        writer_.abandon();
        throw;
    }
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
    lastSessionFrame_.store(sessionFrame);
    state_.store(RecordingState::Recording, std::memory_order_release);
    wakeWorker();
}

void RecordingEngine::pause(SessionFrame sessionFrame) {
    if (state() != RecordingState::Recording) {
        throw std::logic_error("recording must be Recording");
    }
    pauseStartFrame_ = sessionFrame;
    state_.store(RecordingState::Paused);
    drainProducers();
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
    wakeWorker();
}

RecordingResult RecordingEngine::stop(SessionFrame sessionFrame) {
    if (state() == RecordingState::Idle) {
        throw std::logic_error("recording is not active");
    }
    auto current = state_.load();
    if (current == RecordingState::Recording || current == RecordingState::Paused ||
        current == RecordingState::Prepared) {
        std::lock_guard lock(mutex_);
        if (sessionFrame >= result_.startSessionFrame)
            result_.stopSessionFrame = sessionFrame;
    }
    while (current == RecordingState::Recording || current == RecordingState::Paused ||
           current == RecordingState::Prepared) {
        if (state_.compare_exchange_weak(current, RecordingState::Finalizing))
            break;
    }
    wakeWorker();
    while (state() == RecordingState::Finalizing)
        state_.wait(RecordingState::Finalizing);
    drainProducers();
    return result();
}

void RecordingEngine::setGeneration(GenerationId generation) noexcept {
    if (generation_.exchange(generation) == generation)
        return;
    auto current = state_.load();
    while (current == RecordingState::Recording || current == RecordingState::Paused ||
           current == RecordingState::Prepared) {
        if (state_.compare_exchange_weak(current, RecordingState::Finalizing))
            break;
    }
    wakeWorker();
}

void RecordingEngine::push(GenerationId generation, RecordingTap tap, SessionFrame sessionFrame,
                           std::span<const float> samples, std::uint32_t frames) noexcept {
    const auto epoch = epoch_.load();
    if (generation != generation_.load(std::memory_order_acquire)) {
        staleBlocks_.fetch_add(1, std::memory_order_relaxed);
        return;
    }
    if (state() != RecordingState::Recording ||
        tap != selectedTap_.load(std::memory_order_relaxed)) {
        return;
    }
    producers_.fetch_add(1);
    if (state_.load() != RecordingState::Recording || generation != generation_.load() ||
        epoch != epoch_.load()) {
        releaseProducer();
        return;
    }
    if (frames == 0 || samples.size() < static_cast<std::size_t>(frames) * channels_) {
        releaseProducer();
        return;
    }
    const auto offset = timelineFrames_.fetch_add(frames, std::memory_order_relaxed);
    lastSessionFrame_.store(sessionFrame + frames, std::memory_order_relaxed);
    const auto write = blockWrite_.load(std::memory_order_relaxed);
    if (write - blockRead_.load(std::memory_order_acquire) >= blocks_.size() ||
        !queue_.push(samples, frames)) {
        // Realtime has one producer. Publish the count only after the gap data is complete.
        const auto index = realtimeGapCount_.load(std::memory_order_relaxed);
        if (index < MaxRecordedGaps) {
            realtimeGaps_[index] = {sessionFrame, frames};
            realtimeGapCount_.store(index + 1U, std::memory_order_release);
        }
        realtimeOverrunCount_.fetch_add(1, std::memory_order_relaxed);
        releaseProducer();
        wakeWorker();
        return;
    }
    blocks_[write % blocks_.size()] = {offset, frames};
    blockWrite_.store(write + 1, std::memory_order_release);
    releaseProducer();
    wakeWorker();
}

RecordingResult RecordingEngine::result() const {
    std::lock_guard lock(mutex_);
    return result_;
}

void RecordingEngine::finalize(std::uint64_t writtenFrames) {
    writer_.close();
    {
        std::lock_guard lock(mutex_);
        result_.durationFrames = writtenFrames;
        result_.stopSessionFrame = std::max(result_.stopSessionFrame, lastSessionFrame_.load());
        result_.durationSeconds = static_cast<double>(writtenFrames) / result_.sampleRateHz;
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
    state_.store(RecordingState::Finished);
    state_.notify_all();
}

void RecordingEngine::workerMain() noexcept {
    std::uint64_t writtenFrames = 0;
    auto observed = wakeSequence_.load(std::memory_order_acquire);
    const auto silenceUntil = [&](std::uint64_t offset) {
        if (writtenFrames >= offset)
            return;
        std::fill(scratch_.begin(), scratch_.end(), 0.0F);
        while (writtenFrames < offset) {
            const auto frames = std::min<std::uint64_t>(2048U, offset - writtenFrames);
            writer_.write(std::span<const float>{scratch_.data(),
                                                 static_cast<std::size_t>(frames) * channels_});
            writtenFrames += frames;
        }
    };
    while (!terminate_.load(std::memory_order_acquire)) {
        try {
            while (blockRead_.load(std::memory_order_relaxed) !=
                   blockWrite_.load(std::memory_order_acquire)) {
                const auto read = blockRead_.load(std::memory_order_relaxed);
                const auto block = blocks_[read % blocks_.size()];
                silenceUntil(block.timelineOffset);
                auto remaining = block.frames;
                while (remaining != 0) {
                    const auto wanted = std::min(remaining, 2048U);
                    const auto frames = queue_.pop(scratch_, wanted);
                    if (frames != wanted)
                        throw std::runtime_error("recording queue lost a published block");
                    writer_.write(std::span<const float>{
                        scratch_.data(), static_cast<std::size_t>(frames) * channels_});
                    writtenFrames += frames;
                    remaining -= frames;
                }
                blockRead_.store(read + 1, std::memory_order_release);
            }
            if (state_.load() == RecordingState::Finalizing && producers_.load() == 0) {
                // The last producer may have published a descriptor after the drain above.
                if (blockRead_.load() != blockWrite_.load())
                    continue;
                silenceUntil(timelineFrames_.load());
                finalize(writtenFrames);
            }
        } catch (const std::exception& error) {
            {
                std::lock_guard lock(mutex_);
                result_.errorMessage = error.what();
            }
            writer_.abandon();
            state_.store(RecordingState::Failed);
            state_.notify_all();
            return;
        }
        const auto current = wakeSequence_.load(std::memory_order_acquire);
        if (current == observed)
            wakeSequence_.wait(observed);
        observed = wakeSequence_.load(std::memory_order_acquire);
    }
}
