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
    float master{1.0F};
    // Synthesized rendering of the song's own extracted notes; monitor-only like reference, never in the
    // performance-mix recording tap (see RealtimeEngine::onRender).
    float melody{0.0F};
};

class Mixer {
  public:
    void setGains(const MixerGains& gains) noexcept;
    [[nodiscard]] MixerGains gains() const noexcept;
    void clear(std::span<float> output) const noexcept;
    void add(std::span<float> output, std::span<const float> source, float gain) const noexcept;
    void applyMaster(std::span<float> output) const noexcept;

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
