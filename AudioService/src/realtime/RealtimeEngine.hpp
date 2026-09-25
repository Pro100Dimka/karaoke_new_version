#pragma once

#include "analysis/AnalysisEngine.hpp"
#include "analysis/OutputSpectrum.hpp"
#include "analysis/SignalMetrics.hpp"
#include "backend/IAudioBackend.hpp"
#include "clock/ClockBridge.hpp"
#include "clock/ClockSynchronizer.hpp"
#include "common/Types.hpp"
#include "diagnostics/GraphIntrospection.hpp"
#include "diagnostics/LatencyRegistry.hpp"
#include "diagnostics/TraceBuffer.hpp"
#include "dsp/DspChain.hpp"
#include "graph/Mixer.hpp"
#include "media/MediaController.hpp"
#include "network/NetworkAudioEngine.hpp"
#include "realtime/RealtimeBufferPool.hpp"
#include "realtime/RealtimeInstrumentation.hpp"
#include "realtime/PcmRingBuffer.hpp"
#include "recording/RecordingEngine.hpp"

#include <array>
#include <atomic>
#include <cstdint>
#include <span>
#include <string_view>
#include <vector>

struct PendingBackendEvent {
    GenerationId generation{0};
    BackendEventType type{BackendEventType::None};
    std::int32_t code{0};
    std::uint64_t sequence{0};
};

struct RealtimeSnapshot {
    SessionFrame sessionFrame{0};
    double driftPpm{0.0};
    double correctionRatio{1.0};
    ClockBridgeSnapshot clockBridge{};
    std::uint64_t staleCallbacks{0};
    std::uint64_t captureOverruns{0};
    std::uint64_t renderUnderruns{0};
};

class RealtimeEngine final : public IAudioCallback {
  public:
    RealtimeEngine(MediaController& media, RecordingEngine& recording, AnalysisEngine& analysis,
                   NetworkAudioEngine& network, SignalMetrics& signal, LatencyRegistry& latency,
                   GraphIntrospection& graphInfo, TraceBuffer& trace);
    void prepare(const FinalSessionPlan& plan, GenerationId generation);
    void reset() noexcept;
    void invalidate(GenerationId generation) noexcept;
    void setMonitoring(bool enabled) noexcept {
        monitoring_.store(enabled, std::memory_order_relaxed);
    }
    void setMicrophoneEnabled(bool enabled) noexcept {
        microphoneEnabled_.store(enabled, std::memory_order_relaxed);
    }
    void setMixerGains(const MixerGains& gains) noexcept {
        mixer_.setGains(gains);
    }
    [[nodiscard]] MixerGains mixerGains() const noexcept {
        return mixer_.gains();
    }
    void setDspEnabled(bool enabled) noexcept;
    [[nodiscard]] bool setDspParameter(std::string_view name, float value) noexcept;
    void playReferenceTone(float frequencyHz, std::uint32_t durationFrames, float gain) noexcept;
    [[nodiscard]] OutputSpectrum::Levels outputSpectrum() const noexcept {
        return spectrum_.snapshot();
    }
    [[nodiscard]] OutputSpectrum::Levels backingSpectrum() const noexcept {
        return backingSpectrum_.snapshot();
    }
    [[nodiscard]] RealtimeSnapshot snapshot() const noexcept;
    [[nodiscard]] PendingBackendEvent pendingBackendEvent() const noexcept;
    void acknowledgeBackendEvent(std::uint64_t sequence) noexcept;
    [[nodiscard]] SessionFrame sessionFrame() const noexcept {
        return SessionFrame{sessionFrameValue_.load(std::memory_order_relaxed)};
    }

    void onCapture(GenerationId generation, const BackendAudioBuffer& buffer) noexcept override;
    void onRender(GenerationId generation, const BackendAudioBuffer& buffer) noexcept override;
    void onBackendEvent(GenerationId generation, BackendEventType event,
                        std::int32_t code) noexcept override;

  private:
    void mapMicrophone(std::span<const float> input, std::uint32_t inputChannels,
                       std::span<float> output, std::uint32_t outputChannels,
                       std::uint32_t frames) noexcept;
    void addMedia(MediaSlot slot, std::span<float> output, std::uint32_t frames,
                  float gain, MonotonicTicks presentationTicks = 0) noexcept;
    void renderTone(std::span<float> output, std::uint32_t frames) noexcept;
    void updateGraphSnapshot();

    MediaController& media_;
    RecordingEngine& recording_;
    AnalysisEngine& analysis_;
    NetworkAudioEngine& network_;
    SignalMetrics& signal_;
    OutputSpectrum spectrum_;
    OutputSpectrum backingSpectrum_;
    LatencyRegistry& latency_;
    GraphIntrospection& graphInfo_;
    TraceBuffer& trace_;
    FinalSessionPlan plan_{};
    std::atomic<GenerationId> generation_{GenerationId{0}};
    std::atomic<std::uint64_t> sessionFrameValue_{0};
    std::atomic<bool> monitoring_{false};
    std::atomic<bool> microphoneEnabled_{true};
    Mixer mixer_;
    DspChain dsp_;
    ClockBridge clockBridge_;
    ClockSynchronizer clocks_;
    RealtimeBufferPool buffers_;
    std::atomic<bool> dspEnabled_{false};
    std::atomic<std::uint64_t> staleCallbacks_{0};
    std::atomic<std::uint64_t> captureOverruns_{0};
    std::atomic<std::uint64_t> renderUnderruns_{0};
    std::atomic<GenerationId> backendEventGeneration_{GenerationId{0}};
    std::atomic<std::uint32_t> backendEventType_{
        static_cast<std::uint32_t>(BackendEventType::None)};
    std::atomic<std::int32_t> backendEventCode_{0};
    std::atomic<std::uint64_t> backendEventSequence_{0};
    std::atomic<std::uint64_t> acknowledgedBackendEventSequence_{0};
    std::atomic<float> toneFrequencyHz_{0.0F};
    std::atomic<float> toneGain_{0.0F};
    std::atomic<std::uint32_t> toneDurationFrames_{0};
    std::atomic<std::uint64_t> toneCommandSequence_{0};
    std::array<float, MaxAudioChannels> channelEnergy_{}; // capture thread only
    // The control thread publishes commands; only render advances oscillator state.
    std::uint64_t renderedToneSequence_{0};
    std::uint32_t toneFramesRemaining_{0};
    float renderedToneFrequencyHz_{0.0F};
    float renderedToneGain_{0.0F};
    double tonePhase_{0.0};
    std::atomic<std::int64_t> lastCapturePosition_{0};
    std::atomic<std::int64_t> lastCaptureTimestamp_{0};
};
