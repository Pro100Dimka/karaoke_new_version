#pragma once

#include "recording/WavWriter.hpp"

#include <cmath>
#include <filesystem>
#include <iostream>
#include <string_view>
#include <vector>

namespace Tests {
void leavingRoomReclaimsEveryRemoteParticipant();
void remoteSlotReuseStartsWithFreshEffects();
void clockDiagnosticsRemainObservableAcrossThreads();
void referenceToneStopCannotBeUndoneByAnInFlightRender();
void referenceToneRejectsNonFiniteParameters();
void wasapiCapabilitiesUseSupportedRatesAndSharedPeriods();
void wasapiCallbackThreadInitializesCom();
void wasapiDetectsDeviceLossWithoutEndpointEvents();
void wasapiExclusiveSubdividesPcmWithoutSplittingEndpointPackets();
void wasapiReportsEveryDeviceFailure();
void wasapiSharedFallsBackWhenEnginePeriodQueryIsUnavailable();
void wasapiSharedPeriodStaysInsideDriverBounds();
void wasapiChunkTimestampsFollowTheirSamplePositions();
void wasapiFailedStartRollsBackTheRunningSession();
void wavWriterReportsFinalizationAndRiffFailures();
void stopRecordingReportsWriterFailure();
void wavWriterRejectsUnrepresentableFormatsAndPartialFrames();
void wavWriterSanitizesNonFiniteSamples();
void recordingOverrunsPreserveTheAudioTimeline();
void recordingStopDrainsAnInFlightProducer();
void recordingGenerationChangeFinalizesTheExistingFormat();
void recordingShutdownFinalizesAcceptedPcm();
void runtimeRejectsUnsupportedSampleFormats();
void runtimeConfigurationRejectsUnsupportedDimensions();
void asioSplitsLargeDriverBuffers();
void runtimePlanAccountsForEndpointPackets();
void runtimePlanRejectsCapacityOverflow();
void asioNegotiatesBufferAfterChangingRate();
void asioStopDrainsInFlightCallbacks();
void asioRejectsInvalidDriverCapabilities();
void asioCapabilityProbePreservesTheActiveDriver();
void asioCapabilityFailureReleasesTheDriver();
void asioCapabilitiesIncludeSupportedRequestedRate();
void asioBufferSelectionUsesDriverConstraints();
void asioDestructionStopsTheDriver();
void asioFailedStartDoesNotPublishRunning();
void clockCorrectionCompensatesTheDirectionOfCaptureDrift();
void outgoingVoiceUsesTheInternalClockAndMicrophoneGate();
void rawRecordingUsesTheNegotiatedInternalTimeline();
void clockBridgeHonorsDeviceRateRatiosOutsideTwoToOne();
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
void wasapiConversionPreservesOutputLevel();
void wasapiRejectsInvalidSampleLayouts();
void wasapiExclusiveKeepsMicrophoneCaptureShareable();
void wasapiExclusivePreservesSystemNativePcmFormat();
void wasapiDeadlineMetricExcludesEventWaitTime();
void asioPackedIntegerFormatsUseTheirValidBitDepth();
void asioSampleConversionSupportsDriverReportedFormats();
void asioDriverLifecycleStaysInItsCreatingComApartment();
void pcmRingPreservesPcm();
void pcmRingRejectsOverflow();
void pcmClearDrainsInFlightConsumer();
void generationResetDrainsInFlightProducer();
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
void analysisDetectsLivePitch();
void opusCodecRoundTripsSpeechLikeSignal();
void opusDecoderConcealsALostFrame();
void jitterBufferReordersPackets();
void jitterBufferReportsLossExplicitly();
void jitterBufferWaitsForReorderingWindowBeforeDeclaringLoss();
void jitterBufferIsBounded();
void remoteParticipantControlsAreIsolated();
void remoteParticipantEffectsAreIsolated();
void networkRejectsStaleGeneration();
void networkAcceptsMultichannelDeviceAudio();
void networkPreparationDoesNotRequireOpusCompatibleDeviceRate();
void roomVoiceStartsAt44100DeviceRate();
void roomVoiceFractionalPacketsDoNotDriftAt44100();
void roomVoiceSharedDelayAdaptsWithoutJumps();
void roomVoiceTwoComputerSimulationSurvivesAsymmetricDelay();
void networkClickTracksAlignAfterCodecAndImpairment();
void networkImpairmentMatrixKeepsAlignmentBounded();
void networkThirtyMinuteClockDriftDoesNotAccumulate();
void networkRunnerWritesAlignedThreeChannelEvidence();
void networkTestCommandWritesMachineReadableReport();
void networkLatencyJumpRestabilizesThroughFullCodecChain();
void jitterBufferSurvivesSequenceWrap();
void jitterBufferRebasesAfterLongOutage();
void sharedTimelineTimestampRemainsOrderedAcrossWrap();
void roomDelayConsensusEliminatesAdjacentPacketTargets();
void networkRejectsWrongSessionAndMalformedPackets();
void roomVoiceSupportsThreeParticipantsAndLateJoin();
void roomVoiceRejoinClearsPreviousParticipantState();
void roomVoicePacketizationSupportsSystemRatesAndBuffers();
void roomVoiceSurvivesRepeatedDriverFormatSwitches();
void remoteQueueRecoversAfterForcedUnderrunAndOverrun();
void networkPacketWireFormatIsStableAndAuthenticated();
void networkTimelineDoesNotCompareIndependentClientClockOrigins();
void roomVoiceCompensationAlignsDifferentNetworkDelays();
void networkRemoteQueueConvergesWithoutMutingOtherSingers();
void networkTimingTracksJitterAndRoundTripDelay();
void networkTimingReportsClockOffsetAndDrift();
void networkRetimeCorrectionPreservesContinuousVoice();
void roomVoicePlayoutDelayStaysBelowFortyMilliseconds();
void roomVoiceSharedCompensationCannotGrowPastInteractiveLimit();
void remoteParticipantLifecycleIsSafeDuringDiagnostics();
void roomSharedTimelineStaysWarmAcrossPlaybackCommands();
void roomVoiceRouteCompensationDoesNotAccumulate();
void roomVoiceTransportSurvivesAudioDeviceRecovery();
void udpSocketCanSendDirectlyToMultiplePeersWithoutDisconnectingRelayReceive();
void directAndRelayCopiesAreDeduplicatedBeforeJitterMeasurement();
void wavDecoderReportsFormat();
void wavDecoderSeekIsDeterministic();
void slowerRateProducesMoreFrames();
void transposeReportsLatency();
void previewLoopStaysInsideRange();
void seekUpdatesAuthoritativePosition();
void unloadQuiescesDecoderWorker();
void audioReconfigurePreservesActiveKaraokeMedia();
void karaokeTracksShareTransport();
void radioStopsWhenPreviewActivates();
void staleDecodedPcmNeverLeaksAfterSeek();
void recordingDurationCountsAcceptedPcm();
void recordingPauseCreatesGapMetadata();
void recordingWritesWav();
void recordingRejectsStaleGeneration();
void prepareRecordingSelectsMasterMixTap();
void performanceMixRecordsVoiceWithoutMonitoring();
void performanceMixFollowsMusicGain();
void performanceMixExcludesReferenceVocal();
void roomMediaRendersWithoutDelayOrStretching();
void performanceMixExcludesMelody();
void disabledDspIsExactBypass();
void dspParametersAreValidated();
void activePitchReportsLatency();
void dspOutputRemainsFinite();
void roomVoiceEffectAmountsDriveWetProcessing();
void noiseSuppressionPreservesVoicedWaveform();
void ipcParsesMonitoringCommand();
void ipcMapsRemoteParticipantCommand();
void ipcMapsDirectPeerCommand();
void ipcMapsRecordingPreviewCommand();
void ipcAcceptsNewlineTerminatedRequest();
void ipcRejectsMalformedVersion();
void seededStateFuzzPreservesSessionInvariants();
void runtimeConfigurationComesFromBackend();
void unsupportedRateUsesSystemDefault();
void unspecifiedFormatUsesSystemDefaults();
void unspecifiedChannelsStayWithinRealtimeEngineCapacity();
void productionAudioConfigurationDoesNotInventDeviceDefaults();
void emptyDeviceCapabilitiesAreRejectedBeforeOpening();
void ipcExposesSelectedDeviceCapabilities();
void ipcReusesActiveSessionCapabilities();
void systemDefaultFormatChangeRequiresRecovery();
void unrelatedDevicePropertyDoesNotRestartAudioSession();
void renderTimelineAdvancesInFrames();
void bareMonitoringReachesOutput();
void leftOnlyMicrophoneIsHeardInBothSpeakers();
void oppositePolarityAsioPairDoesNotCancelMicrophone();
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
