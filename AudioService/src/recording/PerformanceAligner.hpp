#pragma once

#include <cstdint>
#include <span>
#include <vector>

/**
 * Builds the saved performance on the song timeline. Heard live, a singer's own voice and remote
 * voices arrive later than the music they were sung to (device and network paths). The aligner
 * delays the whole performance by a constant lead and adds each voice earlier by its own lateness,
 * so the recording sounds as if everyone sang into one microphone.
 *
 * One accumulation ring: every block is added "into the future" at its aligned position and the
 * oldest block is read out. Realtime-safe after prepare(): no allocation, no locks.
 * Owner: RealtimeEngine, render thread only.
 */
class PerformanceAligner {
  public:
    void prepare(std::uint32_t channels, std::uint32_t leadFrames, std::uint32_t maxBlockFrames);
    void reset() noexcept;

    /** Adds a stream that is `lateFrames` behind the music in this block (music itself: 0). */
    void add(std::span<const float> samples, std::uint32_t frames, float gain,
             std::uint32_t lateFrames) noexcept;
    /** Reads the aligned block, `leadFrames()` behind the music currently rendered. */
    void read(std::span<float> output, std::uint32_t frames) noexcept;

    [[nodiscard]] std::uint32_t leadFrames() const noexcept { return leadFrames_; }

  private:
    std::vector<float> ring_;
    std::uint32_t channels_{0};
    std::uint32_t leadFrames_{0};
    std::uint32_t capacityFrames_{0};
    std::uint32_t readFrame_{0};
};
