#include "graph/Mixer.hpp"

#include <algorithm>

void Mixer::setGains(const MixerGains& gains) noexcept {
    microphone_.store(gains.microphone, std::memory_order_relaxed);
    music_.store(gains.music, std::memory_order_relaxed);
    reference_.store(gains.reference, std::memory_order_relaxed);
    preview_.store(gains.preview, std::memory_order_relaxed);
    radio_.store(gains.radio, std::memory_order_relaxed);
    remote_.store(gains.remote, std::memory_order_relaxed);
    master_.store(gains.master, std::memory_order_relaxed);
    melody_.store(gains.melody, std::memory_order_relaxed);
}
MixerGains Mixer::gains() const noexcept {
    return {microphone_.load(std::memory_order_relaxed), music_.load(std::memory_order_relaxed),
            reference_.load(std::memory_order_relaxed),  preview_.load(std::memory_order_relaxed),
            radio_.load(std::memory_order_relaxed),      remote_.load(std::memory_order_relaxed),
            master_.load(std::memory_order_relaxed),     melody_.load(std::memory_order_relaxed)};
}
void Mixer::clear(std::span<float> output) const noexcept {
    std::fill(output.begin(), output.end(), 0.0F);
}
void Mixer::add(std::span<float> output, std::span<const float> source, float gain) const noexcept {
    const auto count = std::min(output.size(), source.size());
    for (std::size_t i = 0; i < count; ++i)
        output[i] += source[i] * gain;
}
void Mixer::applyMaster(std::span<float> output) const noexcept {
    const auto gain = master_.load(std::memory_order_relaxed);
    for (auto& sample : output)
        sample = std::clamp(sample * gain, -1.0F, 1.0F);
}
