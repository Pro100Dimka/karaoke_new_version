#include "TestHarness.hpp"

#include <array>
#include <exception>
#include <filesystem>
#include <iostream>
#include <random>
#include <stdexcept>
#include <utility>

#if defined(_MSC_VER)
#include <crtdbg.h>
#endif

namespace {
class TestDirectory {
  public:
    TestDirectory() {
        const auto parent = std::filesystem::temp_directory_path();
        std::random_device random;
        for (int attempt = 0; attempt < 32; ++attempt) {
            path_ = parent / ("audioservice-tests-" + std::to_string(random()) + "-" +
                              std::to_string(random()));
            if (std::filesystem::create_directory(path_))
                return;
        }
        throw std::runtime_error("Cannot allocate an isolated test directory");
    }
    ~TestDirectory() {
        std::error_code ignored;
        std::filesystem::remove_all(path_, ignored);
    }
    const std::filesystem::path& path() const noexcept {
        return path_;
    }

  private:
    std::filesystem::path path_;
};
using Test = std::pair<const char*, void (*)()>;

constexpr std::array tests{
    Test{"outgoingVoiceKeepsTheTimestampOfItsOwnPcm", Tests::outgoingVoiceKeepsTheTimestampOfItsOwnPcm},
    Test{"roomVoiceClockAdvancesWhileTheSongIsStopped", Tests::roomVoiceClockAdvancesWhileTheSongIsStopped},
    Test{"scheduledPlaybackTracksIndependentDeviceClocks", Tests::scheduledPlaybackTracksIndependentDeviceClocks},
    Test{"scheduledRoomPlaybackWaitsForItsAudioDeadline", Tests::scheduledRoomPlaybackWaitsForItsAudioDeadline},
    Test{"networkStopNeverLosesTheSenderWakeup", Tests::networkStopNeverLosesTheSenderWakeup},
    Test{"analysisStopNeverLosesTheWorkerWakeup", Tests::analysisStopNeverLosesTheWorkerWakeup},
    Test{"asioLatencyFailureDoesNotReuseThePreviousDevice",
         Tests::asioLatencyFailureDoesNotReuseThePreviousDevice},
    Test{"wasapiLatencyFailureDoesNotPublishInvalidMeasurements",
         Tests::wasapiLatencyFailureDoesNotPublishInvalidMeasurements},
    Test{"monitoringLatencyExcludesUnrelatedRoutesAndSaturates",
         Tests::monitoringLatencyExcludesUnrelatedRoutesAndSaturates},
    Test{"recordingPreviewDiagnosticsUseItsOwnTimeline",
         Tests::recordingPreviewDiagnosticsUseItsOwnTimeline},
    Test{"diagnosticsUseRuntimeLatencyClockDomainsAndEndpointCapacity",
         Tests::diagnosticsUseRuntimeLatencyClockDomainsAndEndpointCapacity},
    Test{"pitchProcessingFlushesTheFinalAudio", Tests::pitchProcessingFlushesTheFinalAudio},
    Test{"asioApartmentFailedStartupReleasesItsEvent",
         Tests::asioApartmentFailedStartupReleasesItsEvent},
    Test{"asioRepeatedStartPreservesTheActiveCallback",
         Tests::asioRepeatedStartPreservesTheActiveCallback},
    Test{"controlPipeRestrictsItsAccessDescriptor", Tests::controlPipeRestrictsItsAccessDescriptor},
    Test{"controlPipePreservesRepliesAfterServerClose",
         Tests::controlPipePreservesRepliesAfterServerClose},
    Test{"controlPipeStopCancelsIdleAndStalledClients",
         Tests::controlPipeStopCancelsIdleAndStalledClients},
    Test{"controlPipeExpiresUnresponsiveClients", Tests::controlPipeExpiresUnresponsiveClients},
    Test{"recordingPrepareFailureReleasesFileAndCanRetry",
         Tests::recordingPrepareFailureReleasesFileAndCanRetry},
    Test{"deviceNotificationFailureReleasesComBeforeRetry",
         Tests::deviceNotificationFailureReleasesComBeforeRetry},
    Test{"invalidNumericControlCannotMutateRuntimeState",
         Tests::invalidNumericControlCannotMutateRuntimeState},
    Test{"recordingControlExposesAuthoritativeGapMetadata",
         Tests::recordingControlExposesAuthoritativeGapMetadata},
    Test{"previewTransportCommandsDoNotFallThrough",
         Tests::previewTransportCommandsDoNotFallThrough},
    Test{"loadingSongWithoutCompanionsUnloadsThePreviousStems",
         Tests::loadingSongWithoutCompanionsUnloadsThePreviousStems},
    Test{"mediaResamplingPreservesEveryFrameAcrossChunks",
         Tests::mediaResamplingPreservesEveryFrameAcrossChunks},
    Test{"mediaEofFinishesWithTheExactSampleCount", Tests::mediaEofFinishesWithTheExactSampleCount},
    Test{"changingMediaRateDoesNotMoveAlreadyRenderedPosition",
         Tests::changingMediaRateDoesNotMoveAlreadyRenderedPosition},
    Test{"remoteRemovalDrainsAnInFlightRenderLease",
         Tests::remoteRemovalDrainsAnInFlightRenderLease},
    Test{"leavingRoomReclaimsEveryRemoteParticipant",
         Tests::leavingRoomReclaimsEveryRemoteParticipant},
    Test{"remoteSlotReuseStartsWithFreshEffects", Tests::remoteSlotReuseStartsWithFreshEffects},
    Test{"clockDiagnosticsRemainObservableAcrossThreads",
         Tests::clockDiagnosticsRemainObservableAcrossThreads},
    Test{"referenceToneStopCannotBeUndoneByAnInFlightRender",
         Tests::referenceToneStopCannotBeUndoneByAnInFlightRender},
    Test{"referenceToneRejectsNonFiniteParameters", Tests::referenceToneRejectsNonFiniteParameters},
    Test{"wasapiCapabilitiesUseSupportedRatesAndSharedPeriods",
         Tests::wasapiCapabilitiesUseSupportedRatesAndSharedPeriods},
    Test{"wasapiRunsOutputWithoutADefaultMicrophone",
         Tests::wasapiRunsOutputWithoutADefaultMicrophone},
    Test{"wasapiCallbackThreadInitializesCom", Tests::wasapiCallbackThreadInitializesCom},
    Test{"wasapiDetectsDeviceLossWithoutEndpointEvents",
         Tests::wasapiDetectsDeviceLossWithoutEndpointEvents},
    Test{"wasapiExclusiveSubdividesPcmWithoutSplittingEndpointPackets",
         Tests::wasapiExclusiveSubdividesPcmWithoutSplittingEndpointPackets},
    Test{"wasapiReportsEveryDeviceFailure", Tests::wasapiReportsEveryDeviceFailure},
    Test{"wasapiSharedFallsBackWhenEnginePeriodQueryIsUnavailable",
         Tests::wasapiSharedFallsBackWhenEnginePeriodQueryIsUnavailable},
    Test{"wasapiSharedPeriodStaysInsideDriverBounds",
         Tests::wasapiSharedPeriodStaysInsideDriverBounds},
    Test{"wasapiChunkTimestampsFollowTheirSamplePositions",
         Tests::wasapiChunkTimestampsFollowTheirSamplePositions},
    Test{"wasapiFailedStartRollsBackTheRunningSession",
         Tests::wasapiFailedStartRollsBackTheRunningSession},
    Test{"runtimeRejectsUnsupportedSampleFormats", Tests::runtimeRejectsUnsupportedSampleFormats},
    Test{"runtimeConfigurationRejectsUnsupportedDimensions",
         Tests::runtimeConfigurationRejectsUnsupportedDimensions},
    Test{"asioSplitsLargeDriverBuffers", Tests::asioSplitsLargeDriverBuffers},
    Test{"runtimePlanAccountsForEndpointPackets", Tests::runtimePlanAccountsForEndpointPackets},
    Test{"runtimePlanRejectsCapacityOverflow", Tests::runtimePlanRejectsCapacityOverflow},
    Test{"asioNegotiatesBufferAfterChangingRate", Tests::asioNegotiatesBufferAfterChangingRate},
    Test{"asioStopDrainsInFlightCallbacks", Tests::asioStopDrainsInFlightCallbacks},
    Test{"asioRejectsInvalidDriverCapabilities", Tests::asioRejectsInvalidDriverCapabilities},
    Test{"asioCapabilityProbePreservesTheActiveDriver",
         Tests::asioCapabilityProbePreservesTheActiveDriver},
    Test{"asioCapabilityFailureReleasesTheDriver", Tests::asioCapabilityFailureReleasesTheDriver},
    Test{"asioCapabilitiesIncludeSupportedRequestedRate",
         Tests::asioCapabilitiesIncludeSupportedRequestedRate},
    Test{"asioBufferSelectionUsesDriverConstraints",
         Tests::asioBufferSelectionUsesDriverConstraints},
    Test{"asioDestructionStopsTheDriver", Tests::asioDestructionStopsTheDriver},
    Test{"asioFailedStartDoesNotPublishRunning", Tests::asioFailedStartDoesNotPublishRunning},
    Test{"clockCorrectionCompensatesTheDirectionOfCaptureDrift",
         Tests::clockCorrectionCompensatesTheDirectionOfCaptureDrift},
    Test{"outgoingVoiceUsesTheInternalClockAndMicrophoneGate",
         Tests::outgoingVoiceUsesTheInternalClockAndMicrophoneGate},
    Test{"rawRecordingUsesTheNegotiatedInternalTimeline",
         Tests::rawRecordingUsesTheNegotiatedInternalTimeline},
    Test{"clockBridgeHonorsDeviceRateRatiosOutsideTwoToOne",
         Tests::clockBridgeHonorsDeviceRateRatiosOutsideTwoToOne},
    Test{"roomSharedTimelineStaysWarmAcrossPlaybackCommands",
         Tests::roomSharedTimelineStaysWarmAcrossPlaybackCommands},
    Test{"roomVoiceRouteCompensationDoesNotAccumulate",
         Tests::roomVoiceRouteCompensationDoesNotAccumulate},
    Test{"performanceMixFollowsMusicGain", Tests::performanceMixFollowsMusicGain},
    Test{"fakeBackendUsesConfiguredPacketPattern", Tests::fakeBackendUsesConfiguredPacketPattern},
    Test{"fakeBackendAppliesConfiguredDrift", Tests::fakeBackendAppliesConfiguredDrift},
    Test{"fakeBackendAppliesTimestampJitter", Tests::fakeBackendAppliesTimestampJitter},
    Test{"fakeBackendEmitsScheduledFault", Tests::fakeBackendEmitsScheduledFault},
    Test{"fakeBackendCanReproduceStaleCallbackAfterStop",
         Tests::fakeBackendCanReproduceStaleCallbackAfterStop},
    Test{"fakeBackendReplaysTimingTraceWithoutPcmStorage",
         Tests::fakeBackendReplaysTimingTraceWithoutPcmStorage},
    Test{"wasapiConversionPreservesOutputLevel", Tests::wasapiConversionPreservesOutputLevel},
    Test{"wasapiRejectsInvalidSampleLayouts", Tests::wasapiRejectsInvalidSampleLayouts},
    Test{"wasapiExclusiveKeepsMicrophoneCaptureShareable",
         Tests::wasapiExclusiveKeepsMicrophoneCaptureShareable},
    Test{"wasapiExclusivePreservesSystemNativePcmFormat",
         Tests::wasapiExclusivePreservesSystemNativePcmFormat},
    Test{"wasapiDeadlineMetricExcludesEventWaitTime",
         Tests::wasapiDeadlineMetricExcludesEventWaitTime},
    Test{"asioPackedIntegerFormatsUseTheirValidBitDepth",
         Tests::asioPackedIntegerFormatsUseTheirValidBitDepth},
    Test{"asioSampleConversionSupportsDriverReportedFormats",
         Tests::asioSampleConversionSupportsDriverReportedFormats},
    Test{"asioDriverLifecycleStaysInItsCreatingComApartment",
         Tests::asioDriverLifecycleStaysInItsCreatingComApartment},
    Test{"pcmRingPreservesPcm", Tests::pcmRingPreservesPcm},
    Test{"pcmRingRejectsOverflow", Tests::pcmRingRejectsOverflow},
    Test{"pcmClearDrainsInFlightConsumer", Tests::pcmClearDrainsInFlightConsumer},
    Test{"generationResetDrainsInFlightProducer", Tests::generationResetDrainsInFlightProducer},
    Test{"generationRingRejectsStalePcm", Tests::generationRingRejectsStalePcm},
    Test{"clockDetectsPositiveDrift", Tests::clockDetectsPositiveDrift},
    Test{"clockRejectsNonMonotonicTimestamp", Tests::clockRejectsNonMonotonicTimestamp},
    Test{"clockNormalizesNominalRates", Tests::clockNormalizesNominalRates},
    Test{"clockUsesDeviceTimestamps", Tests::clockUsesDeviceTimestamps},
    Test{"clockBridgeDoesNotCreep", Tests::clockBridgeDoesNotCreep},
    Test{"signalMeasuresPeakAndRms", Tests::signalMeasuresPeakAndRms},
    Test{"spectrumRespondsToTheFrequencyPlayed", Tests::spectrumRespondsToTheFrequencyPlayed},
    Test{"spectrumHonorsSourceGain", Tests::spectrumHonorsSourceGain},
    Test{"signalCountsClipping", Tests::signalCountsClipping},
    Test{"analysisRejectsStaleGeneration", Tests::analysisRejectsStaleGeneration},
    Test{"analysisDetectsLivePitch", Tests::analysisDetectsLivePitch},
    Test{"analysisAccumulatesDeviceSizedBlocksForPitch",
         Tests::analysisAccumulatesDeviceSizedBlocksForPitch},
    Test{"analysisPrefersFundamentalOverStrongerHarmonic",
         Tests::analysisPrefersFundamentalOverStrongerHarmonic},
    Test{"analysisRejectsUnpitchedNoise", Tests::analysisRejectsUnpitchedNoise},
    Test{"opusCodecRoundTripsSpeechLikeSignal", Tests::opusCodecRoundTripsSpeechLikeSignal},
    Test{"opusDecoderConcealsALostFrame", Tests::opusDecoderConcealsALostFrame},
    Test{"jitterBufferReordersPackets", Tests::jitterBufferReordersPackets},
    Test{"jitterBufferReportsLossExplicitly", Tests::jitterBufferReportsLossExplicitly},
    Test{"jitterBufferWaitsForReorderingWindowBeforeDeclaringLoss",
         Tests::jitterBufferWaitsForReorderingWindowBeforeDeclaringLoss},
    Test{"jitterBufferIsBounded", Tests::jitterBufferIsBounded},
    Test{"remoteParticipantControlsAreIsolated", Tests::remoteParticipantControlsAreIsolated},
    Test{"remoteParticipantEffectsAreIsolated", Tests::remoteParticipantEffectsAreIsolated},
    Test{"networkRejectsStaleGeneration", Tests::networkRejectsStaleGeneration},
    Test{"networkAcceptsMultichannelDeviceAudio", Tests::networkAcceptsMultichannelDeviceAudio},
    Test{"networkPreparationDoesNotRequireOpusCompatibleDeviceRate",
         Tests::networkPreparationDoesNotRequireOpusCompatibleDeviceRate},
    Test{"roomVoiceStartsAt44100DeviceRate", Tests::roomVoiceStartsAt44100DeviceRate},
    Test{"roomVoiceFractionalPacketsDoNotDriftAt44100",
         Tests::roomVoiceFractionalPacketsDoNotDriftAt44100},
    Test{"roomVoiceSharedDelayAdaptsWithoutJumps", Tests::roomVoiceSharedDelayAdaptsWithoutJumps},
    Test{"roomVoiceTwoComputerSimulationSurvivesAsymmetricDelay",
         Tests::roomVoiceTwoComputerSimulationSurvivesAsymmetricDelay},
    Test{"networkClickTracksAlignAfterCodecAndImpairment",
         Tests::networkClickTracksAlignAfterCodecAndImpairment},
    Test{"networkImpairmentMatrixKeepsAlignmentBounded",
         Tests::networkImpairmentMatrixKeepsAlignmentBounded},
    Test{"networkThirtyMinuteClockDriftDoesNotAccumulate",
         Tests::networkThirtyMinuteClockDriftDoesNotAccumulate},
    Test{"networkRunnerWritesAlignedThreeChannelEvidence",
         Tests::networkRunnerWritesAlignedThreeChannelEvidence},
    Test{"networkTestCommandWritesMachineReadableReport",
         Tests::networkTestCommandWritesMachineReadableReport},
    Test{"networkLatencyJumpRestabilizesThroughFullCodecChain",
         Tests::networkLatencyJumpRestabilizesThroughFullCodecChain},
    Test{"jitterBufferSurvivesSequenceWrap", Tests::jitterBufferSurvivesSequenceWrap},
    Test{"jitterBufferRebasesAfterLongOutage", Tests::jitterBufferRebasesAfterLongOutage},
    Test{"sharedTimelineTimestampRemainsOrderedAcrossWrap",
         Tests::sharedTimelineTimestampRemainsOrderedAcrossWrap},
    Test{"roomDelayConsensusEliminatesAdjacentPacketTargets",
         Tests::roomDelayConsensusEliminatesAdjacentPacketTargets},
    Test{"networkRejectsWrongSessionAndMalformedPackets",
         Tests::networkRejectsWrongSessionAndMalformedPackets},
    Test{"roomVoiceSupportsThreeParticipantsAndLateJoin",
         Tests::roomVoiceSupportsThreeParticipantsAndLateJoin},
    Test{"roomVoiceRejoinClearsPreviousParticipantState",
         Tests::roomVoiceRejoinClearsPreviousParticipantState},
    Test{"roomVoicePacketizationSupportsSystemRatesAndBuffers",
         Tests::roomVoicePacketizationSupportsSystemRatesAndBuffers},
    Test{"roomVoiceSurvivesRepeatedDriverFormatSwitches",
         Tests::roomVoiceSurvivesRepeatedDriverFormatSwitches},
    Test{"remoteQueueRecoversAfterForcedUnderrunAndOverrun",
         Tests::remoteQueueRecoversAfterForcedUnderrunAndOverrun},
    Test{"networkPacketWireFormatIsStableAndAuthenticated",
         Tests::networkPacketWireFormatIsStableAndAuthenticated},
    Test{"networkTimelineDoesNotCompareIndependentClientClockOrigins",
         Tests::networkTimelineDoesNotCompareIndependentClientClockOrigins},
    Test{"roomVoiceCompensationAlignsDifferentNetworkDelays",
         Tests::roomVoiceCompensationAlignsDifferentNetworkDelays},
    Test{"networkRemoteQueueConvergesWithoutMutingOtherSingers",
         Tests::networkRemoteQueueConvergesWithoutMutingOtherSingers},
    Test{"networkTimingTracksJitterAndRoundTripDelay",
         Tests::networkTimingTracksJitterAndRoundTripDelay},
    Test{"networkTimingReportsClockOffsetAndDrift", Tests::networkTimingReportsClockOffsetAndDrift},
    Test{"networkRetimeCorrectionPreservesContinuousVoice",
         Tests::networkRetimeCorrectionPreservesContinuousVoice},
    Test{"roomVoicePlayoutDelayStaysBelowFortyMilliseconds",
         Tests::roomVoicePlayoutDelayStaysBelowFortyMilliseconds},
    Test{"roomVoiceSharedCompensationCannotGrowPastInteractiveLimit",
         Tests::roomVoiceSharedCompensationCannotGrowPastInteractiveLimit},
    Test{"remoteParticipantLifecycleIsSafeDuringDiagnostics",
         Tests::remoteParticipantLifecycleIsSafeDuringDiagnostics},
    Test{"roomVoiceTransportSurvivesAudioDeviceRecovery",
         Tests::roomVoiceTransportSurvivesAudioDeviceRecovery},
    Test{"wavDecoderReportsFormat", Tests::wavDecoderReportsFormat},
    Test{"mediaRejectsNonFiniteProcessingParameters",
         Tests::mediaRejectsNonFiniteProcessingParameters},
    Test{"disablingLoopDiscardsQueuedLoopAudio", Tests::disablingLoopDiscardsQueuedLoopAudio},
    Test{"wavDecoderRejectsMalformedDimensionsAndTruncation",
         Tests::wavDecoderRejectsMalformedDimensionsAndTruncation},
    Test{"mediaFoundationDistinguishesErrorsTicksAndEof",
         Tests::mediaFoundationDistinguishesErrorsTicksAndEof},
    Test{"mediaFoundationCloseDrainsCancellation", Tests::mediaFoundationCloseDrainsCancellation},
    Test{"mediaFoundationOwnsComOnTheDecodingThread",
         Tests::mediaFoundationOwnsComOnTheDecodingThread},
    Test{"mediaPositionsUseTheCorrectClockDomain", Tests::mediaPositionsUseTheCorrectClockDomain},
    Test{"wavDecoderHonorsDataBoundaryAndCanSeekAfterEof",
         Tests::wavDecoderHonorsDataBoundaryAndCanSeekAfterEof},
    Test{"wavDecoderSeekIsDeterministic", Tests::wavDecoderSeekIsDeterministic},
    Test{"slowerRateProducesMoreFrames", Tests::slowerRateProducesMoreFrames},
    Test{"transposeReportsLatency", Tests::transposeReportsLatency},
    Test{"previewLoopStaysInsideRange", Tests::previewLoopStaysInsideRange},
    Test{"seekUpdatesAuthoritativePosition", Tests::seekUpdatesAuthoritativePosition},
    Test{"unloadQuiescesDecoderWorker", Tests::unloadQuiescesDecoderWorker},
    Test{"audioReconfigurePreservesActiveKaraokeMedia",
         Tests::audioReconfigurePreservesActiveKaraokeMedia},
    Test{"karaokeTracksShareTransport", Tests::karaokeTracksShareTransport},
    Test{"radioStopsWhenPreviewActivates", Tests::radioStopsWhenPreviewActivates},
    Test{"staleDecodedPcmNeverLeaksAfterSeek", Tests::staleDecodedPcmNeverLeaksAfterSeek},
    Test{"wavWriterReportsFinalizationAndRiffFailures",
         Tests::wavWriterReportsFinalizationAndRiffFailures},
    Test{"stopRecordingReportsWriterFailure", Tests::stopRecordingReportsWriterFailure},
    Test{"wavWriterRejectsUnrepresentableFormatsAndPartialFrames",
         Tests::wavWriterRejectsUnrepresentableFormatsAndPartialFrames},
    Test{"wavWriterSanitizesNonFiniteSamples", Tests::wavWriterSanitizesNonFiniteSamples},
    Test{"recordingOverrunsPreserveTheAudioTimeline",
         Tests::recordingOverrunsPreserveTheAudioTimeline},
    Test{"recordingStopDrainsAnInFlightProducer", Tests::recordingStopDrainsAnInFlightProducer},
    Test{"recordingGenerationChangeFinalizesTheExistingFormat",
         Tests::recordingGenerationChangeFinalizesTheExistingFormat},
    Test{"recordingShutdownFinalizesAcceptedPcm", Tests::recordingShutdownFinalizesAcceptedPcm},
    Test{"recordingDurationCountsAcceptedPcm", Tests::recordingDurationCountsAcceptedPcm},
    Test{"recordingPauseCreatesGapMetadata", Tests::recordingPauseCreatesGapMetadata},
    Test{"recordingWritesWav", Tests::recordingWritesWav},
    Test{"recordingRejectsStaleGeneration", Tests::recordingRejectsStaleGeneration},
    Test{"prepareRecordingSelectsMasterMixTap", Tests::prepareRecordingSelectsMasterMixTap},
    Test{"performanceMixRecordsVoiceWithoutMonitoring",
         Tests::performanceMixRecordsVoiceWithoutMonitoring},
    Test{"performanceMixExcludesReferenceVocal", Tests::performanceMixExcludesReferenceVocal},
    Test{"roomMediaRendersWithoutDelayOrStretching",
         Tests::roomMediaRendersWithoutDelayOrStretching},
    Test{"udpSocketCanSendDirectlyToMultiplePeersWithoutDisconnectingRelayReceive",
         Tests::udpSocketCanSendDirectlyToMultiplePeersWithoutDisconnectingRelayReceive},
    Test{"directAndRelayCopiesAreDeduplicatedBeforeJitterMeasurement",
         Tests::directAndRelayCopiesAreDeduplicatedBeforeJitterMeasurement},
    Test{"performanceMixExcludesMelody", Tests::performanceMixExcludesMelody},
    Test{"disabledDspIsExactBypass", Tests::disabledDspIsExactBypass},
    Test{"dspParametersAreValidated", Tests::dspParametersAreValidated},
    Test{"activePitchReportsLatency", Tests::activePitchReportsLatency},
    Test{"dspOutputRemainsFinite", Tests::dspOutputRemainsFinite},
    Test{"roomVoiceEffectAmountsDriveWetProcessing",
         Tests::roomVoiceEffectAmountsDriveWetProcessing},
    Test{"noiseSuppressionPreservesVoicedWaveform", Tests::noiseSuppressionPreservesVoicedWaveform},
    Test{"ipcParsesMonitoringCommand", Tests::ipcParsesMonitoringCommand},
    Test{"ipcMapsRemoteParticipantCommand", Tests::ipcMapsRemoteParticipantCommand},
    Test{"ipcMapsDirectPeerCommand", Tests::ipcMapsDirectPeerCommand},
    Test{"ipcMapsRecordingPreviewCommand", Tests::ipcMapsRecordingPreviewCommand},
    Test{"ipcAcceptsNewlineTerminatedRequest", Tests::ipcAcceptsNewlineTerminatedRequest},
    Test{"ipcRejectsMalformedVersion", Tests::ipcRejectsMalformedVersion},
    Test{"seededStateFuzzPreservesSessionInvariants",
         Tests::seededStateFuzzPreservesSessionInvariants},
    Test{"runtimeConfigurationComesFromBackend", Tests::runtimeConfigurationComesFromBackend},
    Test{"unsupportedRateUsesSystemDefault", Tests::unsupportedRateUsesSystemDefault},
    Test{"unspecifiedFormatUsesSystemDefaults", Tests::unspecifiedFormatUsesSystemDefaults},
    Test{"unspecifiedChannelsStayWithinRealtimeEngineCapacity",
         Tests::unspecifiedChannelsStayWithinRealtimeEngineCapacity},
    Test{"productionAudioConfigurationDoesNotInventDeviceDefaults",
         Tests::productionAudioConfigurationDoesNotInventDeviceDefaults},
    Test{"emptyDeviceCapabilitiesAreRejectedBeforeOpening",
         Tests::emptyDeviceCapabilitiesAreRejectedBeforeOpening},
    Test{"ipcExposesSelectedDeviceCapabilities", Tests::ipcExposesSelectedDeviceCapabilities},
    Test{"ipcReusesActiveSessionCapabilities", Tests::ipcReusesActiveSessionCapabilities},
    Test{"systemDefaultFormatChangeRequiresRecovery",
         Tests::systemDefaultFormatChangeRequiresRecovery},
    Test{"unrelatedDevicePropertyDoesNotRestartAudioSession",
         Tests::unrelatedDevicePropertyDoesNotRestartAudioSession},
    Test{"renderTimelineAdvancesInFrames", Tests::renderTimelineAdvancesInFrames},
    Test{"bareMonitoringReachesOutput", Tests::bareMonitoringReachesOutput},
    Test{"leftOnlyMicrophoneIsHeardInBothSpeakers", Tests::leftOnlyMicrophoneIsHeardInBothSpeakers},
    Test{"oppositePolarityAsioPairDoesNotCancelMicrophone",
         Tests::oppositePolarityAsioPairDoesNotCancelMicrophone},
    Test{"voiceEffectsAreAudibleInMonitoring", Tests::voiceEffectsAreAudibleInMonitoring},
    Test{"realtimeCallbackHasNoHardRtViolations", Tests::realtimeCallbackHasNoHardRtViolations},
    Test{"deviceLossRecoversWithNewGeneration", Tests::deviceLossRecoversWithNewGeneration},
    Test{"deviceLossCapturesFailureSnapshot", Tests::deviceLossCapturesFailureSnapshot},
    Test{"stopInvalidatesGeneration", Tests::stopInvalidatesGeneration},
    Test{"sessionLifecycleIsExposedThroughIpc", Tests::sessionLifecycleIsExposedThroughIpc},
    Test{"diagnosticsExposeRemoteParticipantLevels",
         Tests::diagnosticsExposeRemoteParticipantLevels},
    Test{"latencyRegistrySumsStages", Tests::latencyRegistrySumsStages},
    Test{"traceBufferKeepsOnlyLastEvents", Tests::traceBufferKeepsOnlyLastEvents},
    Test{"traceBufferCountsOverwrittenEvents", Tests::traceBufferCountsOverwrittenEvents},
    Test{"impulseLatencyFindsFrameOffset", Tests::impulseLatencyFindsFrameOffset},
};
} // namespace

int main(int argc, char** argv) {
#if defined(_MSC_VER)
    _CrtSetReportMode(_CRT_ASSERT, _CRTDBG_MODE_FILE);
    _CrtSetReportFile(_CRT_ASSERT, _CRTDBG_FILE_STDERR);
#endif
    const TestDirectory directory;
    Tests::tempRoot = directory.path();

    bool matched = false;
    for (const auto& [name, run] : tests) {
        if (argc > 1 && std::string_view{name} != argv[1])
            continue;
        matched = true;
        try {
            std::cout << "[ RUN      ] " << name << std::endl;
            run();
            std::cout << "[       OK ] " << name << std::endl;
        } catch (const std::exception& error) {
            ++Tests::failures;
            std::cerr << "FAIL: " << name << ": " << error.what() << '\n';
        } catch (...) {
            ++Tests::failures;
            std::cerr << "FAIL: " << name << ": unknown exception\n";
        }
    }

    if (!matched) {
        std::cerr << "No AudioService test matches: " << (argc > 1 ? argv[1] : "") << '\n';
        return 2;
    }
    if (Tests::failures != 0) {
        std::cerr << Tests::failures << " tests failed\n";
        return 1;
    }
    std::cout << "All AudioService tests passed\n";
    return 0;
}
