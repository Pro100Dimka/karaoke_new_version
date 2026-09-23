#include "TestHarness.hpp"

#include <array>
#include <exception>
#include <filesystem>
#include <iostream>
#include <utility>

namespace {
using Test = std::pair<const char*, void (*)()>;

constexpr std::array tests{
    Test{"fakeBackendUsesConfiguredPacketPattern", Tests::fakeBackendUsesConfiguredPacketPattern},
    Test{"fakeBackendAppliesConfiguredDrift", Tests::fakeBackendAppliesConfiguredDrift},
    Test{"fakeBackendAppliesTimestampJitter", Tests::fakeBackendAppliesTimestampJitter},
    Test{"fakeBackendEmitsScheduledFault", Tests::fakeBackendEmitsScheduledFault},
    Test{"fakeBackendCanReproduceStaleCallbackAfterStop",
         Tests::fakeBackendCanReproduceStaleCallbackAfterStop},
    Test{"fakeBackendReplaysTimingTraceWithoutPcmStorage",
         Tests::fakeBackendReplaysTimingTraceWithoutPcmStorage},
    Test{"wasapiExclusiveAppliesListeningLevelCompensation",
         Tests::wasapiExclusiveAppliesListeningLevelCompensation},
    Test{"wasapiExclusiveKeepsMicrophoneCaptureShareable",
         Tests::wasapiExclusiveKeepsMicrophoneCaptureShareable},
    Test{"asioPackedIntegerFormatsUseTheirValidBitDepth",
         Tests::asioPackedIntegerFormatsUseTheirValidBitDepth},
    Test{"asioSampleConversionSupportsDriverReportedFormats",
         Tests::asioSampleConversionSupportsDriverReportedFormats},
    Test{"asioDriverLifecycleStaysInItsCreatingComApartment",
         Tests::asioDriverLifecycleStaysInItsCreatingComApartment},
    Test{"pcmRingPreservesPcm", Tests::pcmRingPreservesPcm},
    Test{"pcmRingRejectsOverflow", Tests::pcmRingRejectsOverflow},
    Test{"generationRingRejectsStalePcm", Tests::generationRingRejectsStalePcm},
    Test{"clockDetectsPositiveDrift", Tests::clockDetectsPositiveDrift},
    Test{"clockRejectsNonMonotonicTimestamp", Tests::clockRejectsNonMonotonicTimestamp},
    Test{"clockNormalizesNominalRates", Tests::clockNormalizesNominalRates},
    Test{"clockUsesDeviceTimestamps", Tests::clockUsesDeviceTimestamps},
    Test{"clockBridgeDoesNotCreep", Tests::clockBridgeDoesNotCreep},
    Test{"signalMeasuresPeakAndRms", Tests::signalMeasuresPeakAndRms},
    Test{"spectrumRespondsToTheFrequencyPlayed", Tests::spectrumRespondsToTheFrequencyPlayed},
    Test{"signalCountsClipping", Tests::signalCountsClipping},
    Test{"analysisRejectsStaleGeneration", Tests::analysisRejectsStaleGeneration},
    Test{"opusCodecRoundTripsSpeechLikeSignal", Tests::opusCodecRoundTripsSpeechLikeSignal},
    Test{"opusDecoderConcealsALostFrame", Tests::opusDecoderConcealsALostFrame},
    Test{"jitterBufferReordersPackets", Tests::jitterBufferReordersPackets},
    Test{"jitterBufferReportsLossExplicitly", Tests::jitterBufferReportsLossExplicitly},
    Test{"jitterBufferWaitsForReorderingWindowBeforeDeclaringLoss",
         Tests::jitterBufferWaitsForReorderingWindowBeforeDeclaringLoss},
    Test{"jitterBufferIsBounded", Tests::jitterBufferIsBounded},
    Test{"remoteParticipantControlsAreIsolated", Tests::remoteParticipantControlsAreIsolated},
    Test{"networkRejectsStaleGeneration", Tests::networkRejectsStaleGeneration},
    Test{"networkAcceptsMultichannelDeviceAudio",
         Tests::networkAcceptsMultichannelDeviceAudio},
    Test{"networkPreparationDoesNotRequireOpusCompatibleDeviceRate",
         Tests::networkPreparationDoesNotRequireOpusCompatibleDeviceRate},
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
    Test{"networkRetimeCorrectionPreservesContinuousVoice",
         Tests::networkRetimeCorrectionPreservesContinuousVoice},
    Test{"roomVoicePlayoutDelayStaysBelowFortyMilliseconds",
         Tests::roomVoicePlayoutDelayStaysBelowFortyMilliseconds},
    Test{"remoteParticipantLifecycleIsSafeDuringDiagnostics",
         Tests::remoteParticipantLifecycleIsSafeDuringDiagnostics},
    Test{"wavDecoderReportsFormat", Tests::wavDecoderReportsFormat},
    Test{"wavDecoderSeekIsDeterministic", Tests::wavDecoderSeekIsDeterministic},
    Test{"slowerRateProducesMoreFrames", Tests::slowerRateProducesMoreFrames},
    Test{"transposeReportsLatency", Tests::transposeReportsLatency},
    Test{"previewLoopStaysInsideRange", Tests::previewLoopStaysInsideRange},
    Test{"seekUpdatesAuthoritativePosition", Tests::seekUpdatesAuthoritativePosition},
    Test{"unloadQuiescesDecoderWorker", Tests::unloadQuiescesDecoderWorker},
    Test{"karaokeTracksShareTransport", Tests::karaokeTracksShareTransport},
    Test{"radioStopsWhenPreviewActivates", Tests::radioStopsWhenPreviewActivates},
    Test{"staleDecodedPcmNeverLeaksAfterSeek", Tests::staleDecodedPcmNeverLeaksAfterSeek},
    Test{"recordingDurationCountsAcceptedPcm", Tests::recordingDurationCountsAcceptedPcm},
    Test{"recordingPauseCreatesGapMetadata", Tests::recordingPauseCreatesGapMetadata},
    Test{"recordingWritesWav", Tests::recordingWritesWav},
    Test{"recordingRejectsStaleGeneration", Tests::recordingRejectsStaleGeneration},
    Test{"prepareRecordingSelectsMasterMixTap", Tests::prepareRecordingSelectsMasterMixTap},
    Test{"performanceMixRecordsVoiceWithoutMonitoring",
         Tests::performanceMixRecordsVoiceWithoutMonitoring},
    Test{"performanceMixExcludesReferenceVocal", Tests::performanceMixExcludesReferenceVocal},
    Test{"performanceMixExcludesMelody", Tests::performanceMixExcludesMelody},
    Test{"disabledDspIsExactBypass", Tests::disabledDspIsExactBypass},
    Test{"dspParametersAreValidated", Tests::dspParametersAreValidated},
    Test{"activePitchReportsLatency", Tests::activePitchReportsLatency},
    Test{"dspOutputRemainsFinite", Tests::dspOutputRemainsFinite},
    Test{"noiseSuppressionPreservesVoicedWaveform",
         Tests::noiseSuppressionPreservesVoicedWaveform},
    Test{"ipcParsesMonitoringCommand", Tests::ipcParsesMonitoringCommand},
    Test{"ipcMapsRemoteParticipantCommand", Tests::ipcMapsRemoteParticipantCommand},
    Test{"ipcMapsRecordingPreviewCommand", Tests::ipcMapsRecordingPreviewCommand},
    Test{"ipcAcceptsNewlineTerminatedRequest", Tests::ipcAcceptsNewlineTerminatedRequest},
    Test{"ipcRejectsMalformedVersion", Tests::ipcRejectsMalformedVersion},
    Test{"seededStateFuzzPreservesSessionInvariants",
         Tests::seededStateFuzzPreservesSessionInvariants},
    Test{"runtimeConfigurationComesFromBackend", Tests::runtimeConfigurationComesFromBackend},
    Test{"unsupportedRateUsesSystemDefault", Tests::unsupportedRateUsesSystemDefault},
    Test{"unspecifiedFormatUsesSystemDefaults", Tests::unspecifiedFormatUsesSystemDefaults},
    Test{"ipcExposesSelectedDeviceCapabilities", Tests::ipcExposesSelectedDeviceCapabilities},
    Test{"systemDefaultFormatChangeRequiresRecovery", Tests::systemDefaultFormatChangeRequiresRecovery},
    Test{"renderTimelineAdvancesInFrames", Tests::renderTimelineAdvancesInFrames},
    Test{"bareMonitoringReachesOutput", Tests::bareMonitoringReachesOutput},
    Test{"leftOnlyMicrophoneIsHeardInBothSpeakers", Tests::leftOnlyMicrophoneIsHeardInBothSpeakers},
    Test{"voiceEffectsAreAudibleInMonitoring", Tests::voiceEffectsAreAudibleInMonitoring},
    Test{"realtimeCallbackHasNoHardRtViolations", Tests::realtimeCallbackHasNoHardRtViolations},
    Test{"deviceLossRecoversWithNewGeneration", Tests::deviceLossRecoversWithNewGeneration},
    Test{"deviceLossCapturesFailureSnapshot", Tests::deviceLossCapturesFailureSnapshot},
    Test{"stopInvalidatesGeneration", Tests::stopInvalidatesGeneration},
    Test{"sessionLifecycleIsExposedThroughIpc", Tests::sessionLifecycleIsExposedThroughIpc},
    Test{"diagnosticsExposeRemoteParticipantLevels", Tests::diagnosticsExposeRemoteParticipantLevels},
    Test{"latencyRegistrySumsStages", Tests::latencyRegistrySumsStages},
    Test{"traceBufferKeepsOnlyLastEvents", Tests::traceBufferKeepsOnlyLastEvents},
    Test{"traceBufferCountsOverwrittenEvents", Tests::traceBufferCountsOverwrittenEvents},
    Test{"impulseLatencyFindsFrameOffset", Tests::impulseLatencyFindsFrameOffset},
};
} // namespace

int main() {
    Tests::tempRoot = std::filesystem::temp_directory_path() / "audioservice-tests";
    std::filesystem::remove_all(Tests::tempRoot);
    std::filesystem::create_directories(Tests::tempRoot);

    for (const auto& [name, run] : tests) {
        try {
            run();
        } catch (const std::exception& error) {
            ++Tests::failures;
            std::cerr << "FAIL: " << name << ": " << error.what() << '\n';
        } catch (...) {
            ++Tests::failures;
            std::cerr << "FAIL: " << name << ": unknown exception\n";
        }
    }

    std::filesystem::remove_all(Tests::tempRoot);
    if (Tests::failures != 0) {
        std::cerr << Tests::failures << " tests failed\n";
        return 1;
    }
    std::cout << "All AudioService tests passed\n";
    return 0;
}
