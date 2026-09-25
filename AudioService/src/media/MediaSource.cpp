#include "media/MediaSource.hpp"

#include <algorithm>
#include <array>
#include <cmath>
#include <limits>
#include <ranges>
#include <stdexcept>

namespace {
std::uint64_t frameNumber(double value) noexcept {
    if (value >= static_cast<double>(UINT64_MAX))
        return UINT64_MAX;
    return static_cast<std::uint64_t>(std::max(0.0, std::round(value)));
}
} // namespace

MediaSource::RenderPause::RenderPause(MediaSource& owner) noexcept : source(owner) {
    source.renderSuspended_.store(true);
    for (auto readers = source.renderReaders_.load(); readers != 0;
         readers = source.renderReaders_.load())
        source.renderReaders_.wait(readers);
}
MediaSource::RenderPause::~RenderPause() {
    source.renderSuspended_.store(false);
}

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
    decoder_->cancel();
    requestWake();
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
    std::unique_lock lock(mutex_);
    RenderPause renderPause(*this);
    const auto next = advanceGeneration();
    publishState(PlaybackState::Empty);
    decoder_->cancel();
    loadRequested_ = false;
    seekRequested_ = false;
    unloadRequested_ = true;
    unloadCompleted_ = false;
    requestedGeneration_ = next;
    requestWake();
    cv_.wait(lock, [this] { return unloadCompleted_ || terminate_; });
}
void MediaSource::prepareOutput(std::uint32_t outputSampleRateHz, std::uint32_t outputChannels,
                                std::uint32_t bufferFrames) {
    if (outputSampleRateHz == 0 || outputChannels == 0 || outputChannels > MaxAudioChannels ||
        bufferFrames == 0)
        throw std::invalid_argument("invalid media output configuration");
    const auto previousState = state_.load(std::memory_order_acquire);
    const auto previousPosition = snapshot().sourcePositionFrames;
    std::string previousPath;
    if (previousState != PlaybackState::Empty) {
        std::lock_guard lock(mutex_);
        previousPath = path_;
    }
    requestUnloadAndWait();
    {
        std::lock_guard lock(mutex_);
        RenderPause renderPause(*this);
        outputSampleRateHz_ = outputSampleRateHz;
        outputChannels_ = outputChannels;
        ring_.prepare(bufferFrames, outputChannels);
        ring_.reset(generation_.load(std::memory_order_acquire));
    }
    if (previousPath.empty())
        return;

    load(previousPath);
    if (waitUntilReady() != PlaybackState::Ready)
        return;
    if (previousPosition != 0)
        seek(previousPosition);
    if (previousState == PlaybackState::Playing) {
        play();
    } else if (previousState == PlaybackState::Paused) {
        play();
        pause();
    }
}
void MediaSource::load(std::string path) {
    if (path.empty() || outputSampleRateHz_ == 0 || outputChannels_ == 0 ||
        ring_.capacityFrames() == 0)
        throw std::invalid_argument("media source must be prepared before load");
    requestUnloadAndWait();
    std::lock_guard lock(mutex_);
    RenderPause renderPause(*this);
    const auto generation = advanceGeneration();
    ring_.reset(generation);
    clearFailure();
    sourcePosition_.store(0, std::memory_order_relaxed);
    publishState(PlaybackState::Loading);
    path_ = std::move(path);
    loadRequested_ = true;
    requestedGeneration_ = generation;
    requestWake();
}
void MediaSource::unload() noexcept {
    requestUnloadAndWait();
    std::lock_guard lock(mutex_);
    RenderPause renderPause(*this);
    ring_.reset(generation_.load(std::memory_order_acquire));
    sourcePosition_.store(0, std::memory_order_relaxed);
}
void MediaSource::play() {
    std::lock_guard lock(mutex_);
    RenderPause renderPause(*this);
    const auto state = state_.load(std::memory_order_acquire);
    constexpr std::array playableStates{PlaybackState::Ready, PlaybackState::Paused,
                                        PlaybackState::Finished};
    if (std::ranges::find(playableStates, state) == playableStates.end()) {
        throw std::logic_error("media must be Ready/Paused/Finished before Play");
    }
    if (state == PlaybackState::Finished)
        requestSeekLocked(0);
    publishState(PlaybackState::Playing);
    requestWake();
}
void MediaSource::pause() {
    std::lock_guard lock(mutex_);
    RenderPause renderPause(*this);
    if (state_.load(std::memory_order_acquire) != PlaybackState::Playing)
        throw std::logic_error("Pause requires Playing");
    publishState(PlaybackState::Paused);
}
void MediaSource::stop() noexcept {
    std::lock_guard lock(mutex_);
    RenderPause renderPause(*this);
    const auto state = state_.load(std::memory_order_acquire);
    if (state == PlaybackState::Empty)
        return;
    requestSeekLocked(0);
    publishState(PlaybackState::Ready);
}
void MediaSource::seek(std::uint64_t sourceFrame) {
    std::lock_guard lock(mutex_);
    RenderPause renderPause(*this);
    if (state_.load(std::memory_order_acquire) == PlaybackState::Empty)
        throw std::logic_error("cannot seek empty source");
    requestSeekLocked(static_cast<double>(sourceFrame));
}
void MediaSource::requestSeekLocked(double sourceFrame) noexcept {
    const auto total = totalSourceFrames_.load(std::memory_order_acquire);
    if (total != 0)
        sourceFrame = std::min(sourceFrame, static_cast<double>(total));
    const auto next = advanceGeneration();
    ring_.reset(next);
    sourcePosition_.store(sourceFrame, std::memory_order_relaxed);
    decoder_->cancel();
    seekFrame_ = frameNumber(sourceFrame);
    seekRequested_ = true;
    requestedGeneration_ = next;
    requestWake();
}
std::uint64_t MediaSource::sourceFrameFromTimeline(std::uint64_t outputFrame) const noexcept {
    const auto outputRate = outputSampleRateHz_.load(std::memory_order_relaxed);
    return outputRate == 0
               ? 0
               : frameNumber(static_cast<double>(outputFrame) *
                             sourceSampleRateHz_.load(std::memory_order_relaxed) / outputRate);
}
void MediaSource::seekTimelineFrame(std::uint64_t outputFrame) {
    seek(sourceFrameFromTimeline(outputFrame));
}
void MediaSource::setRate(float rate) noexcept {
    if (!std::isfinite(rate))
        return;
    std::lock_guard lock(mutex_);
    RenderPause renderPause(*this);
    rate = std::clamp(rate, 0.5F, 1.5F);
    if (rate_.exchange(rate, std::memory_order_relaxed) == rate)
        return;
    if (state_.load(std::memory_order_acquire) != PlaybackState::Empty)
        requestSeekLocked(sourcePosition_.load(std::memory_order_relaxed));
}
void MediaSource::setTranspose(float semitones) noexcept {
    if (!std::isfinite(semitones))
        return;
    std::lock_guard lock(mutex_);
    RenderPause renderPause(*this);
    semitones = std::clamp(semitones, -12.0F, 12.0F);
    if (transpose_.exchange(semitones, std::memory_order_relaxed) == semitones)
        return;
    if (state_.load(std::memory_order_acquire) != PlaybackState::Empty)
        requestSeekLocked(sourcePosition_.load(std::memory_order_relaxed));
}
void MediaSource::setLoop(bool enabled, std::uint64_t startFrame, std::uint64_t endFrame) {
    std::lock_guard lock(mutex_);
    RenderPause renderPause(*this);
    const auto total = totalSourceFrames_.load(std::memory_order_acquire);
    if (enabled && total != 0)
        endFrame = std::min(endFrame, total);
    if (enabled && endFrame <= startFrame)
        throw std::invalid_argument("loop end must be greater than start");
    loopStartFrame_.store(startFrame, std::memory_order_relaxed);
    loopEndFrame_.store(endFrame, std::memory_order_relaxed);
    loopEnabled_.store(enabled, std::memory_order_release);
    if (state_.load(std::memory_order_acquire) != PlaybackState::Empty) {
        const auto position = snapshot().sourcePositionFrames;
        requestSeekLocked(static_cast<double>(
            enabled && (position < startFrame || position >= endFrame) ? startFrame : position));
    }
    requestWake();
}
std::uint32_t MediaSource::render(std::span<float> output, std::uint32_t frames) noexcept {
    renderReaders_.fetch_add(1);
    struct Lease {
        MediaSource& source;
        ~Lease() {
            if (source.renderReaders_.fetch_sub(1) == 1 && source.renderSuspended_.load())
                source.renderReaders_.notify_all();
        }
    } lease{*this};
    if (renderSuspended_.load()) {
        std::fill(output.begin(), output.end(), 0.0F);
        return 0;
    }
    const auto channels = outputChannels_;
    const auto count = static_cast<std::size_t>(frames) * channels;
    if (output.size() < count)
        return 0;
    if (state_.load(std::memory_order_acquire) != PlaybackState::Playing) {
        std::fill_n(output.data(), count, 0.0F);
        return 0;
    }
    const auto generation = generation_.load(std::memory_order_acquire);
    const auto read = ring_.pop(output, frames);
    if (read < frames) {
        std::fill(output.begin() + static_cast<std::ptrdiff_t>(read * channels),
                  output.begin() + static_cast<std::ptrdiff_t>(count), 0.0F);
        if (eofGeneration_.load(std::memory_order_acquire) != generation)
            underruns_.fetch_add(1, std::memory_order_relaxed);
    }
    static_assert(std::atomic<double>::is_always_lock_free);
    auto position = sourcePosition_.load(std::memory_order_relaxed) +
                    static_cast<double>(read) * rate_.load(std::memory_order_relaxed) *
                        sourceSampleRateHz_.load(std::memory_order_relaxed) / outputSampleRateHz_;
    const auto loopStart = loopStartFrame_.load(std::memory_order_relaxed);
    const auto loopEnd = loopEndFrame_.load(std::memory_order_relaxed);
    if (loopEnabled_.load(std::memory_order_acquire) && loopEnd > loopStart && position >= loopEnd)
        position = static_cast<double>(loopStart) +
                   std::fmod(position - loopStart, static_cast<double>(loopEnd - loopStart));
    const auto total = totalSourceFrames_.load(std::memory_order_acquire);
    sourcePosition_.store(total != 0 ? std::min(position, static_cast<double>(total)) : position,
                          std::memory_order_relaxed);
    if (ring_.availableFrames() == 0 &&
        eofGeneration_.load(std::memory_order_acquire) == generation &&
        generation_.load(std::memory_order_acquire) == generation)
        publishState(PlaybackState::Finished);
    requestWake();
    return read;
}

PlaybackState MediaSource::waitUntilReady() {
    for (;;) {
        const auto state = state_.load(std::memory_order_acquire);
        constexpr std::array completedStates{PlaybackState::Ready, PlaybackState::Failed,
                                             PlaybackState::Empty};
        if (std::ranges::find(completedStates, state) != completedStates.end())
            return state;
        state_.wait(state, std::memory_order_acquire);
    }
}
void MediaSource::publishState(PlaybackState state) noexcept {
    state_.store(state, std::memory_order_release);
    state_.notify_all();
}
MediaSourceSnapshot MediaSource::snapshot() const noexcept {
    const auto rate = rate_.load(std::memory_order_relaxed);
    const auto position = frameNumber(sourcePosition_.load(std::memory_order_relaxed));

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
std::uint64_t MediaSource::timelineFrame() const noexcept {
    const auto sourceRate = sourceSampleRateHz_.load(std::memory_order_relaxed);
    return sourceRate == 0
               ? 0
               : frameNumber(sourcePosition_.load(std::memory_order_relaxed) *
                             outputSampleRateHz_.load(std::memory_order_relaxed) / sourceRate);
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
    wakeEpoch_.fetch_add(1, std::memory_order_release);
    wakeEpoch_.notify_one();
}

bool MediaSource::waitForWorkerRequest(std::string& loadPath, bool& doLoad, bool& doSeek,
                                       bool& doUnload, std::uint64_t& seekFrame,
                                       SourceGenerationId& requestGeneration) {
    std::unique_lock lock(mutex_);
    for (;;) {
        const auto epoch = wakeEpoch_.load(std::memory_order_acquire);
        const auto state = state_.load(std::memory_order_acquire);
        const auto work = terminate_ || unloadRequested_ || loadRequested_ || seekRequested_ ||
                          ((!decoderEof_ || pendingFrames_ != 0) && state != PlaybackState::Empty &&
                           state != PlaybackState::Failed &&
                           ring_.availableFrames() <= (ring_.capacityFrames() - 1U) / 2U);
        if (work)
            break;
        lock.unlock();
        wakeEpoch_.wait(epoch, std::memory_order_acquire);
        lock.lock();
    }
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
    requestGeneration = requestedGeneration_;
    return true;
}

void MediaSource::applyUnload() {
    decoder_->close();
    format_ = {};
    totalSourceFrames_.store(0, std::memory_order_release);
    sourceSampleRateHz_.store(0, std::memory_order_relaxed);
    decoderEof_ = false;
    decodeScratch_.clear();
    processScratch_.clear();
    mappedScratch_.clear();
    decoderFrame_ = 0;
    pendingFrames_ = pendingOffsetFrames_ = 0;
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
    sourceSampleRateHz_.store(format_.sampleRateHz, std::memory_order_release);
    decoderEof_ = false;
    constexpr std::uint32_t MaximumDecodeChunkFrames = 2048;
    decodeChunkFrames_ =
        static_cast<std::uint32_t>(std::clamp(static_cast<double>(ring_.capacityFrames()) * 0.5 *
                                                  format_.sampleRateHz / outputSampleRateHz_,
                                              1.0, static_cast<double>(MaximumDecodeChunkFrames)));
    processor_.prepare(format_.sampleRateHz, outputSampleRateHz_, outputChannels_,
                       decodeChunkFrames_);
    constexpr std::size_t MaximumDecodeBufferBytes = 32U * 1024U * 1024U;
    const auto decodeSamples = static_cast<std::size_t>(decodeChunkFrames_) * format_.channels;
    const auto processSamples =
        static_cast<std::size_t>(processor_.maximumOutputFrames()) * outputChannels_;
    if (std::max(decodeSamples, processSamples) > MaximumDecodeBufferBytes / sizeof(float))
        throw std::length_error("Decoded media format exceeds bounded buffer capacity");
    decodeScratch_.assign(decodeSamples, 0.0F);
    processScratch_.assign(processSamples, 0.0F);
    mappedScratch_.assign(static_cast<std::size_t>(decodeChunkFrames_) * outputChannels_, 0.0F);
    pendingFrames_ = pendingOffsetFrames_ = 0;
    decoderFrame_ = 0;
}

void MediaSource::applySeek(std::uint64_t seekFrame) {
    const auto target =
        format_.totalFrames == 0 ? seekFrame : std::min(seekFrame, format_.totalFrames);
    decoder_->seek(target);
    decoderFrame_ = target;
    decoderEof_ = false;
    pendingFrames_ = pendingOffsetFrames_ = 0;
    processor_.reset();
}

void MediaSource::publishPendingPcm() noexcept {
    std::lock_guard lock(mutex_);
    if (decodeGeneration_ != generation_.load(std::memory_order_acquire)) {
        pendingFrames_ = pendingOffsetFrames_ = 0;
        return;
    }
    const auto freeFrames = ring_.capacityFrames() - ring_.availableFrames();
    const auto frames = std::min(pendingFrames_, freeFrames);
    if (frames != 0) {
        const auto samples = std::span<const float>{
            processScratch_.data() +
                static_cast<std::size_t>(pendingOffsetFrames_) * outputChannels_,
            static_cast<std::size_t>(frames) * outputChannels_};
        if (!ring_.push(decodeGeneration_, samples, frames))
            return;
        pendingFrames_ -= frames;
        pendingOffsetFrames_ += frames;
        if (state_.load(std::memory_order_acquire) == PlaybackState::Loading)
            publishState(PlaybackState::Ready);
    }
    if (decoderEof_ && pendingFrames_ == 0) {
        eofGeneration_.store(decodeGeneration_, std::memory_order_release);
        if (state_.load(std::memory_order_acquire) == PlaybackState::Loading)
            publishState(PlaybackState::Ready);
    }
}

void MediaSource::decodeChunk() {
    const auto state = state_.load(std::memory_order_acquire);
    constexpr std::array inactiveStates{PlaybackState::Empty, PlaybackState::Failed};
    if (std::ranges::find(inactiveStates, state) != inactiveStates.end() || format_.channels == 0) {
        return;
    }
    if (pendingFrames_ != 0 || decoderEof_) {
        publishPendingPcm();
        return;
    }
    processor_.setRate(rate_.load(std::memory_order_relaxed));
    processor_.setTranspose(transpose_.load(std::memory_order_relaxed));

    const auto loopEnabled = loopEnabled_.load(std::memory_order_acquire);
    const auto loopStart = loopStartFrame_.load(std::memory_order_relaxed);
    const auto loopEnd = loopEndFrame_.load(std::memory_order_relaxed);
    if (loopEnabled && loopEnd > loopStart && decoderFrame_ >= loopEnd) {
        decoder_->seek(loopStart);
        decoderFrame_ = loopStart;
    }

    auto requestedFrames = decodeChunkFrames_;
    if (loopEnabled && loopEnd > decoderFrame_) {
        requestedFrames = static_cast<std::uint32_t>(
            std::min<std::uint64_t>(requestedFrames, loopEnd - decoderFrame_));
    }

    const auto workGeneration = decodeGeneration_;
    const auto frames = decoder_->read(decodeScratch_, requestedFrames);
    if (workGeneration != generation_.load(std::memory_order_acquire))
        return;
    if (frames == 0) {
        decoderEof_ = true;
        pendingFrames_ = processor_.process({}, 0, processScratch_);
        pendingOffsetFrames_ = 0;
        publishPendingPcm();
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
    pendingFrames_ = produced;
    pendingOffsetFrames_ = 0;
    publishPendingPcm();
}

void MediaSource::workerMain() noexcept {
    while (true) {
        std::string loadPath;
        bool doLoad = false;
        bool doSeek = false;
        bool doUnload = false;
        std::uint64_t seekFrame = 0;
        SourceGenerationId requestGeneration{0};
        if (!waitForWorkerRequest(loadPath, doLoad, doSeek, doUnload, seekFrame,
                                  requestGeneration)) {
            decoder_->close(); // Release thread-affine decoder resources on their owning worker.
            return;
        }

        try {
            if (doUnload) {
                applyUnload();
                continue;
            }
            if (doLoad || doSeek)
                decodeGeneration_ = requestGeneration;
            if (doLoad)
                applyLoad(loadPath);
            if (doSeek)
                applySeek(seekFrame);
            decodeChunk();
        } catch (const std::exception& error) {
            std::lock_guard lock(mutex_);
            if (decodeGeneration_ == generation_.load(std::memory_order_acquire)) {
                setFailure(MediaFailureCode::DecoderError, error.what());
                publishState(PlaybackState::Failed);
            }
        } catch (...) {
            std::lock_guard lock(mutex_);
            if (decodeGeneration_ == generation_.load(std::memory_order_acquire)) {
                setFailure(MediaFailureCode::Unknown, "non-standard media decoder exception");
                publishState(PlaybackState::Failed);
            }
        }
    }
}
