#include "realtime/RealtimeEngine.hpp"

#include <algorithm>
#include <cmath>

namespace {
constexpr std::uint32_t TraceCaptureOverrun = 20;
constexpr std::uint32_t TraceRenderUnderrun = 21;
constexpr std::uint32_t TraceBackendEvent = 22;
constexpr double Pi = 3.14159265358979323846;
} // namespace
RealtimeEngine::RealtimeEngine(MediaController& media, RecordingEngine& recording,
                               AnalysisEngine& analysis, NetworkAudioEngine& network,
                               SignalMetrics& signal, LatencyRegistry& latency,
                               GraphIntrospection& graphInfo, TraceBuffer& trace)
    : media_(media), recording_(recording), analysis_(analysis), network_(network), signal_(signal),
      latency_(latency), graphInfo_(graphInfo), trace_(trace) {}
namespace {
constexpr float MicrophoneEnergySmoothing = 0.2F;
constexpr float SilentWeightSum = 1.0e-6F;
} // namespace

void RealtimeEngine::prepare(const FinalSessionPlan& plan, GenerationId generation) {
    plan_ = plan;
    generation_.store(generation, std::memory_order_release);
    sessionFrameValue_.store(0, std::memory_order_relaxed);
    buffers_.prepare(3, plan.maximumBlockFrames, plan.outputChannels);
    clockBridge_.prepare(plan.clockBridgeCapacityFrames, plan.clockBridgeTargetFrames,
                         plan.outputChannels);
    clocks_.prepare(plan.inputSampleRateHz, plan.internalSampleRateHz);
    dsp_.prepare(plan.internalSampleRateHz, plan.maximumBlockFrames, plan.outputChannels);
    media_.prepare(plan.internalSampleRateHz, plan.outputChannels, plan.internalSampleRateHz / 2U);
    network_.prepare(plan.internalSampleRateHz, plan.outputChannels, plan.internalSampleRateHz / 2U,
                     std::max(1U, plan.internalSampleRateHz / 200U), generation);
    analysis_.prepare(plan.outputChannels, plan.internalSampleRateHz / 2U, generation);
    recording_.setGeneration(generation);
    spectrum_.prepare(plan.internalSampleRateHz);
    updateGraphSnapshot();
    latency_.set(LatencyRegistry::Stage::ClockBridge, plan.clockBridgeCapacityFrames, 0,
                 plan.clockBridgeTargetFrames);
}
void RealtimeEngine::invalidate(GenerationId generation) noexcept {
    generation_.store(generation, std::memory_order_release);
    recording_.setGeneration(generation);
    analysis_.setGeneration(generation);
    network_.setGeneration(generation);
}
void RealtimeEngine::reset() noexcept {
    clockBridge_.reset();
    clocks_.reset();
    dsp_.reset();
    sessionFrameValue_.store(0, std::memory_order_relaxed);
    toneFramesRemaining_.store(0, std::memory_order_relaxed);
}
void RealtimeEngine::setDspEnabled(bool enabled) noexcept {
    dspEnabled_.store(enabled, std::memory_order_relaxed);
    dsp_.setEnabled(enabled);
    latency_.set(LatencyRegistry::Stage::Dsp, 0, enabled ? dsp_.latencyFrames() : 0, 0);
    updateGraphSnapshot();
}
bool RealtimeEngine::setDspParameter(std::string_view name, float value) noexcept {
    if (!dsp_.setParameter(name, value))
        return false;
    latency_.set(LatencyRegistry::Stage::Dsp, 0,
                 dspEnabled_.load(std::memory_order_relaxed) ? dsp_.latencyFrames() : 0, 0);
    updateGraphSnapshot();
    return true;
}
void RealtimeEngine::updateGraphSnapshot() {
    GraphSnapshot snapshot;
    snapshot.poolBytes = buffers_.bytes();
    snapshot.stages.push_back({"Capture", 0, 0});
    snapshot.stages.push_back({"InputBoundaryConversion", 0, 0});
    snapshot.stages.push_back({"RawInput", 0, 0});
    if (plan_.independentClocks || plan_.needsInputResampling)
        snapshot.stages.push_back({"ClockBridge", plan_.clockBridgeTargetFrames, 0});
    snapshot.stages.push_back({"MicrophoneGate", 0, 0});
    snapshot.stages.push_back({"InputGain", 0, 0});
    if (dspEnabled_.load(std::memory_order_relaxed))
        snapshot.stages.push_back({"DSP", 0, dsp_.latencyFrames()});
    snapshot.stages.push_back({"Mixer", 0, 0});
    snapshot.stages.push_back({"OutputBoundaryConversion", 0, 0});
    snapshot.stages.push_back({"Render", 0, 0});
    graphInfo_.set(std::move(snapshot));
}
void RealtimeEngine::playReferenceTone(float frequencyHz, std::uint32_t durationFrames,
                                       float gain) noexcept {
    toneFrequencyHz_.store(std::clamp(frequencyHz, 20.0F, 12000.0F), std::memory_order_relaxed);
    toneGain_.store(std::clamp(gain, 0.0F, 0.25F), std::memory_order_relaxed);
    toneFramesRemaining_.store(durationFrames, std::memory_order_release);
    tonePhase_ = 0.0;
}
// A microphone is one voice: every input channel is folded into a single signal that feeds all outputs. Channels are
// weighted by their recent loudness, so a mic wired to only one side of a stereo input stays at full level and
// is heard in both speakers instead of one.
void RealtimeEngine::mapMicrophone(std::span<const float> input, std::uint32_t inputChannels,
                                   std::span<float> output, std::uint32_t outputChannels,
                                   std::uint32_t frames) noexcept {
    if (inputChannels == 0 || outputChannels == 0)
        return;
    std::array<float, MaxAudioChannels> weights{};
    float weightSum = 0.0F;
    for (std::uint32_t channel = 0; channel < inputChannels; ++channel) {
        float squares = 0.0F;
        for (std::uint32_t frame = 0; frame < frames; ++frame) {
            const auto sample = input[static_cast<std::size_t>(frame) * inputChannels + channel];
            squares += sample * sample;
        }
        auto& energy = channelEnergy_[channel];
        energy += (squares / static_cast<float>(frames) - energy) * MicrophoneEnergySmoothing;
        weights[channel] = std::sqrt(std::max(energy, 0.0F));
        weightSum += weights[channel];
    }
    for (std::uint32_t channel = 0; channel < inputChannels; ++channel)
        weights[channel] = weightSum > SilentWeightSum ? weights[channel] / weightSum
                                                       : 1.0F / static_cast<float>(inputChannels);
    for (std::uint32_t frame = 0; frame < frames; ++frame) {
        float value = 0.0F;
        for (std::uint32_t channel = 0; channel < inputChannels; ++channel)
            value += weights[channel] * input[static_cast<std::size_t>(frame) * inputChannels + channel];
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
    const auto inputSamples = static_cast<std::size_t>(buffer.frames) * buffer.channels;
    signal_.observe(std::span<const float>{buffer.input, inputSamples});
    auto mapped = buffers_.buffer(0, buffer.frames);
    mapMicrophone(std::span<const float>{buffer.input, inputSamples}, buffer.channels, mapped,
                  plan_.outputChannels, buffer.frames);
    recording_.push(generation, RecordingTap::RawInput,
                    SessionFrame{sessionFrameValue_.load(std::memory_order_relaxed)}, mapped,
                    buffer.frames);
    network_.pushLocal(generation, mapped, buffer.frames);
    analysis_.push(generation, mapped, buffer.frames);
    if (!clockBridge_.push(mapped, buffer.frames)) {
        captureOverruns_.fetch_add(1, std::memory_order_relaxed);
        trace_.push(
            {monotonicTicksNow(), sessionFrame(), generation, TraceCaptureOverrun, buffer.frames});
    }
    lastCapturePosition_.store(buffer.devicePosition, std::memory_order_relaxed);
    lastCaptureTimestamp_.store(buffer.timestamp, std::memory_order_relaxed);
}
void RealtimeEngine::addMedia(MediaSlot slot, std::span<float> output, std::uint32_t frames,
                              float gain) noexcept {
    auto scratch = buffers_.buffer(2, frames);
    std::fill(scratch.begin(), scratch.end(), 0.0F);
    (void)media_.render(slot, scratch, frames);
    mixer_.add(output, scratch, gain);
}
void RealtimeEngine::renderTone(std::span<float> output, std::uint32_t frames) noexcept {
    auto remaining = toneFramesRemaining_.load(std::memory_order_acquire);
    if (remaining == 0)
        return;
    const auto frequency = toneFrequencyHz_.load(std::memory_order_relaxed);
    const auto gain = toneGain_.load(std::memory_order_relaxed);
    const auto count = std::min(frames, remaining);
    const auto step = 2.0 * Pi * static_cast<double>(frequency) / plan_.internalSampleRateHz;
    for (std::uint32_t frame = 0; frame < count; ++frame) {
        const auto sample = static_cast<float>(std::sin(tonePhase_)) * gain;
        tonePhase_ += step;
        if (tonePhase_ >= 2.0 * Pi)
            tonePhase_ -= 2.0 * Pi;
        for (std::uint32_t ch = 0; ch < plan_.outputChannels; ++ch)
            output[static_cast<std::size_t>(frame) * plan_.outputChannels + ch] += sample;
    }
    toneFramesRemaining_.fetch_sub(count, std::memory_order_acq_rel);
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
    const auto samples = static_cast<std::size_t>(buffer.frames) * buffer.channels;
    auto output = std::span<float>{buffer.output, samples};
    mixer_.clear(output);
    const auto capturePosition = lastCapturePosition_.load(std::memory_order_relaxed);
    clocks_.observe({capturePosition, buffer.devicePosition,
                     lastCaptureTimestamp_.load(std::memory_order_relaxed), buffer.timestamp,
                     true});
    auto mic = buffers_.buffer(1, buffer.frames);
    const auto nominalRatio = static_cast<double>(plan_.inputSampleRateHz) /
                              static_cast<double>(plan_.internalSampleRateHz);
    const auto micFrames =
        clockBridge_.pull(mic, buffer.frames, nominalRatio * clocks_.correctionRatio());
    if (micFrames < buffer.frames) {
        renderUnderruns_.fetch_add(1, std::memory_order_relaxed);
        trace_.push({monotonicTicksNow(), sessionFrame(), generation, TraceRenderUnderrun,
                     buffer.frames - micFrames});
    }
    if (microphoneEnabled_.load(std::memory_order_relaxed)) {
        dsp_.process(mic, buffer.frames);
        recording_.push(generation, RecordingTap::ProcessedVoice, sessionFrame(), mic,
                        buffer.frames);
        if (monitoring_.load(std::memory_order_relaxed))
            mixer_.add(output, mic, mixer_.gains().microphone);
    }
    const auto gains = mixer_.gains();
    switch (media_.context()) {
    case MediaContext::Karaoke:
        addMedia(MediaSlot::Music, output, buffer.frames, gains.music);
        addMedia(MediaSlot::ReferenceVocal, output, buffer.frames, gains.reference);
        break;
    case MediaContext::EditorPreview:
        addMedia(MediaSlot::Preview, output, buffer.frames, gains.preview);
        break;
    case MediaContext::Radio:
        addMedia(MediaSlot::Radio, output, buffer.frames, gains.radio);
        break;
    case MediaContext::RecordingPreview:
        addMedia(MediaSlot::RecordingPreview, output, buffer.frames, gains.preview);
        break;
    case MediaContext::None:
        break;
    }
    auto remote = buffers_.buffer(2, buffer.frames);
    std::fill(remote.begin(), remote.end(), 0.0F);
    (void)network_.renderRemote(generation, remote, buffer.frames);
    mixer_.add(output, remote, gains.remote);
    renderTone(output, buffer.frames);
    mixer_.applyMaster(output);
    spectrum_.observe(output, buffer.channels);
    recording_.push(generation, RecordingTap::MasterMix, sessionFrame(), output, buffer.frames);
    sessionFrameValue_.fetch_add(buffer.frames, std::memory_order_relaxed);
    const auto bridge = clockBridge_.snapshot();
    latency_.set(LatencyRegistry::Stage::ClockBridge, bridge.capacityFrames, 0, bridge.fillFrames);
    latency_.set(LatencyRegistry::Stage::Dsp, 0,
                 dspEnabled_.load(std::memory_order_relaxed) ? dsp_.latencyFrames() : 0, 0);
}
void RealtimeEngine::onBackendEvent(GenerationId generation, BackendEventType event,
                                    std::int32_t code) noexcept {
    if (generation != generation_.load(std::memory_order_acquire)) {
        staleCallbacks_.fetch_add(1, std::memory_order_relaxed);
        return;
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
RealtimeSnapshot RealtimeEngine::snapshot() const noexcept {
    return {sessionFrame(),
            clocks_.driftPpm(),
            clocks_.correctionRatio(),
            clockBridge_.snapshot(),
            staleCallbacks_.load(std::memory_order_relaxed),
            captureOverruns_.load(std::memory_order_relaxed),
            renderUnderruns_.load(std::memory_order_relaxed)};
}
