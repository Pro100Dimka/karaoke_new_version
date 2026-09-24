#include "dsp/DspChain.hpp"

#include <algorithm>

void DspChain::prepare(std::uint32_t sampleRateHz, std::uint32_t maxFrames,
                       std::uint32_t channels) {
    highPass_.prepare(sampleRateHz, maxFrames, channels);
    equalizer_.prepare(sampleRateHz, maxFrames, channels);
    compressor_.prepare(sampleRateHz, maxFrames, channels);
    gate_.prepare(sampleRateHz, maxFrames, channels);
    noise_.prepare(sampleRateHz, maxFrames, channels);
    reverb_.prepare(sampleRateHz, maxFrames, channels);
    delay_.prepare(sampleRateHz, maxFrames, channels);
    pitch_.prepare(sampleRateHz, maxFrames, channels);
}
void DspChain::reset() noexcept {
    highPass_.reset();
    equalizer_.reset();
    compressor_.reset();
    gate_.reset();
    noise_.reset();
    reverb_.reset();
    delay_.reset();
    pitch_.reset();
}
void DspChain::process(std::span<float> samples, std::uint32_t frames) noexcept {
    if (!enabled_.load(std::memory_order_relaxed))
        return;
    highPass_.process(samples, frames);
    equalizer_.process(samples, frames);
    compressor_.process(samples, frames);
    gate_.process(samples, frames);
    noise_.process(samples, frames);
    reverb_.process(samples, frames);
    delay_.process(samples, frames);
    pitch_.process(samples, frames);
}
bool DspChain::setParameter(std::string_view name, float value) noexcept {
    if (name == "echo.amount") {
        const auto amount = std::clamp(value, 0.0F, 1.0F);
        delay_.setMix(amount * 0.55F);
        delay_.setFeedback(amount * 0.75F);
        delay_.setDelayMs(110.0F);
    } else if (name == "noise.amount") {
        const auto amount = std::clamp(value, 0.0F, 1.0F);
        noise_.setThreshold(amount > 0.0F ? 0.02F : 0.0F);
        noise_.setReduction(1.0F - amount * 0.92F);
    } else if (name == "highpass.cutoffHz")
        highPass_.setCutoffHz(value);
    else if (name == "eq.lowGain")
        equalizer_.setLowGain(value);
    else if (name == "eq.midGain")
        equalizer_.setMidGain(value);
    else if (name == "eq.highGain")
        equalizer_.setHighGain(value);
    else if (name == "compressor.threshold")
        compressor_.setThreshold(value);
    else if (name == "compressor.ratio")
        compressor_.setRatio(value);
    else if (name == "gate.threshold")
        gate_.setThreshold(value);
    else if (name == "gate.releaseMs")
        gate_.setReleaseMs(value);
    else if (name == "noise.threshold")
        noise_.setThreshold(value);
    else if (name == "noise.reduction")
        noise_.setReduction(value);
    else if (name == "reverb.mix")
        reverb_.setMix(value);
    else if (name == "reverb.decay")
        reverb_.setDecay(value);
    else if (name == "delay.mix")
        delay_.setMix(value);
    else if (name == "delay.feedback")
        delay_.setFeedback(value);
    else if (name == "delay.ms")
        delay_.setDelayMs(value);
    else if (name == "pitch.semitones")
        pitch_.setSemitones(value);
    else
        return false;
    return true;
}
std::uint32_t DspChain::latencyFrames() const noexcept {
    return highPass_.latencyFrames() + equalizer_.latencyFrames() + compressor_.latencyFrames() +
           gate_.latencyFrames() + noise_.latencyFrames() + reverb_.latencyFrames() +
           delay_.latencyFrames() + pitch_.latencyFrames();
}
