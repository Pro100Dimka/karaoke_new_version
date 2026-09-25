#include "media/MediaController.hpp"
#include "media/DecoderFactory.hpp"

#include <array>
#include <ranges>
#include <stdexcept>

MediaController::MediaController() {
    for (auto& item : sources_) {
        item = std::make_unique<MediaSource>(createDefaultAudioDecoder());
    }
}

void MediaController::prepare(std::uint32_t sampleRateHz, std::uint32_t channels,
                              std::uint32_t bufferFrames) {
    sampleRateHz_ = sampleRateHz;
    channels_ = channels;
    bufferFrames_ = bufferFrames;
    for (auto& source : sources_) {
        source->prepareOutput(sampleRateHz_, channels_, bufferFrames_);
    }
}

MediaSource& MediaController::source(MediaSlot slot) {
    return *sources_[static_cast<std::size_t>(slot)];
}

const MediaSource& MediaController::source(MediaSlot slot) const {
    return *sources_[static_cast<std::size_t>(slot)];
}

namespace {
// Monitor-only companions of the karaoke foreground track (Music): each shares its transport (play,
// pause, stop, seek) but is mixed in separately from -- and, for the performance-mix recording tap,
// entirely excluded from -- whatever the foreground track itself produces. See RealtimeEngine::onRender.
constexpr std::array karaokeCompanionSlots{MediaSlot::ReferenceVocal, MediaSlot::Melody};
} // namespace

MediaSlot MediaController::foregroundSlot(MediaContext context) const {
    using ContextSlot = std::pair<MediaContext, MediaSlot>;
    constexpr std::array slots{
        ContextSlot{MediaContext::Karaoke, MediaSlot::Music},
        ContextSlot{MediaContext::EditorPreview, MediaSlot::Preview},
        ContextSlot{MediaContext::Radio, MediaSlot::Radio},
        ContextSlot{MediaContext::RecordingPreview, MediaSlot::RecordingPreview}};
    const auto match = std::ranges::find_if(
        slots, [context](const auto& entry) { return entry.first == context; });
    if (match == slots.end())
        throw std::logic_error("media context has no foreground source");
    return match->second;
}

void MediaController::load(MediaSlot slot, const std::string& path) {
    source(slot).load(path);
}

void MediaController::unload(MediaSlot slot) noexcept {
    source(slot).unload();
}

void MediaController::activate(MediaContext context) {
    if (context == MediaContext::None) {
        context_.store(MediaContext::None, std::memory_order_release);
        return;
    }

    const auto current = context_.load(std::memory_order_acquire);
    if (current == context)
        return;

    if (current == MediaContext::Radio) {
        source(MediaSlot::Radio).stop();
    } else if (context == MediaContext::Radio && current != MediaContext::None) {
        throw std::logic_error("Radio cannot replace an active foreground media context");
    }

    context_.store(context, std::memory_order_release);
}

void MediaController::play(MediaContext context) {
    activate(context);
    source(foregroundSlot(context)).play();
    if (context != MediaContext::Karaoke)
        return;

    constexpr std::array playableStates{PlaybackState::Ready, PlaybackState::Paused,
                                        PlaybackState::Finished};
    for (const auto slot : karaokeCompanionSlots) {
        if (std::ranges::find(playableStates, source(slot).snapshot().state) != playableStates.end())
            source(slot).play();
    }
}

void MediaController::pause(MediaContext context) {
    source(foregroundSlot(context)).pause();
    if (context != MediaContext::Karaoke)
        return;
    for (const auto slot : karaokeCompanionSlots) {
        if (source(slot).snapshot().state == PlaybackState::Playing)
            source(slot).pause();
    }
}

void MediaController::stop(MediaContext context) noexcept {
    if (context == MediaContext::None)
        return;
    source(foregroundSlot(context)).stop();
    if (context == MediaContext::Karaoke) {
        for (const auto slot : karaokeCompanionSlots)
            source(slot).stop();
    }
    if (context_.load(std::memory_order_acquire) == context) {
        context_.store(MediaContext::None, std::memory_order_release);
    }
}

void MediaController::seek(MediaContext context, std::uint64_t frame) {
    source(foregroundSlot(context)).seekTimelineFrame(frame);
    if (context != MediaContext::Karaoke)
        return;
    for (const auto slot : karaokeCompanionSlots) {
        if (source(slot).snapshot().state != PlaybackState::Empty)
            source(slot).seekTimelineFrame(frame);
    }
}

void MediaController::setRate(float rate) noexcept {
    constexpr std::array slots{MediaSlot::Music, MediaSlot::ReferenceVocal, MediaSlot::Melody,
                               MediaSlot::Preview};
    for (const auto slot : slots)
        source(slot).setRate(rate);
}

void MediaController::setTranspose(float semitones) noexcept {
    constexpr std::array slots{MediaSlot::Music, MediaSlot::ReferenceVocal, MediaSlot::Melody,
                               MediaSlot::Preview};
    for (const auto slot : slots)
        source(slot).setTranspose(semitones);
}

void MediaController::setPreviewLoop(bool enabled, std::uint64_t startFrame,
                                     std::uint64_t endFrame) {
    auto& preview = source(MediaSlot::Preview);
    preview.setLoop(enabled, preview.sourceFrameFromTimeline(startFrame),
                    preview.sourceFrameFromTimeline(endFrame));
}

std::uint32_t MediaController::render(MediaSlot slot, std::span<float> output,
                                      std::uint32_t frames) noexcept {
    return source(slot).render(output, frames);
}

MediaSourceSnapshot MediaController::snapshot(MediaSlot slot) const noexcept {
    return source(slot).snapshot();
}
std::uint64_t MediaController::timelineFrame(MediaSlot slot) const noexcept {
    return source(slot).timelineFrame();
}

PlaybackState MediaController::waitUntilReady(MediaSlot slot) {
    return source(slot).waitUntilReady();
}
