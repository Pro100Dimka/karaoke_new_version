#pragma once

#include "realtime/VoiceLoudness.hpp"

#include "analysis/AnalysisEngine.hpp"
#include "analysis/OutputSpectrum.hpp"
#include "analysis/SignalMetrics.hpp"
#include "backend/IAudioBackend.hpp"
#include "clock/ClockBridge.hpp"
#include "clock/ClockSynchronizer.hpp"
#include "common/Types.hpp"
#include "diagnostics/AcousticLatencyMeter.hpp"
#include "diagnostics/GraphIntrospection.hpp"
#include "diagnostics/LatencyRegistry.hpp"
#include "diagnostics/PassiveLatencyEstimator.hpp"
#include "diagnostics/TraceBuffer.hpp"
#include "dsp/DspChain.hpp"
#include "graph/Mixer.hpp"
#include "media/MediaController.hpp"
#include "network/NetworkAudioEngine.hpp"
#include "realtime/PcmRingBuffer.hpp"
#include "realtime/RealtimeBufferPool.hpp"
#include "realtime/RealtimeInstrumentation.hpp"
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

// Frozen on the latest microphone pull shortfall. All times are steady-clock nanoseconds;
// eventObserved is when our thread noticed the event, not when Windows signalled it.
struct MicGapTimeline {
    std::uint64_t sequence{0};
    std::uint32_t missingFrames{0}, bridgeAvailableFrames{0}, requestedFrames{0};
    std::int64_t captureDevicePosition{0};
    std::uint64_t rawCaptureQpc100ns{0};
    MonotonicTicks lastEmptyPacketProbeNs{0}, captureEventObservedNs{0}, wakeObservedNs{0};
    MonotonicTicks getBufferStartedNs{0}, packetDeliveredNs{0}, engineProcessingStartedNs{0};
    MonotonicTicks bridgeInsertedNs{0}, renderWakeObservedNs{0},
        micConsumedForRenderNs{0}, renderSubmittedNs{0};
    MonotonicTicks presentationNs{0}, captureStampCorrectionNs{0};
    std::uint32_t captureEventGapUs{0}, packetQpcGapUs{0}, packetsThisWake{0},
        framesThisWake{0}, packetFrames{0}, renderWakePackets{0}, renderWakeFrames{0};
    std::uint32_t bridgeFillBeforeInsertFrames{0}, bridgeFillAfterInsertFrames{0};
};

struct RealtimeSnapshot {
    SessionFrame sessionFrame{0};
    double driftPpm{0.0};
    double correctionRatio{1.0};
    ClockBridgeSnapshot clockBridge{};
    std::uint64_t staleCallbacks{0};
    std::uint64_t captureOverruns{0};
    std::uint64_t renderUnderruns{0};
    std::uint64_t micCaptureSkippedFrames{0};
    std::uint64_t micCaptureRepeatedFrames{0};
    std::uint64_t micInsertedSilenceFrames{0};
    std::uint32_t micMonitoringAgeP50Us{0};
    std::uint32_t micMonitoringAgeP95Us{0};
    std::uint32_t micMonitoringAgeP99Us{0};
    std::uint32_t micMonitoringAgeMinUs{0};
    std::uint32_t micMonitoringAgeMaxUs{0};
    std::uint64_t presentationJumps{0};      // device presentation times that broke continuity
    MonotonicTicks presentationJumpMaxNs{0}; // largest such break
    std::uint64_t remoteMixNonzeroBlocks{0};
    float remoteMixPeak{0.0F};
    std::uint64_t masterOutputNonzeroBlocks{0};
    float masterOutputPeak{0.0F};
    std::uint32_t selectedInputChannel{0};
    std::array<float, MaxAudioChannels> inputChannelRms{};
};

class RealtimeEngine final : public IAudioCallback {
  public:
    RealtimeEngine(MediaController& media, RecordingEngine& recording, AnalysisEngine& analysis,
                   NetworkAudioEngine& network, SignalMetrics& signal, LatencyRegistry& latency,
                   GraphIntrospection& graphInfo, TraceBuffer& trace);
    void prepare(const FinalSessionPlan& plan, GenerationId generation);
    void reset() noexcept;
    void invalidate(GenerationId generation) noexcept;
    void setMonitoring(bool enabled, bool cautious = false) noexcept {
        cautiousMonitoring_.store(enabled && cautious, std::memory_order_relaxed);
        if (enabled)
            monitoringSafetyTripped_.store(false, std::memory_order_relaxed);
        if (monitoring_.exchange(enabled, std::memory_order_relaxed) != enabled) {
            monitoringSequence_.fetch_add(1, std::memory_order_relaxed);
            micMonitoringAgeCount_.store(0, std::memory_order_relaxed);
        }
    }
    [[nodiscard]] bool monitoring() const noexcept {
        return monitoring_.load(std::memory_order_relaxed);
    }
    [[nodiscard]] bool monitoringSafetyTripped() const noexcept {
        return monitoringSafetyTripped_.load(std::memory_order_relaxed);
    }
    [[nodiscard]] std::uint64_t monitoringSafetyTripFrame() const noexcept {
        return monitoringSafetyTripFrame_.load(std::memory_order_relaxed);
    }
    [[nodiscard]] float monitoringSafetyInputPeak() const noexcept {
        return monitoringSafetyInputPeak_.load(std::memory_order_relaxed);
    }
    void setMicrophoneEnabled(bool enabled) noexcept {
        microphoneEnabled_.store(enabled, std::memory_order_relaxed);
    }
    [[nodiscard]] bool microphoneEnabled() const noexcept {
        return microphoneEnabled_.load(std::memory_order_relaxed);
    }
    void setMixerGains(const MixerGains& gains) noexcept {
        mixer_.setGains(gains);
    }
    [[nodiscard]] MixerGains mixerGains() const noexcept {
        return mixer_.gains();
    }
    void setDspEnabled(bool enabled) noexcept;
    /** Round-trip latency the devices do not report, measured acoustically (speaker to microphone).
     * A singer's voice is timestamped earlier by this amount so it lands on the music it was sung
     * to. */
    /** Windows volume for an output that bypasses the Windows mixer (see SystemVolumeFollower). */
    void setSystemGain(float gain) noexcept {
        systemGain_.store(gain, std::memory_order_relaxed);
    }
    [[nodiscard]] float systemGain() const noexcept {
        return systemGain_.load(std::memory_order_relaxed);
    }
    void setAcousticLatency(MonotonicTicks nanoseconds) noexcept {
        acousticLatencyNs_.store(std::max<MonotonicTicks>(0, nanoseconds),
                                 std::memory_order_relaxed);
        acousticCalibrationValid_ = true;
    }
    [[nodiscard]] MonotonicTicks calibrationContext() const noexcept { return calibrationContext_; }
    [[nodiscard]] bool acousticCalibrationValid() const noexcept { return acousticCalibrationValid_; }
    [[nodiscard]] bool acceptsAcousticLatency(MonotonicTicks nanoseconds) const noexcept {
        return latencyMeter_.acceptsCalibration(nanoseconds);
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
    [[nodiscard]] bool startAcousticLatencyMeasurement() noexcept {
        return !monitoring_.load(std::memory_order_relaxed) && latencyMeter_.start();
    }
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
    [[nodiscard]] float ownVoiceRms() const noexcept {
        return ownVoice_.rms();
    }
    /** How far the latest driver capture stamp lay beyond the physically possible moment. */
    [[nodiscard]] MonotonicTicks captureStampCorrectionNs() const noexcept {
        return captureStampCorrectionNs_.load(std::memory_order_relaxed);
    }
    [[nodiscard]] MonotonicTicks captureStampDeliveredAtNs() const noexcept {
        return captureStampDeliveredAtNs_.load(std::memory_order_relaxed);
    }
    [[nodiscard]] MonotonicTicks captureStampCorrectedStartNs() const noexcept {
        return captureStampCorrectedStartNs_.load(std::memory_order_relaxed);
    }
    /**
     * How old the newest captured packet was when it reached the engine, by the driver's own
     * capture timestamp. Implausible values expose a driver that stamps packets wrongly, which
     * the acoustic measurement would otherwise report as hidden latency.
     */
    [[nodiscard]] MonotonicTicks captureAgeNs() const noexcept {
        return captureAgeNs_.load(std::memory_order_relaxed);
    }
    /** Control thread: completes a recorded measurement and reports its state. */
    [[nodiscard]] AcousticLatencyMeter::State
    pollAcousticLatency(AcousticLatencyMeter::Result& result) {
        return latencyMeter_.poll(result);
    }
    /** Frames the saved performance trails the rendered music (the alignment lead). */
    [[nodiscard]] std::uint32_t performanceLeadFrames() const noexcept {
        return aligner_.leadFrames();
    }
    [[nodiscard]] bool setDspParameter(std::string_view name, float value) noexcept;
    void playReferenceTone(float frequencyHz, std::uint32_t durationFrames, float gain) noexcept;
    /** Test-only deterministic capture source; the command handler guards access by environment. */
    void setDiagnosticRoomInput(bool enabled, float frequencyHz, float gain,
                                std::uint64_t musicalStartUnixMs = 0,
                                std::uint32_t markerPeriodMs = 500U) noexcept {
        diagnosticInputFrequencyHz_.store(frequencyHz, std::memory_order_relaxed);
        diagnosticInputGain_.store(gain, std::memory_order_relaxed);
        diagnosticInputMusicalStartUnixMs_.store(musicalStartUnixMs, std::memory_order_relaxed);
        diagnosticInputMarkerPeriodMs_.store(markerPeriodMs, std::memory_order_relaxed);
        diagnosticInputEnabled_.store(enabled, std::memory_order_release);
    }
    [[nodiscard]] OutputSpectrum::Levels outputSpectrum() const noexcept {
        return spectrum_.snapshot();
    }
    [[nodiscard]] OutputSpectrum::Levels backingSpectrum() const noexcept {
        return backingSpectrum_.snapshot();
    }
    [[nodiscard]] RealtimeSnapshot snapshot() const noexcept;
    [[nodiscard]] MicGapTimeline micGapTimeline() const noexcept;
    void onRenderSubmitted(MonotonicTicks submittedAt) noexcept override;
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
    void addMedia(MediaSlot slot, std::span<float> output, std::uint32_t frames, float gain,
                  MonotonicTicks presentationTicks = 0) noexcept;
    void renderTone(std::span<float> output, std::uint32_t frames, float level) noexcept;
    [[nodiscard]] std::uint32_t followRoomDelay(std::uint32_t targetFrames) noexcept;
    void notePresentationContinuity(MonotonicTicks presentationTicks,
                                    std::uint32_t frames) noexcept;
    void publishOutputLatency(MonotonicTicks presentationTicks, MonotonicTicks renderAt) noexcept;
    [[nodiscard]] double meanBridgeFillFrames(std::uint32_t fillBeforePullFrames,
                                              MonotonicTicks renderAt) const noexcept;
    [[nodiscard]] std::uint32_t smoothBridgeLatencyFrames(double meanFillFrames) noexcept;
    [[nodiscard]] MonotonicTicks
    micCapturedAt(std::uint32_t bridgeFillBeforePullFrames) const noexcept;
    [[nodiscard]] MonotonicTicks
    voiceSungAt(std::uint32_t bridgeFillBeforePullFrames) const noexcept;
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
    std::atomic<bool> cautiousMonitoring_{false};
    std::atomic<bool> monitoringSafetyTripped_{false};
    std::atomic<std::uint64_t> monitoringSafetyTripFrame_{0};
    std::atomic<float> monitoringSafetyInputPeak_{0.0F};
    std::atomic<std::uint64_t> monitoringSequence_{0};
    std::uint64_t renderedMonitoringSequence_{0}; // render thread only
    std::uint32_t monitorHighFrames_{0}; // render thread only
    float monitorStartupGain_{0.0F}; // render thread only
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
    std::atomic<std::int64_t> lastCaptureEndFrame_{-1};
    std::atomic<std::uint64_t> micCaptureSkippedFrames_{0};
    std::atomic<std::uint64_t> micCaptureRepeatedFrames_{0};
    std::atomic<std::uint64_t> micInsertedSilenceFrames_{0};
    // Capture publishes after a successful bridge push. Render freezes these observations on
    // the next shortfall; every field is atomic so control-thread reads never race realtime IO.
    std::atomic<std::uint64_t> captureRawQpc100ns_{0};
    std::atomic<MonotonicTicks> captureEventObservedNs_{0}, captureWakeObservedNs_{0},
        captureLastEmptyProbeNs_{0}, captureGetBufferStartedNs_{0}, capturePacketDeliveredNs_{0},
        captureEngineStartedNs_{0}, captureBridgeInsertedNs_{0};
    std::atomic<std::uint32_t> captureEventGapUs_{0}, capturePacketGapUs_{0},
        capturePacketsThisWake_{0}, captureFramesThisWake_{0},
        captureBridgeFillBeforeInsertFrames_{0}, captureBridgeFillAfterInsertFrames_{0};
    std::atomic<std::uint32_t> capturePacketFrames_{0};
    // A single writer (render) freezes the latest anomaly. Submission is filled after
    // ReleaseBuffer succeeds, on that same backend thread.
    std::atomic<std::uint64_t> micGapSerial_{0};
    std::atomic<std::uint64_t> micGapCount_{0};
    std::atomic<std::uint32_t> micGapMissingFrames_{0}, micGapBridgeAvailableFrames_{0},
        micGapRequestedFrames_{0};
    std::atomic<std::int64_t> micGapCaptureDevicePosition_{0};
    std::atomic<std::uint64_t> micGapRawQpc100ns_{0};
    std::atomic<MonotonicTicks> micGapLastEmptyProbeNs_{0}, micGapCaptureEventObservedNs_{0},
        micGapWakeObservedNs_{0}, micGapGetBufferStartedNs_{0}, micGapPacketDeliveredNs_{0},
        micGapEngineStartedNs_{0}, micGapBridgeInsertedNs_{0}, micGapRenderWakeNs_{0},
        micGapRenderConsumedNs_{0},
        micGapRenderSubmittedNs_{0}, micGapPresentationNs_{0}, micGapStampCorrectionNs_{0};
    std::atomic<std::uint32_t> micGapCaptureEventGapUs_{0}, micGapPacketGapUs_{0},
        micGapPacketsThisWake_{0}, micGapFramesThisWake_{0}, micGapPacketFrames_{0},
        micGapRenderWakePackets_{0}, micGapRenderWakeFrames_{0},
        micGapBridgeFillBeforeInsertFrames_{0}, micGapBridgeFillAfterInsertFrames_{0};
    bool micGapAwaitingSubmission_{false}; // render/backend thread only
    std::array<std::atomic<std::uint32_t>, 512> micMonitoringAgeUs_{};
    std::atomic<std::uint64_t> micMonitoringAgeCount_{0};
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
    std::array<std::atomic<float>, MaxAudioChannels> inputChannelRms_{};
    std::atomic<std::uint32_t> selectedInputChannel_{0};
    // The control thread publishes commands; only render advances oscillator state.
    std::uint64_t renderedToneSequence_{0};
    std::uint32_t toneFramesRemaining_{0};
    std::uint32_t renderedToneDurationFrames_{0};
    float renderedToneFrequencyHz_{0.0F};
    float renderedToneGain_{0.0F};
    double tonePhase_{0.0};
    std::atomic<bool> diagnosticInputEnabled_{false};
    std::atomic<float> diagnosticInputFrequencyHz_{0.0F};
    std::atomic<float> diagnosticInputGain_{0.0F};
    std::atomic<std::uint64_t> diagnosticInputMusicalStartUnixMs_{0};
    std::atomic<std::uint32_t> diagnosticInputMarkerPeriodMs_{500U};
    std::vector<float> diagnosticCaptureInput_; // allocated before capture starts
    double diagnosticInputPhase_{0.0}; // capture thread only
    std::atomic<std::int64_t> lastCapturePosition_{-1};
    std::atomic<std::int64_t> lastCaptureTimestamp_{-1};
    // Steady-clock nanoseconds of the latest bridge push; written by capture, read by render.
    std::atomic<MonotonicTicks> capturePushedAt_{0};
    // Device capture time just after the newest sample in the clock bridge; 0 when the backend
    // cannot report capture times. Written by capture, read by render.
    std::atomic<MonotonicTicks> capturedEndTicks_{0};
    std::atomic<MonotonicTicks> acousticLatencyNs_{0};
    // Control-thread identity: even the same requested default device can resolve differently.
    MonotonicTicks calibrationContext_{0};
    bool acousticCalibrationValid_{false};
    std::atomic<float> systemGain_{1.0F};
    std::atomic<MonotonicTicks> captureAgeNs_{0};
    std::atomic<MonotonicTicks> captureStampCorrectionNs_{0};
    std::atomic<MonotonicTicks> captureStampDeliveredAtNs_{0};
    std::atomic<MonotonicTicks> captureStampCorrectedStartNs_{0};
    MonotonicTicks nextPresentationTicks_{0}; // render thread
    std::atomic<std::uint64_t> presentationJumps_{0};
    std::atomic<MonotonicTicks> presentationJumpMaxNs_{0};
    std::atomic<std::uint64_t> remoteMixNonzeroBlocks_{0};
    std::atomic<float> remoteMixPeak_{0.0F};
    std::atomic<std::uint64_t> masterOutputNonzeroBlocks_{0};
    std::atomic<float> masterOutputPeak_{0.0F};
    bool songUnderway_{false}; // render thread: sounded since it last stopped
    VoiceLoudness ownVoice_;   // this singer's level while singing (render thread notes)
    std::uint32_t followAppliedFrames_{0};           // render thread
    std::atomic<std::uint32_t> roomFollowFrames_{0}; // written by render
    std::atomic<MonotonicTicks> roomFollowTicks_{0}; // written by render
    PerformanceAligner aligner_;                     // render thread only
    AcousticLatencyMeter latencyMeter_;
    PassiveLatencyEstimator passiveLatency_; // hidden latency from the song the microphone hears
    double voiceLateFrames_{-1.0};           // render thread only; negative until measured
    MonotonicTicks lastRenderAt_{0};         // render thread only
    std::uint32_t bridgeFillAfterRenderFrames_{0}; // render thread only
    double bridgeLatencyFrames_{-1.0};             // render thread only; negative until measured
};
