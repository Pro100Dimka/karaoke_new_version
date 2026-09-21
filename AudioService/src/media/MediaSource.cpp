#include "media/MediaSource.hpp"

#include <algorithm>
#include <array>
#include <ranges>
#include <stdexcept>

MediaSource::MediaSource(std::unique_ptr<IAudioDecoder> decoder) : decoder_(std::move(decoder)) {
    if (!decoder_)
        throw std::invalid_argument("decoder is required");
    worker_ = std::thread(&MediaSource::workerMain, this);
}
MediaSource::~MediaSource() {
    {
        std::lock_guard lock(mutex_);
        terminate_ = true;
    }
    cv_.notify_all();
    if (worker_.joinable())
        worker_.join();
    decoder_->close();
}
SourceGenerationId MediaSource::advanceGeneration() noexcept {
    auto next = generation_.load(std::memory_order_relaxed);
    ++next;
    generation_.store(next, std::memory_order_release);
    return next;
}

void MediaSource::requestUnloadAndWait() noexcept {
    (void)advanceGeneration();
    state_.store(PlaybackState::Empty, std::memory_order_release);
    decoder_->cancel();
    {
        std::lock_guard lock(mutex_);
        loadRequested_ = false;
        seekRequested_ = false;
        unloadRequested_ = true;
        unloadCompleted_ = false;
    }
    cv_.notify_all();
    std::unique_lock lock(mutex_);
    cv_.wait(lock, [this] { return unloadCompleted_ || terminate_; });
}
void MediaSource::prepareOutput(std::uint32_t outputSampleRateHz, std::uint32_t outputChannels,
                                std::uint32_t bufferFrames) {
    if (outputSampleRateHz == 0 || outputChannels == 0 || outputChannels > MaxAudioChannels ||
        bufferFrames == 0)
        throw std::invalid_argument("invalid media output configuration");
    requestUnloadAndWait();
    outputSampleRateHz_ = outputSampleRateHz;
    outputChannels_ = outputChannels;
    ring_.prepare(bufferFrames, outputChannels);
    ring_.reset(generation_.load(std::memory_order_acquire));
}
void MediaSource::load(std::string path) {
    if (path.empty() || outputSampleRateHz_ == 0 || outputChannels_ == 0 ||
        ring_.capacityFrames() == 0)
        throw std::invalid_argument("media source must be prepared before load");
    requestUnloadAndWait();
    const auto generation = advanceGeneration();
    ring_.reset(generation);
    clearFailure();
    playedOutputFrames_.store(0, std::memory_order_relaxed);
    baseSourceFrame_.store(0, std::memory_order_relaxed);
    state_.store(PlaybackState::Loading, std::memory_order_release);
    {
        std::lock_guard lock(mutex_);
        path_ = std::move(path);
        loadRequested_ = true;
    }
    cv_.notify_all();
}
void MediaSource::unload() noexcept {
    requestUnloadAndWait();
    ring_.reset(generation_.load(std::memory_order_acquire));
    playedOutputFrames_.store(0, std::memory_order_relaxed);
    baseSourceFrame_.store(0, std::memory_order_relaxed);
}
void MediaSource::play() {
    const auto state = state_.load(std::memory_order_acquire);
    constexpr std::array playableStates{PlaybackState::Ready, PlaybackState::Paused,
                                        PlaybackState::Finished};
    if (std::ranges::find(playableStates, state) == playableStates.end()) {
        throw std::logic_error("media must be Ready/Paused/Finished before Play");
    }
    if (state == PlaybackState::Finished)
        seek(0);
    state_.store(PlaybackState::Playing, std::memory_order_release);
    requestWake();
}
void MediaSource::pause() {
    if (state_.load(std::memory_order_acquire) != PlaybackState::Playing)
        throw std::logic_error("Pause requires Playing");
    state_.store(PlaybackState::Paused, std::memory_order_release);
}
void MediaSource::stop() noexcept {
    const auto state = state_.load(std::memory_order_acquire);
    if (state == PlaybackState::Empty)
        return;
    const auto next = advanceGeneration();
    ring_.reset(next);
    playedOutputFrames_.store(0, std::memory_order_relaxed);
    baseSourceFrame_.store(0, std::memory_order_relaxed);
    decoder_->cancel();
    {
        std::lock_guard lock(mutex_);
        seekFrame_ = 0;
        seekRequested_ = true;
    }
    state_.store(PlaybackState::Ready, std::memory_order_release);
    cv_.notify_all();
}
void MediaSource::seek(std::uint64_t sourceFrame) {
    if (state_.load(std::memory_order_acquire) == PlaybackState::Empty)
        throw std::logic_error("cannot seek empty source");
    const auto next = advanceGeneration();
    ring_.reset(next);
    baseSourceFrame_.store(sourceFrame, std::memory_order_relaxed);
    playedOutputFrames_.store(0, std::memory_order_relaxed);
    decoder_->cancel();
    {
        std::lock_guard lock(mutex_);
        seekFrame_ = sourceFrame;
        seekRequested_ = true;
    }
    cv_.notify_all();
}
void MediaSource::setRate(float rate) noexcept {
    rate_.store(std::clamp(rate, 0.5F, 1.5F), std::memory_order_relaxed);
    requestWake();
}
void MediaSource::setTranspose(float semitones) noexcept {
    transpose_.store(std::clamp(semitones, -12.0F, 12.0F), std::memory_order_relaxed);
    requestWake();
}
void MediaSource::setLoop(bool enabled, std::uint64_t startFrame, std::uint64_t endFrame) {
    if (enabled && endFrame <= startFrame)
        throw std::invalid_argument("loop end must be greater than start");
    loopStartFrame_.store(startFrame, std::memory_order_relaxed);
    loopEndFrame_.store(endFrame, std::memory_order_relaxed);
    loopEnabled_.store(enabled, std::memory_order_release);
    if (enabled) {
        const auto position = snapshot().sourcePositionFrames;
        if (position < startFrame || position >= endFrame)
            seek(startFrame);
    }
    requestWake();
}
std::uint32_t MediaSource::render(std::span<float> output, std::uint32_t frames) noexcept {
    const auto channels = outputChannels_;
    const auto count = static_cast<std::size_t>(frames) * channels;
    if (output.size() < count)
        return 0;
    if (state_.load(std::memory_order_acquire) != PlaybackState::Playing) {
        std::fill_n(output.data(), count, 0.0F);
        return 0;
    }
    const auto read = ring_.pop(output, frames);
    if (read < frames) {
        std::fill(output.begin() + static_cast<std::ptrdiff_t>(read * channels),
                  output.begin() + static_cast<std::ptrdiff_t>(count), 0.0F);
        underruns_.fetch_add(1, std::memory_order_relaxed);
    }
    playedOutputFrames_.fetch_add(read, std::memory_order_relaxed);
    const auto totalFrames = totalSourceFrames_.load(std::memory_order_acquire);
    if (read == 0 && ring_.availableFrames() == 0 && totalFrames != 0) {
        const auto pos =
            baseSourceFrame_.load(std::memory_order_relaxed) +
            static_cast<std::uint64_t>(
                static_cast<double>(playedOutputFrames_.load(std::memory_order_relaxed)) *
                rate_.load(std::memory_order_relaxed));
        if (pos >= totalFrames)
            state_.store(PlaybackState::Finished, std::memory_order_release);
    }
    requestWake();
    return read;
}

PlaybackState MediaSource::waitUntilReady() {
    std::unique_lock lock(mutex_);
    cv_.wait(lock, [&] {
        const auto state = state_.load(std::memory_order_acquire);
        constexpr std::array completedStates{PlaybackState::Ready, PlaybackState::Failed,
                                             PlaybackState::Empty};
        return std::ranges::find(completedStates, state) != completedStates.end();
    });
    return state_.load(std::memory_order_acquire);
}
MediaSourceSnapshot MediaSource::snapshot() const noexcept {
    const auto played = playedOutputFrames_.load(std::memory_order_relaxed);
    const auto rate = rate_.load(std::memory_order_relaxed);
    const auto base = baseSourceFrame_.load(std::memory_order_relaxed);
    auto position = base + static_cast<std::uint64_t>(static_cast<double>(played) * rate);
    if (loopEnabled_.load(std::memory_order_acquire)) {
        const auto startFrame = loopStartFrame_.load(std::memory_order_relaxed);
        const auto endFrame = loopEndFrame_.load(std::memory_order_relaxed);
        if (endFrame > startFrame && position >= endFrame) {
            position = startFrame + (position - startFrame) % (endFrame - startFrame);
        }
    }

    MediaSourceSnapshot result{
        state_.load(std::memory_order_acquire),
        generation_.load(std::memory_order_acquire),
        position,
        totalSourceFrames_.load(std::memory_order_acquire),
        ring_.availableFrames(),
        underruns_.load(std::memory_order_relaxed),
        rate,
        transpose_.load(std::memory_order_relaxed),
        failureCode_.load(std::memory_order_acquire),
        {},
    };
    while (failureLock_.test_and_set(std::memory_order_acquire)) {
        std::this_thread::yield();
    }
    result.failureMessage = failureMessage_;
    failureLock_.clear(std::memory_order_release);
    return result;
}

void MediaSource::setFailure(MediaFailureCode code, std::string_view message) noexcept {
    while (failureLock_.test_and_set(std::memory_order_acquire)) {
        std::this_thread::yield();
    }
    failureMessage_.fill('\0');
    const auto count = std::min(message.size(), failureMessage_.size() - 1U);
    std::copy_n(message.data(), count, failureMessage_.data());
    failureLock_.clear(std::memory_order_release);
    failureCode_.store(code, std::memory_order_release);
}

void MediaSource::clearFailure() noexcept {
    while (failureLock_.test_and_set(std::memory_order_acquire)) {
        std::this_thread::yield();
    }
    failureMessage_.fill('\0');
    failureLock_.clear(std::memory_order_release);
    failureCode_.store(MediaFailureCode::None, std::memory_order_release);
}

void MediaSource::requestWake() noexcept {
    cv_.notify_one();
}

bool MediaSource::waitForWorkerRequest(std::string& loadPath, bool& doLoad, bool& doSeek,
                                       bool& doUnload, std::uint64_t& seekFrame) {
    std::unique_lock lock(mutex_);
    cv_.wait(lock, [this] {
        const auto state = state_.load(std::memory_order_acquire);
        return terminate_ || unloadRequested_ || loadRequested_ || seekRequested_ ||
               (!decoderEof_ && state != PlaybackState::Empty && state != PlaybackState::Failed &&
                ring_.availableFrames() < ring_.capacityFrames() / 2U);
    });
    if (terminate_)
        return false;

    doUnload = unloadRequested_;
    unloadRequested_ = false;
    doLoad = loadRequested_;
    if (doLoad)
        loadPath = path_;
    loadRequested_ = false;
    doSeek = seekRequested_;
    if (doSeek)
        seekFrame = seekFrame_;
    seekRequested_ = false;
    return true;
}

void MediaSource::applyUnload() {
    decoder_->close();
    format_ = {};
    totalSourceFrames_.store(0, std::memory_order_release);
    decoderEof_ = false;
    decodeScratch_.clear();
    processScratch_.clear();
    mappedScratch_.clear();
    decoderFrame_ = 0;
    {
        std::lock_guard lock(mutex_);
        unloadCompleted_ = true;
    }
    cv_.notify_all();
}

void MediaSource::applyLoad(const std::string& loadPath) {
    format_ = decoder_->open(loadPath);
    if (format_.channels == 0 || format_.sampleRateHz == 0) {
        throw std::runtime_error("decoder returned invalid format");
    }
    totalSourceFrames_.store(format_.totalFrames, std::memory_order_release);
    decoderEof_ = false;
    constexpr std::uint32_t DecodeChunkFrames = 2048;
    decodeScratch_.assign(static_cast<std::size_t>(DecodeChunkFrames) * format_.channels, 0.0F);
    processScratch_.assign(static_cast<std::size_t>(DecodeChunkFrames * 4U) * outputChannels_,
                           0.0F);
    mappedScratch_.assign(static_cast<std::size_t>(DecodeChunkFrames) * outputChannels_, 0.0F);
    processor_.prepare(format_.sampleRateHz, outputSampleRateHz_, outputChannels_,
                       DecodeChunkFrames);
    decoderFrame_ = 0;
}

void MediaSource::applySeek(std::uint64_t seekFrame) {
    const auto target = std::min(seekFrame, format_.totalFrames);
    decoder_->seek(target);
    decoderFrame_ = target;
    decoderEof_ = false;
    processor_.reset();
}

void MediaSource::decodeChunk() {
    const auto state = state_.load(std::memory_order_acquire);
    constexpr std::array inactiveStates{PlaybackState::Empty, PlaybackState::Failed};
    if (std::ranges::find(inactiveStates, state) != inactiveStates.end() || format_.channels == 0) {
        return;
    }
    if (ring_.availableFrames() >= ring_.capacityFrames() * 3U / 4U)
        return;

    processor_.setRate(rate_.load(std::memory_order_relaxed));
    processor_.setTranspose(transpose_.load(std::memory_order_relaxed));

    const auto loopEnabled = loopEnabled_.load(std::memory_order_acquire);
    const auto loopStart = loopStartFrame_.load(std::memory_order_relaxed);
    const auto loopEnd = loopEndFrame_.load(std::memory_order_relaxed);
    if (loopEnabled && loopEnd > loopStart && decoderFrame_ >= loopEnd) {
        decoder_->seek(loopStart);
        decoderFrame_ = loopStart;
        processor_.reset();
    }

    constexpr std::uint32_t DecodeChunkFrames = 2048;
    auto requestedFrames = DecodeChunkFrames;
    if (loopEnabled && loopEnd > decoderFrame_) {
        requestedFrames = static_cast<std::uint32_t>(
            std::min<std::uint64_t>(requestedFrames, loopEnd - decoderFrame_));
    }

    const auto workGeneration = generation_.load(std::memory_order_acquire);
    const auto frames = decoder_->read(decodeScratch_, requestedFrames);
    if (workGeneration != generation_.load(std::memory_order_acquire))
        return;
    if (frames == 0) {
        decoderEof_ = true;
        return;
    }
    decoderFrame_ += frames;

    for (std::uint32_t frame = 0; frame < frames; ++frame) {
        for (std::uint32_t channel = 0; channel < outputChannels_; ++channel) {
            const auto sourceChannel = std::min(channel, format_.channels - 1U);
            mappedScratch_[static_cast<std::size_t>(frame) * outputChannels_ + channel] =
                decodeScratch_[static_cast<std::size_t>(frame) * format_.channels + sourceChannel];
        }
    }

    const auto produced = processor_.process(
        std::span<const float>{mappedScratch_.data(),
                               static_cast<std::size_t>(frames) * outputChannels_},
        frames, processScratch_);
    const auto samples = std::span<const float>{
        processScratch_.data(), static_cast<std::size_t>(produced) * outputChannels_};
    if (!ring_.push(workGeneration, samples, produced)) {
        std::this_thread::yield();
        return;
    }
    if (state_.load(std::memory_order_acquire) == PlaybackState::Loading) {
        state_.store(PlaybackState::Ready, std::memory_order_release);
        cv_.notify_all();
    }
}

void MediaSource::workerMain() noexcept {
    while (true) {
        std::string loadPath;
        bool doLoad = false;
        bool doSeek = false;
        bool doUnload = false;
        std::uint64_t seekFrame = 0;
        if (!waitForWorkerRequest(loadPath, doLoad, doSeek, doUnload, seekFrame))
            return;

        try {
            if (doUnload) {
                applyUnload();
                continue;
            }
            if (doLoad)
                applyLoad(loadPath);
            if (doSeek)
                applySeek(seekFrame);
            decodeChunk();
        } catch (const std::exception& error) {
            setFailure(MediaFailureCode::DecoderError, error.what());
            state_.store(PlaybackState::Failed, std::memory_order_release);
            cv_.notify_all();
        } catch (...) {
            setFailure(MediaFailureCode::Unknown, "non-standard media decoder exception");
            state_.store(PlaybackState::Failed, std::memory_order_release);
            cv_.notify_all();
        }
    }
}
