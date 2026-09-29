#pragma once

#include "realtime/VoiceLoudness.hpp"

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
#include "diagnostics/AcousticLatencyMeter.hpp"
#include "diagnostics/PassiveLatencyEstimator.hpp"
#include "recording/PerformanceAligner.hpp"
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
    std::uint64_t presentationJumps{0};      // device presentation times that broke continuity
    MonotonicTicks presentationJumpMaxNs{0}; // largest such break
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
    /** Round-trip latency the devices do not report, measured acoustically (speaker to microphone).
     * A singer's voice is timestamped earlier by this amount so it lands on the music it was sung to. */
    /** Windows volume for an output that bypasses the Windows mixer (see SystemVolumeFollower). */
    void setSystemGain(float gain) noexcept { systemGain_.store(gain, std::memory_order_relaxed); }
    [[nodiscard]] float systemGain() const noexcept { return systemGain_.load(std::memory_order_relaxed); }
    void setAcousticLatency(MonotonicTicks nanoseconds) noexcept {
        acousticLatencyNs_.store(std::max<MonotonicTicks>(0, nanoseconds), std::memory_order_relaxed);
    }
    /**
     * Room follow (see NetworkAudioEngine::setFollowedParticipant): the song plays the leader's
     * voice delay later. Reported playback positions stay on the room timeline, so everyone's
     * timers keep agreeing.
     */
    [[nodiscard]] std::uint32_t roomFollowFrames() const noexcept {
        return roomFollowFrames_.load(std::memory_order_relaxed);
    }
    [[nodiscard]] MonotonicTicks roomFollowTicks() const noexcept {
        return roomFollowTicks_.load(std::memory_order_relaxed);
    }
    /** Starts an acoustic latency measurement (quiet chirps through speaker and microphone). */
    [[nodiscard]] bool startAcousticLatencyMeasurement() noexcept { return latencyMeter_.start(); }
    [[nodiscard]] MonotonicTicks acousticLatencyNs() const noexcept {
        return acousticLatencyNs_.load(std::memory_order_relaxed);
    }
    /** Control thread: the last completed acoustic measurement. */
    [[nodiscard]] PassiveLatencySnapshot passiveLatency() const noexcept {
        return passiveLatency_.snapshot();
    }
    [[nodiscard]] AcousticLatencyMeter::Result lastAcousticLatency() const noexcept {
        return latencyMeter_.lastResult();
    }
    /**
     * How old the newest captured packet was when it reached the engine, by the driver's own
     * capture timestamp. Implausible values expose a driver that stamps packets wrongly, which
     * the acoustic measurement would otherwise report as hidden latency.
     */
    [[nodiscard]] float musicTrim() const noexcept { return musicTrimPublished_.load(std::memory_order_relaxed); }
    [[nodiscard]] float ownVoiceRms() const noexcept { return ownVoice_.rms(); }
    /** How far the latest driver capture stamp lay beyond the physically possible moment. */
    [[nodiscard]] MonotonicTicks captureStampCorrectionNs() const noexcept {
        return captureStampCorrectionNs_.load(std::memory_order_relaxed);
    }
    [[nodiscard]] MonotonicTicks captureAgeNs() const noexcept {
        return captureAgeNs_.load(std::memory_order_relaxed);
    }
    /** Control thread: completes a recorded measurement and reports its state. */
    [[nodiscard]] AcousticLatencyMeter::State pollAcousticLatency(AcousticLatencyMeter::Result& result) {
        return latencyMeter_.poll(result);
    }
    /** Frames the saved performance trails the rendered music (the alignment lead). */
    [[nodiscard]] std::uint32_t performanceLeadFrames() const noexcept {
        return aligner_.leadFrames();
    }
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
    void renderTone(std::span<float> output, std::uint32_t frames, float level) noexcept;
    [[nodiscard]] std::uint32_t followRoomDelay(std::uint32_t targetFrames) noexcept;
    void notePresentationContinuity(MonotonicTicks presentationTicks, std::uint32_t frames) noexcept;
    void publishOutputLatency(MonotonicTicks presentationTicks, MonotonicTicks renderAt) noexcept;
    [[nodiscard]] double meanBridgeFillFrames(std::uint32_t fillBeforePullFrames,
                                              MonotonicTicks renderAt) const noexcept;
    [[nodiscard]] std::uint32_t smoothBridgeLatencyFrames(double meanFillFrames) noexcept;
    [[nodiscard]] MonotonicTicks micCapturedAt(std::uint32_t bridgeFillBeforePullFrames) const noexcept;
    [[nodiscard]] MonotonicTicks voiceSungAt(std::uint32_t bridgeFillBeforePullFrames) const noexcept;
    [[nodiscard]] std::uint32_t smoothVoiceLateFrames(MonotonicTicks presentationTicks,
                                                      MonotonicTicks sungAt) noexcept;
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
    std::uint32_t renderedToneDurationFrames_{0};
    float renderedToneFrequencyHz_{0.0F};
    float renderedToneGain_{0.0F};
    double tonePhase_{0.0};
    std::atomic<std::int64_t> lastCapturePosition_{-1};
    std::atomic<std::int64_t> lastCaptureTimestamp_{-1};
    // Steady-clock nanoseconds of the latest bridge push; written by capture, read by render.
    std::atomic<MonotonicTicks> capturePushedAt_{0};
    // Device capture time just after the newest sample in the clock bridge; 0 when the backend
    // cannot report capture times. Written by capture, read by render.
    std::atomic<MonotonicTicks> capturedEndTicks_{0};
    std::atomic<MonotonicTicks> acousticLatencyNs_{0};
    std::atomic<float> systemGain_{1.0F};
    std::atomic<MonotonicTicks> captureAgeNs_{0};
    std::atomic<MonotonicTicks> captureStampCorrectionNs_{0};
    MonotonicTicks nextPresentationTicks_{0}; // render thread
    std::atomic<std::uint64_t> presentationJumps_{0};
    std::atomic<MonotonicTicks> presentationJumpMaxNs_{0};
    bool songUnderway_{false};              // render thread: sounded since it last stopped
    VoiceLoudness ownVoice_;                // this singer's level while singing (render thread notes)
    // Backing-track gain that starts each song as loud as the quietest voice heard (render thread).
    float musicTrim_{1.0F};
    std::atomic<float> musicTrimPublished_{1.0F};
    std::uint32_t followAppliedFrames_{0};  // render thread
    std::atomic<std::uint32_t> roomFollowFrames_{0}; // written by render
    std::atomic<MonotonicTicks> roomFollowTicks_{0};  // written by render
    PerformanceAligner aligner_;           // render thread only
    AcousticLatencyMeter latencyMeter_;
    PassiveLatencyEstimator passiveLatency_; // hidden latency from the song the microphone hears
    double voiceLateFrames_{-1.0};         // render thread only; negative until measured
    MonotonicTicks lastRenderAt_{0};                 // render thread only
    std::uint32_t bridgeFillAfterRenderFrames_{0};   // render thread only
    double bridgeLatencyFrames_{-1.0};               // render thread only; negative until measured
};
