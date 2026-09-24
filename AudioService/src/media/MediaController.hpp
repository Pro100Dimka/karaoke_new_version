#pragma once

#include "media/MediaSource.hpp"

#include <array>
#include <atomic>
#include <cstdint>
#include <memory>
#include <span>
#include <string>

enum class MediaContext { None, Karaoke, EditorPreview, Radio, RecordingPreview };
enum class MediaSlot { Music, ReferenceVocal, Melody, Preview, Radio, RecordingPreview, Count };

class MediaController {
  public:
    MediaController();
    void prepare(std::uint32_t sampleRateHz, std::uint32_t channels, std::uint32_t bufferFrames);
    void load(MediaSlot slot, const std::string& path);
    void unload(MediaSlot slot) noexcept;
    void activate(MediaContext context);
    void play(MediaContext context);
    void pause(MediaContext context);
    void stop(MediaContext context) noexcept;
    void seek(MediaContext context, std::uint64_t frame);
    void setRate(float rate) noexcept;
    void setTranspose(float semitones) noexcept;
    void setPreviewLoop(bool enabled, std::uint64_t startFrame, std::uint64_t endFrame);
    [[nodiscard]] std::uint32_t render(MediaSlot slot, std::span<float> output,
                                       std::uint32_t frames) noexcept;
    [[nodiscard]] MediaSourceSnapshot snapshot(MediaSlot slot) const noexcept;
    [[nodiscard]] std::uint64_t timelineFrame(MediaSlot slot) const noexcept;
    [[nodiscard]] PlaybackState waitUntilReady(MediaSlot slot);
    [[nodiscard]] MediaContext context() const noexcept {
        return context_.load(std::memory_order_acquire);
    }

  private:
    MediaSource& source(MediaSlot slot);
    const MediaSource& source(MediaSlot slot) const;
    MediaSlot foregroundSlot(MediaContext context) const;
    std::array<std::unique_ptr<MediaSource>, static_cast<std::size_t>(MediaSlot::Count)> sources_;
    std::atomic<MediaContext> context_{MediaContext::None};
    std::uint32_t sampleRateHz_{0};
    std::uint32_t channels_{0};
    std::uint32_t bufferFrames_{0};
};
