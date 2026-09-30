#pragma once

#include <atomic>
#include <cstdint>
#include <span>

struct MixerGains {
    float microphone{1.0F};
    float music{1.0F};
    float reference{0.0F};
    float preview{1.0F};
    float radio{1.0F};
    float remote{1.0F};
    // The playback level: songs, guides, previews and radio. Voices (the microphone and remote
    // participants) never follow it; only their own knobs change them.
    float master{1.0F};
    // Synthesized rendering of the song's own extracted notes; monitor-only like reference, never
    // in the performance-mix recording tap (see RealtimeEngine::onRender).
    float melody{0.0F};
};

class Mixer {
  public:
    void setGains(const MixerGains& gains) noexcept;
    [[nodiscard]] MixerGains gains() const noexcept;
    void clear(std::span<float> output) const noexcept;
    void add(std::span<float> output, std::span<const float> source, float gain) const noexcept;
    /** Keeps the mix within full scale (the last safeguard against a clipping converter). */
    void clampToFullScale(std::span<float> output) const noexcept;

  private:
    std::atomic<float> microphone_{1.0F};
    std::atomic<float> music_{1.0F};
    std::atomic<float> reference_{0.0F};
    std::atomic<float> preview_{1.0F};
    std::atomic<float> radio_{1.0F};
    std::atomic<float> remote_{1.0F};
    std::atomic<float> master_{1.0F};
    std::atomic<float> melody_{0.0F};
};
