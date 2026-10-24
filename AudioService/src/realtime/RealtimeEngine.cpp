#include "realtime/RealtimeEngine.hpp"
#include "realtime/DiagnosticVocalPilot.hpp"
#include "media/WavDecoder.hpp"

#include <algorithm>
#include <cmath>
#include <bit>
#include <sstream>
#include <stdexcept>

namespace {
constexpr std::uint32_t TraceCaptureOverrun = 20;
constexpr std::uint32_t TraceRenderUnderrun = 21;
constexpr std::uint32_t TraceBackendEvent = 22;
constexpr double Pi = 3.14159265358979323846;
constexpr std::int64_t NanosecondsPerSecond = 1'000'000'000;
// Shared-mode capture and render events fire in the same engine pass and swap order, so one render
// sees a block that waited a whole period and the next sees one that has just arrived. Averaging
// over about 64 render periods reports the delay the microphone path actually has on average.
constexpr double BridgeLatencySmoothing = 1.0 / 64.0;
} // namespace
RealtimeEngine::RealtimeEngine(MediaController& media, RecordingEngine& recording,
                               AnalysisEngine& analysis, NetworkAudioEngine& network,
                               SignalMetrics& signal, LatencyRegistry& latency,
                               GraphIntrospection& graphInfo, TraceBuffer& trace)
    : media_(media), recording_(recording), analysis_(analysis), network_(network), signal_(signal),
      latency_(latency), graphInfo_(graphInfo), trace_(trace) {}
namespace {
constexpr float MicrophoneEnergySmoothing = 0.2F;
// The saved performance trails the music by 250 ms: room for the slowest voice path it re-aligns.
constexpr std::uint32_t PerformanceLeadDivisor = 4;
// A voice's lateness jitters with capture/render phase; follow it over about 16 render blocks.
constexpr double VoiceLateSmoothing = 1.0 / 16.0;
[[nodiscard]] float pcmPeak(std::span<const float> samples) noexcept {
    float peak = 0.0F;
    for (const auto sample : samples)
        peak = std::max(peak, std::abs(sample));
    return peak;
}
void retainPeak(std::atomic<float>& target, float value) noexcept {
    auto previous = target.load(std::memory_order_relaxed);
    while (previous < value &&
           !target.compare_exchange_weak(previous, value, std::memory_order_relaxed)) {}
}
} // namespace

void RealtimeEngine::prepare(const FinalSessionPlan& plan, GenerationId generation) {
    calibrationContext_ = monotonicTicksNow();
    acousticLatencyNs_.store(0, std::memory_order_relaxed);
    acousticCalibrationValid_ = false;
    plan_ = plan;
    cautiousMonitoring_.store(false, std::memory_order_relaxed);
    channelEnergy_.fill(0.0F);
    selectedInputChannel_.store(0, std::memory_order_relaxed);
    for (auto& rms : inputChannelRms_)
        rms.store(0.0F, std::memory_order_relaxed);
    monitoring_.store(false, std::memory_order_relaxed);
    monitoringSafetyTripped_.store(false, std::memory_order_relaxed);
    monitoringSafetyTripFrame_.store(0, std::memory_order_relaxed);
    monitoringSafetyInputPeak_.store(0.0F, std::memory_order_relaxed);
    monitoringSequence_.store(0, std::memory_order_relaxed);
    renderedMonitoringSequence_ = 0;
    monitorHighFrames_ = 0;
    monitorStartupGain_ = 0.0F;
    generation_.store(generation, std::memory_order_release);
    sessionFrameValue_.store(0, std::memory_order_relaxed);
    performanceFrame_.store(SessionFrame{0}, std::memory_order_relaxed);
    buffers_.prepare(6, plan.maximumBlockFrames, plan.outputChannels);
    captureBridgePcm_.assign(static_cast<std::size_t>(plan.maximumBlockFrames) *
                                plan.outputChannels * 2U, 0.0F);
    renderBridgePcm_.resize(captureBridgePcm_.size());
    diagnosticCaptureInput_.assign(static_cast<std::size_t>(plan.maximumBlockFrames) *
                                       plan.inputChannels, 0.0F);
    diagnosticInputPhase_ = 0.0;
    clockBridge_.prepare(plan.clockBridgeCapacityFrames, plan.clockBridgeTargetFrames,
                         plan.outputChannels * 2U, plan.inputSampleRateHz);
    clocks_.prepare(plan.inputSampleRateHz, plan.internalSampleRateHz);
    dsp_.prepare(plan.inputSampleRateHz, plan.maximumBlockFrames, plan.outputChannels);
    media_.prepare(plan.internalSampleRateHz, plan.outputChannels, plan.internalSampleRateHz / 2U);
    network_.prepare(plan.internalSampleRateHz, plan.outputChannels, plan.internalSampleRateHz / 2U,
                     std::max(1U, plan.internalSampleRateHz / VoicePacketsPerSecond), generation,
                     plan.inputSampleRateHz);
    analysis_.prepare(plan.outputChannels, plan.internalSampleRateHz,
                      plan.internalSampleRateHz / 2U, generation);
    signal_.reset();
    recording_.setGeneration(generation);
    spectrum_.prepare(plan.internalSampleRateHz);
    backingSpectrum_.prepare(plan.internalSampleRateHz);
    ownVoice_.prepare(plan.internalSampleRateHz);
    remoteMixNonzeroBlocks_.store(0, std::memory_order_relaxed);
    remoteMixPeak_.store(0.0F, std::memory_order_relaxed);
    masterOutputNonzeroBlocks_.store(0, std::memory_order_relaxed);
    masterOutputPeak_.store(0.0F, std::memory_order_relaxed);
    aligner_.prepare(plan.outputChannels, plan.internalSampleRateHz / PerformanceLeadDivisor,
                     plan.maximumBlockFrames);
    latencyMeter_.prepare(plan.internalSampleRateHz, plan.inputSampleRateHz);
    // Acoustic correlation is optional diagnostics, not a worker started for normal singing.
    observedMonitoringLatencyNs_.store(-1, std::memory_order_relaxed);
    captureTimelineUsable_.store(false, std::memory_order_relaxed);
    observedLatencySettled_.store(false, std::memory_order_relaxed);
    updateGraphSnapshot();
    latency_.set(LatencyRegistry::Stage::ClockBridge,
                 LatencyRegistry::convertFrames(plan.clockBridgeCapacityFrames,
                                                plan.inputSampleRateHz, plan.internalSampleRateHz),
                 0, 0);
}
void RealtimeEngine::invalidate(GenerationId generation) noexcept {
    generation_.store(generation, std::memory_order_release);
    // Fence stale callbacks first, but preserve the recording generation until its pending
    // aligned PCM is saved. Device recovery/reset must not clear a live take's tail.
    const auto recordingState = recording_.state();
    if (recording_.selectedTap() == RecordingTap::PerformanceMix &&
        (recordingState == RecordingState::Recording || recordingState == RecordingState::Paused)) {
        try {
            (void)finishRecording(RecordingState::Finished);
        } catch (const std::exception& error) {
            recording_.fail(error.what());
        }
    }
    recording_.setGeneration(generation);
    analysis_.setGeneration(generation);
    network_.setGeneration(generation);
}

RecordingResult RealtimeEngine::finishRecording(RecordingState nextState) {
    if (nextState != RecordingState::Paused && nextState != RecordingState::Finished)
        throw std::invalid_argument("recording segment must pause or finish");
    auto cutoff = sessionFrame();
    const auto performance = recording_.state() == RecordingState::Recording &&
                             recording_.selectedTap() == RecordingTap::PerformanceMix;
    // Render skips only file alignment while this control lease is held. Its audible output,
    // capture and network path keep running without waiting for control or disk I/O.
    performanceSuspended_.store(performance);
    struct ResumePerformance {
        std::atomic<bool>& suspended;
        ~ResumePerformance() {
            suspended.store(false);
        }
    } resume{performanceSuspended_};
    if (performance) {
        for (auto readers = performanceReaders_.load(); readers != 0;
             readers = performanceReaders_.load())
            performanceReaders_.wait(readers);
        try {
            cutoff = performanceFrame_.load();
            const auto frames = aligner_.leadFrames();
            // Control owns this scratch. The audible render still uses the realtime buffer pool.
            std::vector<float> tail(static_cast<std::size_t>(frames) * plan_.outputChannels);
            aligner_.read(tail, frames);
            recording_.appendPerformanceTail(cutoff, tail, frames);
        } catch (const std::exception& error) {
            recording_.fail(error.what());
            throw;
        }
    }
    if (nextState == RecordingState::Paused) {
        recording_.pause(cutoff);
        return recording_.result();
    }
    return recording_.stop(cutoff);
}

void RealtimeEngine::reset() noexcept {
    diagnosticInputEnabled_.store(false, std::memory_order_release);
    diagnosticFilePcm_.clear();
    diagnosticFileRateHz_ = 0;
    diagnosticFileFingerprint_ = 0;
    diagnosticFileOffsetFrames_.store(0, std::memory_order_relaxed);
    diagnosticFileSampledFrames_.store(0, std::memory_order_relaxed);
    diagnosticFileEofFrames_.store(0, std::memory_order_relaxed);
    clockBridge_.reset();
    signal_.reset();
    // Render may start before capture. Never seed new device clocks from the old session.
    lastCapturePosition_.store(-1, std::memory_order_relaxed);
    lastCaptureEndFrame_.store(-1, std::memory_order_relaxed);
    micCaptureSkippedFrames_.store(0, std::memory_order_relaxed);
    micCaptureRepeatedFrames_.store(0, std::memory_order_relaxed);
    micInsertedSilenceFrames_.store(0, std::memory_order_relaxed);
    captureRawQpc100ns_.store(0, std::memory_order_relaxed);
    captureEventObservedNs_.store(0, std::memory_order_relaxed);
    captureWakeObservedNs_.store(0, std::memory_order_relaxed);
    captureLastEmptyProbeNs_.store(0, std::memory_order_relaxed);
    captureGetBufferStartedNs_.store(0, std::memory_order_relaxed);
    capturePacketDeliveredNs_.store(0, std::memory_order_relaxed);
    captureEngineStartedNs_.store(0, std::memory_order_relaxed);
    captureBridgeInsertedNs_.store(0, std::memory_order_relaxed);
    captureEventGapUs_.store(0, std::memory_order_relaxed);
    capturePacketGapUs_.store(0, std::memory_order_relaxed);
    capturePacketsThisWake_.store(0, std::memory_order_relaxed);
    captureFramesThisWake_.store(0, std::memory_order_relaxed);
    captureBridgeFillBeforeInsertFrames_.store(0, std::memory_order_relaxed);
    captureBridgeFillAfterInsertFrames_.store(0, std::memory_order_relaxed);
    capturePacketFrames_.store(0, std::memory_order_relaxed);
    micGapCount_.store(0, std::memory_order_relaxed);
    micGapSerial_.store(0, std::memory_order_relaxed);
    micGapAwaitingSubmission_ = false;
    micMonitoringAgeCount_.store(0, std::memory_order_relaxed);
    lastCaptureTimestamp_.store(-1, std::memory_order_relaxed);
    capturePushedAt_.store(0, std::memory_order_relaxed);
    capturedEndTicks_.store(0, std::memory_order_relaxed);
    aligner_.reset();
    voiceLateFrames_ = -1.0;
    lastRenderAt_ = 0;
    bridgeFillAfterRenderFrames_ = 0;
    bridgeLatencyFrames_ = -1.0;
    clocks_.reset();
    dsp_.reset();
    sessionFrameValue_.store(0, std::memory_order_relaxed);
    playReferenceTone(440.0F, 0, 0.0F);
    toneFramesRemaining_ = 0;
}

void RealtimeEngine::loadDiagnosticRoomInputFile(const std::string& path) {
    std::vector<float> mono;
    std::uint32_t rate = 0;
    std::uint64_t fingerprint = 0;
    if (!path.empty()) {
        WavDecoder decoder;
        const auto format = decoder.open(path);
        // Diagnostic-only limits: five minutes, at most 64 MiB decoded mono PCM.
        constexpr std::uint64_t MaxFrames = 64U * 1024U * 1024U / sizeof(float);
        if (format.channels > 2 || format.sampleRateHz < 8'000 || format.sampleRateHz > 192'000 ||
            format.totalFrames == 0 ||
            format.totalFrames > static_cast<std::uint64_t>(format.sampleRateHz) * 300U ||
            format.totalFrames > MaxFrames)
            throw std::invalid_argument("Diagnostic WAV exceeds supported duration/format limits");
        mono.resize(static_cast<std::size_t>(format.totalFrames));
        rate = format.sampleRateHz;
        fingerprint = 14'695'981'039'346'656'037ULL;
        std::array<float, 8'192> chunk{};
        std::size_t offset = 0;
        while (offset < mono.size()) {
            const auto frames = decoder.read(chunk, 4'096);
            if (frames == 0)
                throw std::runtime_error("Diagnostic WAV ended before its declared frames");
            for (std::uint32_t frame = 0; frame < frames; ++frame) {
                float sample = 0.0F;
                for (std::uint32_t channel = 0; channel < format.channels; ++channel) {
                    const auto value = chunk[frame * format.channels + channel];
                    if (!std::isfinite(value) || std::abs(value) > 1.0F)
                        throw std::invalid_argument("Diagnostic WAV contains invalid PCM");
                    sample += value / format.channels;
                }
                mono[offset++] = sample;
                const auto bits = std::bit_cast<std::uint32_t>(sample);
                for (std::uint32_t byte = 0; byte < 4; ++byte) {
                    fingerprint ^= (bits >> (byte * 8U)) & 0xFFU;
                    fingerprint *= 1'099'511'628'211ULL;
                }
            }
        }
    }
    diagnosticFilePcm_.swap(mono);
    diagnosticFileRateHz_ = rate;
    diagnosticFileFingerprint_ = fingerprint;
    diagnosticFileOffsetFrames_.store(0, std::memory_order_relaxed);
    diagnosticFileSampledFrames_.store(0, std::memory_order_relaxed);
    diagnosticFileEofFrames_.store(0, std::memory_order_relaxed);
}

std::string RealtimeEngine::diagnosticRoomInputReport() const {
    std::ostringstream out;
    out << "DiagnosticInputMode: "
        << (!diagnosticInputEnabled_.load(std::memory_order_acquire) ? "Disabled"
            : hasDiagnosticRoomInputFile()                           ? "File"
                                                                     : "Pilot")
        << '\n'
        << "DiagnosticFileFrames: " << diagnosticFilePcm_.size() << '\n'
        << "DiagnosticFileSampleRate: " << diagnosticFileRateHz_ << '\n'
        << "DiagnosticFileMonoPcmFnv1a64: " << std::hex << diagnosticFileFingerprint_ << std::dec
        << '\n'
        << "DiagnosticFileSampledFrames: " << diagnosticFileSampledFrames_.load() << '\n'
        << "DiagnosticFileEofFrames: " << diagnosticFileEofFrames_.load() << '\n';
    out << "DiagnosticFileOffsetFrames: " << diagnosticFileOffsetFrames_.load() << '\n'
        << "DiagnosticFilePilotGain: " << diagnosticFilePilotGain_.load() << '\n'
        << "DiagnosticInputFrequencyHz: " << diagnosticInputFrequencyHz_.load() << '\n'
        << "DiagnosticInputMusicalStartUnixMs: " << diagnosticInputMusicalStartUnixMs_.load()
        << '\n';
    return out.str();
}
void RealtimeEngine::setDspEnabled(bool enabled) noexcept {
    dspEnabled_.store(enabled, std::memory_order_relaxed);
    dsp_.setEnabled(enabled);
    latency_.set(LatencyRegistry::Stage::Dsp, 0, dspLatencyFrames(), 0);
    updateGraphSnapshot();
}
bool RealtimeEngine::setDspParameter(std::string_view name, float value) noexcept {
    if (!dsp_.setParameter(name, value))
        return false;
    latency_.set(LatencyRegistry::Stage::Dsp, 0, dspLatencyFrames(), 0);
    updateGraphSnapshot();
    return true;
}
void RealtimeEngine::updateGraphSnapshot() {
    GraphSnapshot snapshot;
    snapshot.poolBytes = buffers_.bytes();
    if (plan_.inputChannels != 0) {
        snapshot.stages.push_back({"Capture", 0, 0});
        snapshot.stages.push_back({"InputBoundaryConversion", 0, 0});
        snapshot.stages.push_back({"RawInput", 0, 0});
        snapshot.stages.push_back({"MicrophoneGate", 0, 0});
        if (dspEnabled_.load(std::memory_order_relaxed))
            snapshot.stages.push_back({"DSP", 0, dspLatencyFrames()});
        if (plan_.independentClocks || plan_.needsInputResampling)
            snapshot.stages.push_back({"ClockBridge", plan_.clockBridgeTargetFrames, 0});
        snapshot.stages.push_back({"InputGain", 0, 0});
    }
    snapshot.stages.push_back({"Mixer", 0, 0});
    snapshot.stages.push_back({"OutputBoundaryConversion", 0, 0});
    snapshot.stages.push_back({"Render", 0, 0});
    graphInfo_.set(std::move(snapshot));
}
void RealtimeEngine::playReferenceTone(float frequencyHz, std::uint32_t durationFrames,
                                       float gain) noexcept {
    if (!std::isfinite(frequencyHz) || !std::isfinite(gain)) {
        frequencyHz = 440.0F;
        gain = 0.0F;
        durationFrames = 0;
    }
    toneCommandSequence_.fetch_add(1, std::memory_order_acq_rel);
    toneFrequencyHz_.store(std::clamp(frequencyHz, 20.0F, 12000.0F), std::memory_order_relaxed);
    toneGain_.store(std::clamp(gain, 0.0F, 0.25F), std::memory_order_relaxed);
    toneDurationFrames_.store(durationFrames, std::memory_order_relaxed);
    toneCommandSequence_.fetch_add(1, std::memory_order_release);
}
// A microphone is one voice: use the strongest physical input channel and centre it in every
// output channel. Summing an ASIO pair is unsafe because many interfaces expose the same input on
// two channels with opposite polarity; averaging that pair cancels a perfectly healthy microphone.
void RealtimeEngine::mapMicrophone(std::span<const float> input, std::uint32_t inputChannels,
                                   std::span<float> output, std::uint32_t outputChannels,
                                   std::uint32_t frames) noexcept {
    if (inputChannels == 0 || outputChannels == 0)
        return;
    std::uint32_t selectedChannel = 0;
    float strongestEnergy = -1.0F;
    for (std::uint32_t channel = 0; channel < inputChannels; ++channel) {
        float squares = 0.0F;
        for (std::uint32_t frame = 0; frame < frames; ++frame) {
            const auto sample = input[static_cast<std::size_t>(frame) * inputChannels + channel];
            squares += sample * sample;
        }
        auto& energy = channelEnergy_[channel];
        energy += (squares / static_cast<float>(frames) - energy) * MicrophoneEnergySmoothing;
        inputChannelRms_[channel].store(std::sqrt(energy), std::memory_order_relaxed);
        if (energy > strongestEnergy) {
            strongestEnergy = energy;
            selectedChannel = channel;
        }
    }
    // ASIO stereo inputs can have nearly identical levels but opposite polarity. Re-selecting
    // the loudest channel on every callback splices unrelated waveforms into one voice.
    const auto previous = selectedInputChannel_.load(std::memory_order_relaxed);
    constexpr float ActiveEnergy = 1.0e-6F;
    if (previous < inputChannels &&
        (strongestEnergy <= ActiveEnergy ||
         (channelEnergy_[previous] >= ActiveEnergy * 0.25F &&
          strongestEnergy <= channelEnergy_[previous] * 16.0F)))
        selectedChannel = previous;
    selectedInputChannel_.store(selectedChannel, std::memory_order_relaxed);
    for (std::uint32_t frame = 0; frame < frames; ++frame) {
        const auto value = input[static_cast<std::size_t>(frame) * inputChannels + selectedChannel];
        for (std::uint32_t outCh = 0; outCh < outputChannels; ++outCh)
            output[static_cast<std::size_t>(frame) * outputChannels + outCh] = value;
    }
}
void RealtimeEngine::onCapture(GenerationId generation, const BackendAudioBuffer& buffer) noexcept {
    if (generation != generation_.load(std::memory_order_acquire)) {
        staleCallbacks_.fetch_add(1, std::memory_order_relaxed);
        return;
    }
    if (buffer.input == nullptr || buffer.frames == 0 || buffer.frames > plan_.maximumBlockFrames ||
        buffer.channels == 0 || buffer.channels > MaxAudioChannels) {
        return;
    }
    RealtimeScope rtScope;
    const auto engineProcessingStarted = monotonicTicksNow();
    const auto expectedFrame = lastCaptureEndFrame_.exchange(
        static_cast<std::int64_t>(buffer.devicePosition + buffer.frames),
        std::memory_order_relaxed);
    if (expectedFrame >= 0) {
        const auto difference = static_cast<std::int64_t>(buffer.devicePosition) - expectedFrame;
        if (difference > 0)
            micCaptureSkippedFrames_.fetch_add(static_cast<std::uint64_t>(difference),
                                               std::memory_order_relaxed);
        else if (difference < 0)
            micCaptureRepeatedFrames_.fetch_add(
                static_cast<std::uint64_t>(std::min<std::int64_t>(-difference, buffer.frames)),
                std::memory_order_relaxed);
    }
    const auto deliveredAt = monotonicTicksNow();
    const auto duration =
        static_cast<MonotonicTicks>(buffer.frames) * NanosecondsPerSecond / plan_.inputSampleRateHz;
    // A packet's first frame was recorded at least its own length before it was delivered. Some
    // drivers stamp the packet's end instead of its start (WASAPI documents the start); taken at
    // face value that made every voice one capture period late and inflated the measured hidden
    // latency by the same period. The stamp is held to the latest physically possible moment.
    const auto captureStart =
        buffer.captureTicks == 0 ? 0 : std::min(buffer.captureTicks, deliveredAt - duration);
    captureTimelineUsable_.store(buffer.captureTimestampValid && captureStart > 0,
                                  std::memory_order_relaxed);
    captureStampCorrectionNs_.store(buffer.captureTicks - captureStart, std::memory_order_relaxed);
    captureStampDeliveredAtNs_.store(deliveredAt, std::memory_order_relaxed);
    captureStampCorrectedStartNs_.store(captureStart, std::memory_order_relaxed);
    const auto inputSamples = static_cast<std::size_t>(buffer.frames) * buffer.channels;
    auto captureInput = std::span<const float>{buffer.input, inputSamples};
    if (diagnosticInputEnabled_.load(std::memory_order_acquire) &&
        diagnosticCaptureInput_.size() >= inputSamples) {
        const auto frequency = std::clamp(
            diagnosticInputFrequencyHz_.load(std::memory_order_relaxed), 0.0F, 20'000.0F);
        const auto gain =
            std::clamp(diagnosticInputGain_.load(std::memory_order_relaxed), 0.0F, 1.0F);
        const auto pilotGain =
            std::clamp(diagnosticFilePilotGain_.load(std::memory_order_relaxed), 0.0F, 0.1F);
        const auto fileOffsetFrames = diagnosticFileOffsetFrames_.load(std::memory_order_relaxed);
        const auto musicalStartUnixMs =
            diagnosticInputMusicalStartUnixMs_.load(std::memory_order_relaxed);
        const auto musicalStartFrame =
            musicalStartUnixMs / 1'000U * plan_.internalSampleRateHz +
            musicalStartUnixMs % 1'000U * plan_.internalSampleRateHz / 1'000U;
        const auto captureRoomFrame =
            musicalStartUnixMs == 0
                ? 0U
                : network_.roomTimelineFrame(
                      captureStart == 0 ? deliveredAt - duration : captureStart, 0);
        const auto step = 2.0 * Pi * static_cast<double>(frequency) / plan_.inputSampleRateHz;
        std::uint32_t sampledFrames = 0, eofFrames = 0;
        for (std::uint32_t frame = 0; frame < buffer.frames; ++frame) {
            const auto musicalFrame = captureRoomFrame + static_cast<std::uint64_t>(frame) *
                                                             plan_.internalSampleRateHz /
                                                             plan_.inputSampleRateHz;
            float sample = 0.0F;
            if (!diagnosticFilePcm_.empty()) {
                if (musicalStartUnixMs != 0 && musicalFrame >= musicalStartFrame) {
                    const auto position = static_cast<double>(fileOffsetFrames) +
                                          static_cast<double>(musicalFrame - musicalStartFrame) *
                                              diagnosticFileRateHz_ / plan_.internalSampleRateHz;
                    if (position < diagnosticFilePcm_.size()) {
                        const auto first = static_cast<std::size_t>(position);
                        const auto next = std::min(first + 1U, diagnosticFilePcm_.size() - 1U);
                        const auto fraction = static_cast<float>(position - first);
                        sample = std::lerp(diagnosticFilePcm_[first], diagnosticFilePcm_[next],
                                           fraction) *
                                 gain;
                        if (pilotGain > 0.0F)
                            sample += diagnosticVocalPilotSample(
                                musicalFrame - musicalStartFrame +
                                    fileOffsetFrames * plan_.internalSampleRateHz /
                                        diagnosticFileRateHz_,
                                0, plan_.internalSampleRateHz, frequency, pilotGain,
                                diagnosticInputMarkerPeriodMs_.load(std::memory_order_relaxed));
                        ++sampledFrames;
                    } else {
                        ++eofFrames;
                    }
                }
            } else {
                sample = musicalStartUnixMs == 0
                             ? static_cast<float>(std::sin(diagnosticInputPhase_) * gain)
                             : diagnosticVocalPilotSample(
                                   musicalFrame, musicalStartFrame, plan_.internalSampleRateHz,
                                   frequency, gain,
                                   diagnosticInputMarkerPeriodMs_.load(std::memory_order_relaxed));
            }
            for (std::uint32_t channel = 0; channel < buffer.channels; ++channel)
                diagnosticCaptureInput_[static_cast<std::size_t>(frame) * buffer.channels +
                                        channel] = sample;
            diagnosticInputPhase_ += step;
            if (diagnosticInputPhase_ >= 2.0 * Pi)
                diagnosticInputPhase_ -= 2.0 * Pi;
        }
        diagnosticFileSampledFrames_.fetch_add(sampledFrames, std::memory_order_relaxed);
        diagnosticFileEofFrames_.fetch_add(eofFrames, std::memory_order_relaxed);
        captureInput = {diagnosticCaptureInput_.data(), inputSamples};
    }
    signal_.observe(captureInput);
    auto mapped = buffers_.buffer(0, buffer.frames);
    mapMicrophone(captureInput, buffer.channels, mapped, plan_.outputChannels, buffer.frames);
    for (std::uint32_t frame = 0; frame < buffer.frames; ++frame)
        for (std::uint32_t channel = 0; channel < plan_.outputChannels; ++channel)
            captureBridgePcm_[(frame * 2U + 1U) * plan_.outputChannels + channel] =
                mapped[frame * plan_.outputChannels + channel];
    const auto microphoneEnabled = microphoneEnabled_.load(std::memory_order_relaxed);
    if (microphoneEnabled)
        dsp_.process(mapped, buffer.frames);
    else
        std::fill(mapped.begin(), mapped.end(), 0.0F);
    // Capture is the sole DSP/send producer. Output callbacks cannot hold upstream PCM hostage.
    const auto sungAt = voiceSungAt(captureStart == 0 ? deliveredAt - duration : captureStart);
    network_.pushLocal(generation, mapped, buffer.frames,
                       network_.roomTimelineFrame(sungAt,
                           scaleFramePosition(static_cast<std::uint64_t>(
                               std::max<std::int64_t>(0, buffer.devicePosition)),
                               plan_.inputSampleRateHz, plan_.internalSampleRateHz)),
                       microphoneEnabled ? mixer_.gains().microphone : 0.0F,
                       network_.roomTimelineFrame(captureStart, 0),
                       network_.hasRoomClock() && buffer.captureTimestampValid && captureStart > 0);
    for (std::uint32_t frame = 0; frame < buffer.frames; ++frame)
        for (std::uint32_t channel = 0; channel < plan_.outputChannels; ++channel)
            captureBridgePcm_[frame * 2U * plan_.outputChannels + channel] =
                mapped[frame * plan_.outputChannels + channel];
    const auto bridgeFillBeforeInsert = clockBridge_.snapshot().fillFrames;
    if (!clockBridge_.push(captureBridgePcm_, buffer.frames)) {
        captureOverruns_.fetch_add(1, std::memory_order_relaxed);
        trace_.push(
            {monotonicTicksNow(), sessionFrame(), generation, TraceCaptureOverrun, buffer.frames});
    } else {
        const auto pushedAt = monotonicTicksNow();
        capturePushedAt_.store(pushedAt, std::memory_order_relaxed);
        const auto capturedEnd = captureStart == 0 ? 0 : captureStart + duration;
        capturedEndTicks_.store(capturedEnd, std::memory_order_relaxed);
        captureAgeNs_.store(capturedEnd == 0 ? 0 : pushedAt - capturedEnd,
                            std::memory_order_relaxed);
        captureRawQpc100ns_.store(buffer.captureTiming.rawQpc100ns, std::memory_order_relaxed);
        captureWakeObservedNs_.store(buffer.captureTiming.wakeObservedNs, std::memory_order_relaxed);
        captureEventObservedNs_.store(buffer.captureTiming.captureEventObservedNs,
                                      std::memory_order_relaxed);
        captureLastEmptyProbeNs_.store(buffer.captureTiming.lastEmptyPacketProbeNs,
                                        std::memory_order_relaxed);
        captureGetBufferStartedNs_.store(buffer.captureTiming.getBufferStartedNs,
                                          std::memory_order_relaxed);
        capturePacketDeliveredNs_.store(buffer.captureTiming.packetDeliveredNs,
                                         std::memory_order_relaxed);
        captureEngineStartedNs_.store(engineProcessingStarted, std::memory_order_relaxed);
        captureBridgeInsertedNs_.store(pushedAt, std::memory_order_relaxed);
        captureEventGapUs_.store(buffer.captureTiming.captureEventGapUs,
                                  std::memory_order_relaxed);
        capturePacketGapUs_.store(buffer.captureTiming.packetQpcGapUs,
                                   std::memory_order_relaxed);
        capturePacketsThisWake_.store(buffer.captureTiming.packetsThisWake,
                                       std::memory_order_relaxed);
        captureFramesThisWake_.store(buffer.captureTiming.framesThisWake,
                                      std::memory_order_relaxed);
        captureBridgeFillBeforeInsertFrames_.store(bridgeFillBeforeInsert,
                                                    std::memory_order_relaxed);
        captureBridgeFillAfterInsertFrames_.store(clockBridge_.snapshot().fillFrames,
                                                   std::memory_order_relaxed);
        capturePacketFrames_.store(buffer.frames, std::memory_order_relaxed);
    }
    latencyMeter_.capture(captureInput, buffer.frames, buffer.channels, captureStart,
                          buffer.devicePosition, buffer.captureTicks, deliveredAt);
    lastCapturePosition_.store(buffer.devicePosition, std::memory_order_relaxed);
    lastCaptureTimestamp_.store(buffer.timestamp, std::memory_order_relaxed);
}
std::uint32_t RealtimeEngine::addMedia(MediaSlot slot, std::span<float> output,
                                       std::uint32_t frames, float gain,
                                       MonotonicTicks presentationTicks) noexcept {
    auto scratch = buffers_.buffer(2, frames);
    std::fill(scratch.begin(), scratch.end(), 0.0F);
    const auto rendered = media_.render(slot, scratch, frames, presentationTicks);
    mixer_.add(output, scratch, gain);
    return static_cast<std::uint32_t>(rendered);
}
// Test and synchronisation tones play at `level` of their gain, fading in and out over ten cycles:
// a pure tone that starts at full level is heard as a painful click.
void RealtimeEngine::renderTone(std::span<float> output, std::uint32_t frames,
                                float level) noexcept {
    const auto sequence = toneCommandSequence_.load(std::memory_order_acquire);
    if ((sequence & 1U) == 0 && sequence != renderedToneSequence_) {
        const auto frequency = toneFrequencyHz_.load(std::memory_order_relaxed);
        const auto gain = toneGain_.load(std::memory_order_relaxed);
        const auto duration = toneDurationFrames_.load(std::memory_order_relaxed);
        std::atomic_thread_fence(std::memory_order_acquire);
        if (sequence == toneCommandSequence_.load(std::memory_order_relaxed)) {
            renderedToneFrequencyHz_ = frequency;
            renderedToneGain_ = gain;
            toneFramesRemaining_ = duration;
            renderedToneDurationFrames_ = duration;
            tonePhase_ = 0.0;
            renderedToneSequence_ = sequence;
        }
    }
    if (toneFramesRemaining_ == 0)
        return;
    const auto count = std::min(frames, toneFramesRemaining_);
    const auto step =
        2.0 * Pi * static_cast<double>(renderedToneFrequencyHz_) / plan_.internalSampleRateHz;
    constexpr double FadeCycles = 10.0;
    const auto fadeFrames =
        std::max(1.0, std::min(FadeCycles * 2.0 * Pi / step, renderedToneDurationFrames_ / 2.0));
    for (std::uint32_t frame = 0; frame < count; ++frame) {
        const auto played =
            static_cast<double>(renderedToneDurationFrames_ - toneFramesRemaining_ + frame);
        const auto left = static_cast<double>(toneFramesRemaining_ - frame);
        const auto fade =
            static_cast<float>(std::min({1.0, played / fadeFrames, left / fadeFrames}));
        const auto sample =
            static_cast<float>(std::sin(tonePhase_)) * renderedToneGain_ * level * fade;
        tonePhase_ += step;
        if (tonePhase_ >= 2.0 * Pi)
            tonePhase_ -= 2.0 * Pi;
        for (std::uint32_t ch = 0; ch < plan_.outputChannels; ++ch)
            output[static_cast<std::size_t>(frame) * plan_.outputChannels + ch] += sample;
    }
    toneFramesRemaining_ -= count;
}
// Backends that know when rendered PCM reaches the device measure the whole output path, including
// endpoint queueing that a driver-reported stream latency omits (WASAPI Shared reports zero).
void RealtimeEngine::publishOutputLatency(MonotonicTicks presentationTicks,
                                          MonotonicTicks renderAt) noexcept {
    const auto queuedNs = presentationTicks - renderAt;
    if (presentationTicks == 0 || queuedNs <= 0)
        return;
    const auto frames = queuedNs * plan_.internalSampleRateHz / NanosecondsPerSecond;
    latency_.set(LatencyRegistry::Stage::OutputDriver, 0, 0,
                 static_cast<std::uint32_t>(std::min<std::int64_t>(frames, UINT32_MAX)));
}
// A song keeps one follow shift from its first sounding frame until it stops, pauses included.
// Letting it follow the leader's measured delay mid-song moved the follower's music (and the voice
// the leader hears from it) by tens of milliseconds whenever the follower's network wavered, and a
// pause could switch following off for the rest of the song. Between songs it is taken at once.
std::uint32_t RealtimeEngine::followRoomDelay(std::uint32_t targetFrames) noexcept {
    if (!songUnderway_)
        followAppliedFrames_ = targetFrames;
    return followAppliedFrames_;
}
// Consecutive blocks should be presented back to back; a break means the device clock (or its
// timestamp) jumped, and everything scheduled on presentation times moves with it.
void RealtimeEngine::notePresentationContinuity(MonotonicTicks presentationTicks,
                                                std::uint32_t frames) noexcept {
    constexpr MonotonicTicks JumpThresholdNs = 1'000'000;
    if (presentationTicks == 0)
        return;
    if (nextPresentationTicks_ != 0) {
        const auto jump = std::llabs(presentationTicks - nextPresentationTicks_);
        if (jump > JumpThresholdNs) {
            presentationJumps_.fetch_add(1, std::memory_order_relaxed);
            if (jump > presentationJumpMaxNs_.load(std::memory_order_relaxed))
                presentationJumpMaxNs_.store(jump, std::memory_order_relaxed);
        }
    }
    nextPresentationTicks_ = presentationTicks + static_cast<MonotonicTicks>(frames) *
                                                     NanosecondsPerSecond /
                                                     plan_.internalSampleRateHz;
}
// Mean bridge fill since the previous render is the microphone delay through the bridge (Little's
// law). A single sample is wrong whenever capture and render events swap order: before the pull it
// counts a block that has just arrived, after the pull it misses the block about to be consumed.
// One push per render interval is assumed; with more, the latest push bounds the estimate.
double RealtimeEngine::meanBridgeFillFrames(std::uint32_t fillBeforePullFrames,
                                            MonotonicTicks renderAt) const noexcept {
    const auto intervalNs = renderAt - lastRenderAt_;
    if (lastRenderAt_ == 0 || intervalNs <= 0)
        return fillBeforePullFrames;
    const auto pushedAt =
        std::clamp(capturePushedAt_.load(std::memory_order_relaxed), lastRenderAt_, renderAt);
    const auto area =
        static_cast<double>(bridgeFillAfterRenderFrames_) *
            static_cast<double>(pushedAt - lastRenderAt_) +
        static_cast<double>(fillBeforePullFrames) * static_cast<double>(renderAt - pushedAt);
    return area / static_cast<double>(intervalNs);
}
std::uint32_t RealtimeEngine::smoothBridgeLatencyFrames(double meanFillFrames) noexcept {
    bridgeLatencyFrames_ = bridgeLatencyFrames_ < 0.0
                               ? meanFillFrames
                               : bridgeLatencyFrames_ + (meanFillFrames - bridgeLatencyFrames_) *
                                                            BridgeLatencySmoothing;
    return static_cast<std::uint32_t>(std::lround(bridgeLatencyFrames_));
}
// Device capture time of the microphone samples pulled now: the newest bridged sample minus
// everything still waiting before it. Without device capture times the configured capture latency
// and the bridge fill are used instead.
MonotonicTicks
RealtimeEngine::micCapturedAt(std::uint32_t bridgeFillBeforePullFrames) const noexcept {
    const auto capturedEnd = capturedEndTicks_.load(std::memory_order_relaxed);
    MonotonicTicks capturedAt = 0;
    if (capturedEnd != 0) {
        capturedAt = capturedEnd - static_cast<MonotonicTicks>(bridgeFillBeforePullFrames) *
                                       NanosecondsPerSecond / plan_.inputSampleRateHz;
    } else {
        const auto capture = latency_.get(LatencyRegistry::Stage::Capture);
        const auto frames =
            static_cast<std::uint64_t>(capture.algorithmicFrames) + capture.currentFillFrames +
            LatencyRegistry::convertFrames(bridgeFillBeforePullFrames, plan_.inputSampleRateHz,
                                           plan_.internalSampleRateHz);
        capturedAt = monotonicTicksNow() - static_cast<MonotonicTicks>(frames) *
                                               NanosecondsPerSecond / plan_.internalSampleRateHz;
    }
    return capturedAt;
}
// Song-timeline moment of the microphone samples pulled now: their capture time minus the acoustic
// latency the devices do not report and the DSP delay.
MonotonicTicks
RealtimeEngine::voiceSungAt(MonotonicTicks capturedAt) const noexcept {
    const auto dspNs = static_cast<MonotonicTicks>(dspLatencyFrames()) *
                       NanosecondsPerSecond / plan_.internalSampleRateHz;
    return capturedAt -
           acousticLatencyNs_.load(std::memory_order_relaxed) - dspNs;
}
std::uint32_t RealtimeEngine::dspLatencyFrames() const noexcept {
    return dspEnabled_.load(std::memory_order_relaxed)
        ? LatencyRegistry::convertFrames(dsp_.latencyFrames(), plan_.inputSampleRateHz,
                                          plan_.internalSampleRateHz)
        : 0U;
}
// How far the pulled voice trails the music rendered now, smoothed over capture/render phase.
std::uint32_t RealtimeEngine::smoothVoiceLateFrames(MonotonicTicks presentationTicks,
                                                    MonotonicTicks sungAt) noexcept {
    const auto lateFrames =
        static_cast<double>(std::max<MonotonicTicks>(0, presentationTicks - sungAt)) *
        plan_.internalSampleRateHz / static_cast<double>(NanosecondsPerSecond);
    voiceLateFrames_ = voiceLateFrames_ < 0.0 ? lateFrames
                                              : voiceLateFrames_ + (lateFrames - voiceLateFrames_) *
                                                                       VoiceLateSmoothing;
    return static_cast<std::uint32_t>(std::lround(voiceLateFrames_));
}
void RealtimeEngine::onRender(GenerationId generation, const BackendAudioBuffer& buffer) noexcept {
    if (generation != generation_.load(std::memory_order_acquire)) {
        staleCallbacks_.fetch_add(1, std::memory_order_relaxed);
        return;
    }
    if (buffer.output == nullptr || buffer.frames == 0 ||
        buffer.frames > plan_.maximumBlockFrames || buffer.channels != plan_.outputChannels)
        return;
    RealtimeScope rtScope;
    performanceReaders_.fetch_add(1);
    const auto performanceActive = !performanceSuspended_.load();
    const auto releasePerformance = [this] {
        if (performanceReaders_.fetch_sub(1) == 1 && performanceSuspended_.load())
            performanceReaders_.notify_all();
    };
    if (!performanceActive)
        releasePerformance();
    struct PerformanceLease {
        decltype(releasePerformance)& release;
        bool active;
        ~PerformanceLease() {
            if (active)
                release();
        }
    } performanceLease{releasePerformance, performanceActive};
    const auto renderAt = monotonicTicksNow();
    publishOutputLatency(buffer.presentationTicks, renderAt);
    notePresentationContinuity(buffer.presentationTicks, buffer.frames);
    const auto samples = static_cast<std::size_t>(buffer.frames) * buffer.channels;
    auto output = std::span<float>{buffer.output, samples};
    mixer_.clear(output);
    auto mic = buffers_.buffer(1, buffer.frames);
    auto rawMic = buffers_.buffer(5, buffer.frames);
    const auto bridgeFillBeforePullFrames = clockBridge_.snapshot().fillFrames;
    std::uint32_t micFrames = 0;
    if (plan_.inputChannels == 0) {
        std::fill(mic.begin(), mic.end(), 0.0F);
        std::fill(rawMic.begin(), rawMic.end(), 0.0F);
    } else {
        const auto capturePosition = lastCapturePosition_.load(std::memory_order_relaxed);
        clocks_.observe({capturePosition, buffer.devicePosition,
                         lastCaptureTimestamp_.load(std::memory_order_relaxed), buffer.timestamp,
                         true});
        const auto nominalRatio = static_cast<double>(plan_.inputSampleRateHz) /
                                  static_cast<double>(plan_.internalSampleRateHz);
        micFrames = clockBridge_.pull(renderBridgePcm_, buffer.frames,
                                      nominalRatio * clocks_.correctionRatio());
        for (std::uint32_t frame = 0; frame < buffer.frames; ++frame)
            for (std::uint32_t channel = 0; channel < plan_.outputChannels; ++channel) {
                mic[frame * plan_.outputChannels + channel] =
                    renderBridgePcm_[frame * 2U * plan_.outputChannels + channel];
                rawMic[frame * plan_.outputChannels + channel] =
                    renderBridgePcm_[(frame * 2U + 1U) * plan_.outputChannels + channel];
            }
        if (micFrames < buffer.frames) {
            renderUnderruns_.fetch_add(1, std::memory_order_relaxed);
            micInsertedSilenceFrames_.fetch_add(buffer.frames - micFrames,
                                               std::memory_order_relaxed);
            trace_.push({monotonicTicksNow(), sessionFrame(), generation, TraceRenderUnderrun,
                         buffer.frames - micFrames});
            micGapSerial_.fetch_add(1, std::memory_order_acq_rel);
            micGapMissingFrames_.store(buffer.frames - micFrames, std::memory_order_relaxed);
            micGapBridgeAvailableFrames_.store(bridgeFillBeforePullFrames,
                                               std::memory_order_relaxed);
            micGapRequestedFrames_.store(buffer.frames, std::memory_order_relaxed);
            micGapCaptureDevicePosition_.store(lastCapturePosition_.load(std::memory_order_relaxed),
                                                std::memory_order_relaxed);
            micGapRawQpc100ns_.store(captureRawQpc100ns_.load(std::memory_order_relaxed),
                                      std::memory_order_relaxed);
            micGapLastEmptyProbeNs_.store(buffer.captureTiming.lastEmptyPacketProbeNs != 0
                                              ? buffer.captureTiming.lastEmptyPacketProbeNs
                                              : captureLastEmptyProbeNs_.load(std::memory_order_relaxed),
                                           std::memory_order_relaxed);
            micGapCaptureEventObservedNs_.store(captureEventObservedNs_.load(std::memory_order_relaxed),
                                                std::memory_order_relaxed);
            micGapWakeObservedNs_.store(captureWakeObservedNs_.load(std::memory_order_relaxed),
                                         std::memory_order_relaxed);
            micGapGetBufferStartedNs_.store(captureGetBufferStartedNs_.load(std::memory_order_relaxed),
                                             std::memory_order_relaxed);
            micGapPacketDeliveredNs_.store(capturePacketDeliveredNs_.load(std::memory_order_relaxed),
                                            std::memory_order_relaxed);
            micGapEngineStartedNs_.store(captureEngineStartedNs_.load(std::memory_order_relaxed),
                                          std::memory_order_relaxed);
            micGapBridgeInsertedNs_.store(captureBridgeInsertedNs_.load(std::memory_order_relaxed),
                                           std::memory_order_relaxed);
            micGapRenderWakeNs_.store(buffer.captureTiming.wakeObservedNs,
                                      std::memory_order_relaxed);
            micGapRenderConsumedNs_.store(monotonicTicksNow(), std::memory_order_relaxed);
            micGapRenderSubmittedNs_.store(0, std::memory_order_relaxed);
            micGapPresentationNs_.store(buffer.presentationTicks, std::memory_order_relaxed);
            micGapStampCorrectionNs_.store(captureStampCorrectionNs_.load(std::memory_order_relaxed),
                                            std::memory_order_relaxed);
            micGapCaptureEventGapUs_.store(captureEventGapUs_.load(std::memory_order_relaxed),
                                            std::memory_order_relaxed);
            micGapPacketGapUs_.store(capturePacketGapUs_.load(std::memory_order_relaxed),
                                      std::memory_order_relaxed);
            micGapPacketsThisWake_.store(capturePacketsThisWake_.load(std::memory_order_relaxed),
                                          std::memory_order_relaxed);
            micGapFramesThisWake_.store(captureFramesThisWake_.load(std::memory_order_relaxed),
                                         std::memory_order_relaxed);
            micGapRenderWakePackets_.store(buffer.captureTiming.packetsThisWake,
                                           std::memory_order_relaxed);
            micGapRenderWakeFrames_.store(buffer.captureTiming.framesThisWake,
                                          std::memory_order_relaxed);
            micGapPacketFrames_.store(capturePacketFrames_.load(std::memory_order_relaxed),
                                       std::memory_order_relaxed);
            micGapBridgeFillBeforeInsertFrames_.store(
                captureBridgeFillBeforeInsertFrames_.load(std::memory_order_relaxed),
                std::memory_order_relaxed);
            micGapBridgeFillAfterInsertFrames_.store(
                captureBridgeFillAfterInsertFrames_.load(std::memory_order_relaxed),
                std::memory_order_relaxed);
            micGapCount_.fetch_add(1, std::memory_order_relaxed);
            micGapSerial_.fetch_add(1, std::memory_order_release);
            micGapAwaitingSubmission_ = true;
        }
    }
    // Device-timeline origin of the microphone samples pulled from the clock bridge.
    const auto micCaptured = micCapturedAt(bridgeFillBeforePullFrames);
    // Every downstream tap uses the negotiated internal clock after boundary conversion.
    recording_.push(generation, RecordingTap::RawInput, sessionFrame(), rawMic, buffer.frames);
    // Raw input has no DSP delay. Driver/bridge residence is already in micCaptured.
    analysis_.push(generation, rawMic, buffer.frames,
                   micCaptured - acousticLatencyNs_.load(std::memory_order_relaxed));
    const auto gains = mixer_.gains();
    const auto microphoneEnabled = microphoneEnabled_.load(std::memory_order_relaxed);
    auto monitoring = monitoring_.load(std::memory_order_relaxed);
    const auto monitoringSequence = monitoringSequence_.load(std::memory_order_relaxed);
    if (monitoringSequence != renderedMonitoringSequence_) {
        renderedMonitoringSequence_ = monitoringSequence;
        monitorHighFrames_ = 0;
        monitorStartupGain_ = 0.0F;
    }
    if (microphoneEnabled) {
        ownVoice_.note(mic, plan_.outputChannels, buffer.frames);
        recording_.push(generation, RecordingTap::ProcessedVoice, sessionFrame(), mic,
                        buffer.frames);
        if (monitoring) {
            // A speaker-to-microphone loop can grow far faster than a UI poll. Keep the local
            // monitor bounded and disconnect it if loud input persists; the processed voice is
            // still sent to recording and the room. This adds no buffering to the voice path.
            const auto peak = pcmPeak(mic);
            double power = 0.0;
            for (const auto sample : mic)
                power += static_cast<double>(sample) * sample;
            const auto rms = std::sqrt(power / std::max<std::size_t>(1, mic.size()));
            const auto cautious = cautiousMonitoring_.load(std::memory_order_relaxed);
            // Ordinary singing can exceed -6 dBFS. Only sustained input near clipping trips
            // this guard; the sample limiter below handles loud but valid voice immediately.
            if (peak > (cautious ? 0.9F : 0.95F) && rms > 0.65) {
                monitorHighFrames_ = std::min(plan_.internalSampleRateHz,
                                              monitorHighFrames_ + buffer.frames);
            } else {
                monitorHighFrames_ = 0;
            }
            if (monitorHighFrames_ >= plan_.internalSampleRateHz / (cautious ? 25U : 10U)) {
                monitoringSafetyTripFrame_.store(sessionFrame().value(),
                                                 std::memory_order_relaxed);
                monitoringSafetyInputPeak_.store(peak, std::memory_order_relaxed);
                monitoring_.store(false, std::memory_order_relaxed);
                monitoringSafetyTripped_.store(true, std::memory_order_relaxed);
                micMonitoringAgeCount_.store(0, std::memory_order_relaxed);
                monitoring = false;
                monitorHighFrames_ = 0;
            } else {
                // Limit each monitor sample independently. A block-wide gain reacts to one
                // isolated peak by ducking all neighbouring voice samples and creates crackle.
                const auto fadeStep = 5.0F / plan_.internalSampleRateHz;
                const auto limit = cautious ? 0.9F : 0.95F;
                for (std::uint32_t frame = 0; frame < buffer.frames; ++frame) {
                    monitorStartupGain_ = std::min(1.0F, monitorStartupGain_ + fadeStep);
                    // A centred local voice belongs to the front pair, not rear speakers or LFE.
                    // Keep the captured/analysis PCM unchanged; route only this monitor tap.
                    for (std::uint32_t channel = 0; channel < std::min(buffer.channels, 2U);
                         ++channel) {
                        const auto index = static_cast<std::size_t>(frame) * buffer.channels + channel;
                        const auto value = mic[index] * gains.microphone * monitorStartupGain_;
                        const auto magnitude = std::abs(value);
                        const auto limited = magnitude <= limit * 0.5F ? magnitude
                            : magnitude >= limit * 1.5F ? limit
                            : magnitude - (magnitude - limit * 0.5F) *
                                              (magnitude - limit * 0.5F) / (2.0F * limit);
                        output[index] += std::copysign(limited, value);
                    }
                }
            }
        } else {
            monitorHighFrames_ = 0;
            monitorStartupGain_ = 0.0F;
        }
    }
    const auto bridge = clockBridge_.snapshot();
    const auto sungAt = voiceSungAt(micCaptured);
    const auto presentationTicks =
        buffer.presentationTicks != 0
            ? buffer.presentationTicks
            : renderAt + static_cast<MonotonicTicks>(
                             latency_.get(LatencyRegistry::Stage::OutputDriver).currentFillFrames) *
                             NanosecondsPerSecond / plan_.internalSampleRateHz;
    // The timestamp difference already includes capture delivery, processing elapsed time and
    // queue residence. Do NOT add ClockBridge, callback duration or render padding to it again.
    const auto observedAge = !diagnosticInputEnabled_.load(std::memory_order_relaxed) &&
                                     micFrames == buffer.frames && buffer.frames != 0 &&
                                     captureTimelineUsable_.load(std::memory_order_relaxed) &&
                                     capturedEndTicks_.load(std::memory_order_relaxed) != 0
        ? LatencyRegistry::observedMonitoringTicks(micCaptured, buffer.presentationTicks,
                                                   dspLatencyFrames(), plan_.internalSampleRateHz)
        : -1;
    observedMonitoringLatencyNs_.store(observedAge, std::memory_order_relaxed);
    if (micFrames == buffer.frames && buffer.frames != 0)
        observedLatencySettled_.store(true, std::memory_order_relaxed);
    if (monitoring && microphoneEnabled && !diagnosticInputEnabled_.load(std::memory_order_relaxed) &&
        micFrames != 0 && micCaptured > 0 && presentationTicks > micCaptured) {
        const auto dspNs = static_cast<MonotonicTicks>(dspLatencyFrames()) *
                           NanosecondsPerSecond / plan_.internalSampleRateHz;
        const auto ageUs = static_cast<std::uint32_t>(std::min<MonotonicTicks>(
            (presentationTicks - micCaptured + dspNs) / 1'000, UINT32_MAX));
        const auto index = micMonitoringAgeCount_.load(std::memory_order_relaxed);
        micMonitoringAgeUs_[index % micMonitoringAgeUs_.size()].store(ageUs,
                                                                      std::memory_order_relaxed);
        micMonitoringAgeCount_.store(index + 1, std::memory_order_release);
    }
    const auto voiceLateFrames = smoothVoiceLateFrames(presentationTicks, sungAt);
    // Room transport never delays the performer's backing track or local monitoring. The network
    // engine applies its deadline only to the returned mix of the other singers.
    const auto musicSnapshot = media_.snapshot(MediaSlot::Music);
    const auto musicState = musicSnapshot.state;
    if (media_.context() != MediaContext::Karaoke ||
        (musicState != PlaybackState::Playing && musicState != PlaybackState::Paused))
        songUnderway_ = false;
    network_.setFollowLocked(songUnderway_);
    // The song comes to the loudness every other app plays at; from there the music knob alone
    // sets its level. Nothing follows the voices: a level the singer chose is never undone.
    const auto songLoudness = streamingLoudnessGain(musicSnapshot.loudnessRms);
    roomFollowFrames_.store(0, std::memory_order_relaxed);
    roomFollowTicks_.store(0, std::memory_order_relaxed);
    const auto songPresentationTicks = presentationTicks;
    auto performance = buffers_.buffer(3, buffer.frames);
    mixer_.clear(performance);
    // The master knob is the playback level: it scales what is played (song, guides, previews,
    // radio), never a voice.
    const auto accompaniment = songLoudness * gains.master;
    // Any media PCM in this block is ordinary playback; the optional acoustic test yields to it.
    std::uint32_t mediaFrames = 0;
    switch (media_.context()) {
    case MediaContext::Karaoke: {
        // Start-time scheduling aligns participants; PCM is rendered exactly once without
        // time-stretching, queue correction, or pitch-changing resampling of the backing track.
        auto music = buffers_.buffer(2, buffer.frames);
        mixer_.clear(music);
        if (const auto frames =
                media_.render(MediaSlot::Music, music, buffer.frames, songPresentationTicks);
            frames != 0) {
            songUnderway_ = true;
            mediaFrames += static_cast<std::uint32_t>(frames);
        }
        backingSpectrum_.observe(music, buffer.channels, gains.music * gains.master);
        mixer_.add(output, music, gains.music * accompaniment);
        mixer_.add(performance, music, gains.music * accompaniment);

        // Reference vocal and melody are guides for the same song timeline. In a room they must
        // pass through the exact same shared delay as the backing track; otherwise singers using
        // a guide hear it on a different timeline and an acoustic loop test measures that
        // deliberate mismatch in addition to the actual transport latency.
        auto guide = buffers_.buffer(4, buffer.frames);
        mixer_.clear(guide);
        // The guides belong to the accompaniment and step back under the voices with it.
        mediaFrames += addMedia(MediaSlot::ReferenceVocal, guide, buffer.frames,
                                gains.reference * accompaniment, songPresentationTicks);
        mediaFrames += addMedia(MediaSlot::Melody, guide, buffer.frames,
                                gains.melody * accompaniment, songPresentationTicks);
        mixer_.add(output, guide, 1.0F);
        break;
    }
    case MediaContext::EditorPreview:
        mediaFrames +=
            addMedia(MediaSlot::Preview, performance, buffer.frames, gains.preview * gains.master);
        break;
    case MediaContext::Radio:
        mediaFrames +=
            addMedia(MediaSlot::Radio, performance, buffer.frames, gains.radio * gains.master);
        break;
    case MediaContext::RecordingPreview:
        mediaFrames += addMedia(MediaSlot::RecordingPreview, performance, buffer.frames,
                                gains.preview * gains.master);
        break;
    case MediaContext::None:
        break;
    }
    // The saved performance is built on the song timeline: each voice is placed on the music it
    // was sung to rather than where it was heard (see PerformanceAligner).
    if (media_.context() != MediaContext::Karaoke) {
        backingSpectrum_.observe(performance, buffer.channels);
        // Add backing to the headphones, never copy a monitor-limited voice into the recording.
        mixer_.add(output, performance, 1.0F);
    }
    std::span<const float> recordedBacking;
    if (recording_.backingEnabled()) {
        // RawInput and analysis already copied buffer 5 above. Preserve the exact gained backing
        // here before the performance aligner reuses buffer 3 for an aligned recording mix.
        std::copy(performance.begin(), performance.end(), rawMic.begin());
        recordedBacking = rawMic;
    }
    if (performanceActive)
        aligner_.add(performance, buffer.frames, 1.0F, 0);
    // The user recording always gets the processed voice exactly once, with the same timeline
    // correction, whether local monitoring (and its safety limiter) is enabled or not.
    if (performanceActive && microphoneEnabled) {
        recording_.observeVoicePeak(pcmPeak(mic) * gains.microphone);
        aligner_.add(mic, buffer.frames, gains.microphone, voiceLateFrames);
    }
    auto remote = buffers_.buffer(2, buffer.frames);
    std::fill(remote.begin(), remote.end(), 0.0F);
    (void)network_.renderRemote(generation, remote, buffer.frames,
                                network_.roomTimelineFrame(buffer.presentationTicks != 0
                                                               ? buffer.presentationTicks
                                                               : monotonicTicksNow(),
                                                           sessionFrame().value()));
    const auto remotePeak = pcmPeak(remote);
    if (remotePeak > 0.0F) {
        remoteMixNonzeroBlocks_.fetch_add(1, std::memory_order_relaxed);
        retainPeak(remoteMixPeak_, remotePeak);
    }
    mixer_.add(output, remote, gains.remote);
    // Headphones keep the practical local/remote split, but the file places the returned server
    // mix back on the musical position carried by its packets.
    if (performanceActive) {
        aligner_.add(remote, buffer.frames, gains.remote, network_.remoteRecordingDelayFrames());
        aligner_.read(performance, buffer.frames);
    }
    // The tones belong to the accompaniment: when the song steps back under quiet voices, so do
    // they.
    renderTone(output, buffer.frames, accompaniment);
    if (performanceActive) {
        recording_.push(generation, RecordingTap::PerformanceMix, sessionFrame(), performance,
                        buffer.frames);
        performanceFrame_.store(sessionFrame() + buffer.frames);
    }
    mixer_.clampToFullScale(output);
    const auto masterPeak = pcmPeak(output);
    if (masterPeak > 0.0F) {
        masterOutputNonzeroBlocks_.fetch_add(1, std::memory_order_relaxed);
        retainPeak(masterOutputPeak_, masterPeak);
    }
    // Measure -> Play: an unfinished measurement is abandoned in the very block the media starts,
    // so no chirp is ever mixed into a song, preview or radio stream (or its recording).
    if (mediaFrames != 0)
        latencyMeter_.cancel();
    // After the playback level: a calibration must stay audible even when the song is turned down.
    latencyMeter_.render(output, buffer.frames, buffer.channels, buffer.presentationTicks,
                         renderAt);
    // No passive speaker/microphone correlation in normal playback. The explicit acoustic
    // diagnostic above is idle unless the user deliberately starts it.
    spectrum_.observe(output, buffer.channels);
    recording_.push(generation, RecordingTap::MasterMix, sessionFrame(), output, buffer.frames,
                    {scaleFramePosition(network_.roomTimelineFrame(buffer.presentationTicks, 0),
                                         plan_.internalSampleRateHz, VoiceProtocolSampleRateHz),
                     0, 0, network_.hasRoomClock() && buffer.presentationTicks > 0}, recordedBacking);
    // Last of all, and after the recording: what leaves the speakers follows the Windows volume
    // like every other app, while saved performances keep their own level.
    if (const auto system = systemGain_.load(std::memory_order_relaxed); system != 1.0F)
        for (auto& sample : output)
            sample *= system;
    sessionFrameValue_.fetch_add(buffer.frames, std::memory_order_relaxed);
    latency_.set(
        LatencyRegistry::Stage::ClockBridge,
        LatencyRegistry::convertFrames(bridge.capacityFrames, plan_.inputSampleRateHz,
                                       plan_.internalSampleRateHz),
        0,
        LatencyRegistry::convertFrames(
            smoothBridgeLatencyFrames(meanBridgeFillFrames(bridgeFillBeforePullFrames, renderAt)),
            plan_.inputSampleRateHz, plan_.internalSampleRateHz));
    lastRenderAt_ = renderAt;
    bridgeFillAfterRenderFrames_ = bridge.fillFrames;
    latency_.set(LatencyRegistry::Stage::Dsp, 0, dspLatencyFrames(), 0);
}
void RealtimeEngine::onBackendEvent(GenerationId generation, BackendEventType event,
                                    std::int32_t code) noexcept {
    if (generation != generation_.load(std::memory_order_acquire)) {
        staleCallbacks_.fetch_add(1, std::memory_order_relaxed);
        return;
    }
    if (event == BackendEventType::DataDiscontinuity || event == BackendEventType::TimestampError) {
        observedMonitoringLatencyNs_.store(-1, std::memory_order_relaxed);
        captureTimelineUsable_.store(false, std::memory_order_relaxed);
        latencyMeter_.invalidateTiming();
    }
    trace_.push({monotonicTicksNow(), sessionFrame(), generation, TraceBackendEvent,
                 static_cast<std::uint32_t>(event)});
    backendEventGeneration_.store(generation, std::memory_order_relaxed);
    backendEventCode_.store(code, std::memory_order_relaxed);
    backendEventType_.store(static_cast<std::uint32_t>(event), std::memory_order_release);
    backendEventSequence_.fetch_add(1, std::memory_order_release);
}
PendingBackendEvent RealtimeEngine::pendingBackendEvent() const noexcept {
    const auto sequence = backendEventSequence_.load(std::memory_order_acquire);
    if (sequence == acknowledgedBackendEventSequence_.load(std::memory_order_acquire))
        return {};
    return {backendEventGeneration_.load(std::memory_order_relaxed),
            static_cast<BackendEventType>(backendEventType_.load(std::memory_order_acquire)),
            backendEventCode_.load(std::memory_order_relaxed), sequence};
}
void RealtimeEngine::acknowledgeBackendEvent(std::uint64_t sequence) noexcept {
    acknowledgedBackendEventSequence_.store(sequence, std::memory_order_release);
}
void RealtimeEngine::onRenderSubmitted(MonotonicTicks submittedAt) noexcept {
    if (!micGapAwaitingSubmission_)
        return;
    micGapSerial_.fetch_add(1, std::memory_order_acq_rel);
    micGapRenderSubmittedNs_.store(submittedAt, std::memory_order_relaxed);
    micGapSerial_.fetch_add(1, std::memory_order_release);
    micGapAwaitingSubmission_ = false;
}
MicGapTimeline RealtimeEngine::micGapTimeline() const noexcept {
    for (unsigned attempt = 0; attempt < 8; ++attempt) {
        const auto before = micGapSerial_.load(std::memory_order_acquire);
        if ((before & 1U) != 0)
            continue;
        const MicGapTimeline out{
            micGapCount_.load(std::memory_order_relaxed),
            micGapMissingFrames_.load(std::memory_order_relaxed),
            micGapBridgeAvailableFrames_.load(std::memory_order_relaxed),
            micGapRequestedFrames_.load(std::memory_order_relaxed),
            micGapCaptureDevicePosition_.load(std::memory_order_relaxed),
            micGapRawQpc100ns_.load(std::memory_order_relaxed),
            micGapLastEmptyProbeNs_.load(std::memory_order_relaxed),
            micGapCaptureEventObservedNs_.load(std::memory_order_relaxed),
            micGapWakeObservedNs_.load(std::memory_order_relaxed),
            micGapGetBufferStartedNs_.load(std::memory_order_relaxed),
            micGapPacketDeliveredNs_.load(std::memory_order_relaxed),
            micGapEngineStartedNs_.load(std::memory_order_relaxed),
            micGapBridgeInsertedNs_.load(std::memory_order_relaxed),
            micGapRenderWakeNs_.load(std::memory_order_relaxed),
            micGapRenderConsumedNs_.load(std::memory_order_relaxed),
            micGapRenderSubmittedNs_.load(std::memory_order_relaxed),
            micGapPresentationNs_.load(std::memory_order_relaxed),
            micGapStampCorrectionNs_.load(std::memory_order_relaxed),
            micGapCaptureEventGapUs_.load(std::memory_order_relaxed),
            micGapPacketGapUs_.load(std::memory_order_relaxed),
            micGapPacketsThisWake_.load(std::memory_order_relaxed),
            micGapFramesThisWake_.load(std::memory_order_relaxed),
            micGapPacketFrames_.load(std::memory_order_relaxed),
            micGapRenderWakePackets_.load(std::memory_order_relaxed),
            micGapRenderWakeFrames_.load(std::memory_order_relaxed),
            micGapBridgeFillBeforeInsertFrames_.load(std::memory_order_relaxed),
            micGapBridgeFillAfterInsertFrames_.load(std::memory_order_relaxed)};
        if (before == micGapSerial_.load(std::memory_order_acquire))
            return out.sequence == 0 ? MicGapTimeline{} : out;
    }
    return {};
}
RealtimeSnapshot RealtimeEngine::snapshot() const noexcept {
    std::array<float, MaxAudioChannels> inputRms{};
    for (std::size_t channel = 0; channel < inputRms.size(); ++channel)
        inputRms[channel] = inputChannelRms_[channel].load(std::memory_order_relaxed);
    const auto next = monitoring_.load(std::memory_order_relaxed)
                          ? micMonitoringAgeCount_.load(std::memory_order_acquire)
                          : 0;
    const auto count = static_cast<std::size_t>(std::min<std::uint64_t>(next, micMonitoringAgeUs_.size()));
    std::array<std::uint32_t, 512> sorted{};
    for (std::size_t index = 0; index < count; ++index)
        sorted[index] = micMonitoringAgeUs_[(next - count + index) % micMonitoringAgeUs_.size()]
                            .load(std::memory_order_relaxed);
    std::sort(sorted.begin(), sorted.begin() + count);
    const auto percentile = [&sorted, count](std::uint32_t rank) {
        return count == 0 ? 0U : sorted[(count * rank + 99) / 100 - 1];
    };
    return {sessionFrame(),
            clocks_.driftPpm(),
            clocks_.correctionRatio(),
            clockBridge_.diagnosticSnapshot(),
            staleCallbacks_.load(std::memory_order_relaxed),
            captureOverruns_.load(std::memory_order_relaxed),
            renderUnderruns_.load(std::memory_order_relaxed),
            micCaptureSkippedFrames_.load(std::memory_order_relaxed),
            micCaptureRepeatedFrames_.load(std::memory_order_relaxed),
            micInsertedSilenceFrames_.load(std::memory_order_relaxed),
            percentile(50), percentile(95), percentile(99),
            count == 0 ? 0U : sorted[0], count == 0 ? 0U : sorted[count - 1],
            presentationJumps_.load(std::memory_order_relaxed),
            presentationJumpMaxNs_.load(std::memory_order_relaxed),
            remoteMixNonzeroBlocks_.load(std::memory_order_relaxed),
            remoteMixPeak_.load(std::memory_order_relaxed),
            masterOutputNonzeroBlocks_.load(std::memory_order_relaxed),
            masterOutputPeak_.load(std::memory_order_relaxed),
            selectedInputChannel_.load(std::memory_order_relaxed), inputRms};
}
