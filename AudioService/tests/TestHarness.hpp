#pragma once

#include "recording/WavWriter.hpp"

#include <cmath>
#include <filesystem>
#include <iostream>
#include <string_view>
#include <vector>

namespace Tests {
inline int failures = 0;
inline std::filesystem::path tempRoot;

inline void expect(bool condition, std::string_view message) {
    if (!condition) {
        ++failures;
        std::cerr << "FAIL: " << message << '\n';
    }
}

inline void makeTestWav(const std::filesystem::path& path, std::uint32_t frames = 4800,
                        std::uint32_t sampleRateHz = 48000, std::uint32_t channels = 2) {
    WavWriter writer;
    writer.open(path.string(), sampleRateHz, channels);
    std::vector<float> samples(static_cast<std::size_t>(frames) * channels);
    constexpr float Pi = 3.14159265358979323846F;
    for (std::uint32_t frame = 0; frame < frames; ++frame) {
        const auto value = 0.2F * std::sin(2.0F * Pi * 440.0F * static_cast<float>(frame) /
                                           static_cast<float>(sampleRateHz));
        for (std::uint32_t channel = 0; channel < channels; ++channel) {
            samples[static_cast<std::size_t>(frame) * channels + channel] = value;
        }
    }
    writer.write(samples);
    writer.close();
}

void fakeBackendUsesConfiguredPacketPattern();
void fakeBackendAppliesConfiguredDrift();
void fakeBackendAppliesTimestampJitter();
void fakeBackendEmitsScheduledFault();
void fakeBackendCanReproduceStaleCallbackAfterStop();
void fakeBackendReplaysTimingTraceWithoutPcmStorage();
void wasapiExclusiveAppliesListeningLevelCompensation();
void wasapiExclusiveKeepsMicrophoneCaptureShareable();
void pcmRingPreservesPcm();
void pcmRingRejectsOverflow();
void generationRingRejectsStalePcm();
void clockDetectsPositiveDrift();
void clockRejectsNonMonotonicTimestamp();
void clockNormalizesNominalRates();
void clockUsesDeviceTimestamps();
void clockBridgeDoesNotCreep();
void signalMeasuresPeakAndRms();
void spectrumRespondsToTheFrequencyPlayed();
void signalCountsClipping();
void analysisRejectsStaleGeneration();
void opusCodecRoundTripsSpeechLikeSignal();
void opusDecoderConcealsALostFrame();
void jitterBufferReordersPackets();
void jitterBufferReportsLossExplicitly();
void jitterBufferWaitsForReorderingWindowBeforeDeclaringLoss();
void jitterBufferIsBounded();
void remoteParticipantControlsAreIsolated();
void networkRejectsStaleGeneration();
void networkPacketWireFormatIsStableAndAuthenticated();
void networkTimelineAlignsLateAndEarlyVoicePackets();
void roomVoicePlayoutDelayStaysBelowFortyMilliseconds();
void remoteParticipantLifecycleIsSafeDuringDiagnostics();
void wavDecoderReportsFormat();
void wavDecoderSeekIsDeterministic();
void slowerRateProducesMoreFrames();
void transposeReportsLatency();
void previewLoopStaysInsideRange();
void seekUpdatesAuthoritativePosition();
void unloadQuiescesDecoderWorker();
void karaokeTracksShareTransport();
void radioStopsWhenPreviewActivates();
void staleDecodedPcmNeverLeaksAfterSeek();
void recordingDurationCountsAcceptedPcm();
void recordingPauseCreatesGapMetadata();
void recordingWritesWav();
void recordingRejectsStaleGeneration();
void prepareRecordingSelectsMasterMixTap();
void performanceMixRecordsVoiceWithoutMonitoring();
void performanceMixExcludesReferenceVocal();
void disabledDspIsExactBypass();
void dspParametersAreValidated();
void activePitchReportsLatency();
void dspOutputRemainsFinite();
void noiseSuppressionPreservesVoicedWaveform();
void ipcParsesMonitoringCommand();
void ipcMapsRemoteParticipantCommand();
void ipcMapsRecordingPreviewCommand();
void ipcAcceptsNewlineTerminatedRequest();
void ipcRejectsMalformedVersion();
void seededStateFuzzPreservesSessionInvariants();
void runtimeConfigurationComesFromBackend();
void renderTimelineAdvancesInFrames();
void bareMonitoringReachesOutput();
void leftOnlyMicrophoneIsHeardInBothSpeakers();
void voiceEffectsAreAudibleInMonitoring();
void realtimeCallbackHasNoHardRtViolations();
void deviceLossRecoversWithNewGeneration();
void deviceLossCapturesFailureSnapshot();
void stopInvalidatesGeneration();
void sessionLifecycleIsExposedThroughIpc();
void diagnosticsExposeRemoteParticipantLevels();
void latencyRegistrySumsStages();
void traceBufferKeepsOnlyLastEvents();
void traceBufferCountsOverwrittenEvents();
void impulseLatencyFindsFrameOffset();
} // namespace Tests
