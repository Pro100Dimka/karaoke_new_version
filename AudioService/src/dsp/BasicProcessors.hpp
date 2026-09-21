#pragma once

#include "common/Types.hpp"
#include "dsp/AudioProcessor.hpp"

#include <array>
#include <atomic>
#include <cstdint>
#include <vector>

class HighPassProcessor final : public IAudioProcessor {
  public:
    void setCutoffHz(float cutoffHz) noexcept {
        cutoffHz_.store(cutoffHz, std::memory_order_relaxed);
    }
    void prepare(std::uint32_t sampleRateHz, std::uint32_t, std::uint32_t channels) override;
    void process(std::span<float> interleaved, std::uint32_t frames) noexcept override;
    void reset() noexcept override;
    [[nodiscard]] std::uint32_t latencyFrames() const noexcept override {
        return 0;
    }

  private:
    std::uint32_t sampleRateHz_{48000};
    std::uint32_t channels_{2};
    std::atomic<float> cutoffHz_{80.0F};
    std::array<float, MaxAudioChannels> previousInput_{};
    std::array<float, MaxAudioChannels> previousOutput_{};
};

class EqualizerProcessor final : public IAudioProcessor {
  public:
    void setLowGain(float gain) noexcept {
        lowGain_.store(gain, std::memory_order_relaxed);
    }
    void setMidGain(float gain) noexcept {
        midGain_.store(gain, std::memory_order_relaxed);
    }
    void setHighGain(float gain) noexcept {
        highGain_.store(gain, std::memory_order_relaxed);
    }
    void prepare(std::uint32_t sampleRateHz, std::uint32_t, std::uint32_t channels) override;
    void process(std::span<float> interleaved, std::uint32_t frames) noexcept override;
    void reset() noexcept override;
    [[nodiscard]] std::uint32_t latencyFrames() const noexcept override {
        return 0;
    }

  private:
    std::uint32_t sampleRateHz_{48000};
    std::uint32_t channels_{2};
    std::array<float, MaxAudioChannels> lowState_{};
    std::array<float, MaxAudioChannels> highState_{};
    std::atomic<float> lowGain_{1.0F};
    std::atomic<float> midGain_{1.0F};
    std::atomic<float> highGain_{1.0F};
};

class CompressorProcessor final : public IAudioProcessor {
  public:
    void setThreshold(float threshold) noexcept {
        threshold_.store(threshold, std::memory_order_relaxed);
    }
    void setRatio(float ratio) noexcept {
        ratio_.store(ratio, std::memory_order_relaxed);
    }
    void prepare(std::uint32_t sampleRateHz, std::uint32_t, std::uint32_t channels) override;
    void process(std::span<float> interleaved, std::uint32_t frames) noexcept override;
    void reset() noexcept override;
    [[nodiscard]] std::uint32_t latencyFrames() const noexcept override {
        return 0;
    }

  private:
    std::uint32_t sampleRateHz_{48000};
    std::uint32_t channels_{2};
    std::atomic<float> threshold_{1.0F};
    std::atomic<float> ratio_{1.0F};
    float envelope_{0.0F};
};

class GateProcessor final : public IAudioProcessor {
  public:
    void setThreshold(float threshold) noexcept {
        threshold_.store(threshold, std::memory_order_relaxed);
    }
    void setReleaseMs(float releaseMs) noexcept {
        releaseMs_.store(releaseMs, std::memory_order_relaxed);
    }
    void prepare(std::uint32_t sampleRateHz, std::uint32_t, std::uint32_t channels) override;
    void process(std::span<float> interleaved, std::uint32_t frames) noexcept override;
    void reset() noexcept override;
    [[nodiscard]] std::uint32_t latencyFrames() const noexcept override {
        return 0;
    }

  private:
    std::uint32_t sampleRateHz_{48000};
    std::uint32_t channels_{2};
    std::atomic<float> threshold_{0.0F};
    std::atomic<float> releaseMs_{80.0F};
    float gain_{1.0F};
};

class NoiseProcessor final : public IAudioProcessor {
  public:
    void setThreshold(float threshold) noexcept {
        threshold_.store(threshold, std::memory_order_relaxed);
    }
    void setReduction(float reduction) noexcept {
        reduction_.store(reduction, std::memory_order_relaxed);
    }
    void prepare(std::uint32_t, std::uint32_t, std::uint32_t channels) override {
        channels_ = channels;
    }
    void process(std::span<float> interleaved, std::uint32_t frames) noexcept override;
    void reset() noexcept override {}
    [[nodiscard]] std::uint32_t latencyFrames() const noexcept override {
        return 0;
    }

  private:
    std::uint32_t channels_{2};
    std::atomic<float> threshold_{0.0F};
    std::atomic<float> reduction_{1.0F};
};

class ReverbProcessor final : public IAudioProcessor {
  public:
    void setMix(float mix) noexcept {
        mix_.store(mix, std::memory_order_relaxed);
    }
    void setDecay(float decay) noexcept {
        decay_.store(decay, std::memory_order_relaxed);
    }
    void prepare(std::uint32_t sampleRateHz, std::uint32_t, std::uint32_t channels) override;
    void process(std::span<float> interleaved, std::uint32_t frames) noexcept override;
    void reset() noexcept override;
    [[nodiscard]] std::uint32_t latencyFrames() const noexcept override {
        return 0;
    }

  private:
    std::uint32_t channels_{2};
    std::array<std::vector<float>, 3> lines_;
    std::array<std::uint32_t, 3> positions_{};
    std::atomic<float> mix_{0.0F};
    std::atomic<float> decay_{0.45F};
};

class DelayProcessor final : public IAudioProcessor {
  public:
    void setMix(float mix) noexcept {
        mix_.store(mix, std::memory_order_relaxed);
    }
    void setFeedback(float feedback) noexcept {
        feedback_.store(feedback, std::memory_order_relaxed);
    }
    void setDelayMs(float delayMs) noexcept {
        delayMs_.store(delayMs, std::memory_order_relaxed);
    }
    void prepare(std::uint32_t sampleRateHz, std::uint32_t, std::uint32_t channels) override;
    void process(std::span<float> interleaved, std::uint32_t frames) noexcept override;
    void reset() noexcept override;
    [[nodiscard]] std::uint32_t latencyFrames() const noexcept override {
        return 0;
    }

  private:
    std::uint32_t sampleRateHz_{48000};
    std::uint32_t channels_{2};
    std::vector<float> delayLine_;
    std::uint32_t capacityFrames_{0};
    std::uint32_t writeFrame_{0};
    std::atomic<float> mix_{0.0F};
    std::atomic<float> feedback_{0.25F};
    std::atomic<float> delayMs_{120.0F};
};

class PitchShiftProcessor final : public IAudioProcessor {
  public:
    void setSemitones(float semitones) noexcept {
        semitones_.store(semitones, std::memory_order_relaxed);
    }
    void prepare(std::uint32_t sampleRateHz, std::uint32_t maxFrames,
                 std::uint32_t channels) override;
    void process(std::span<float> interleaved, std::uint32_t frames) noexcept override;
    void reset() noexcept override;
    [[nodiscard]] std::uint32_t latencyFrames() const noexcept override;

  private:
    [[nodiscard]] float readDelay(std::uint32_t channel, double delayFrames) const noexcept;
    std::uint32_t channels_{2};
    std::uint32_t windowFrames_{0};
    std::uint32_t capacityFrames_{0};
    std::uint64_t writeFrame_{0};
    double phase_{0.0};
    std::vector<float> delayLine_;
    std::atomic<float> semitones_{0.0F};
};
