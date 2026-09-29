#include "realtime/RealtimeEngine.hpp"

#include <algorithm>
#include <cmath>

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
} // namespace

void RealtimeEngine::prepare(const FinalSessionPlan& plan, GenerationId generation) {
    plan_ = plan;
    generation_.store(generation, std::memory_order_release);
    sessionFrameValue_.store(0, std::memory_order_relaxed);
    buffers_.prepare(5, plan.maximumBlockFrames, plan.outputChannels);
    clockBridge_.prepare(plan.clockBridgeCapacityFrames, plan.clockBridgeTargetFrames,
                         plan.outputChannels, plan.inputSampleRateHz);
    clocks_.prepare(plan.inputSampleRateHz, plan.internalSampleRateHz);
    dsp_.prepare(plan.internalSampleRateHz, plan.maximumBlockFrames, plan.outputChannels);
    media_.prepare(plan.internalSampleRateHz, plan.outputChannels, plan.internalSampleRateHz / 2U);
    network_.prepare(plan.internalSampleRateHz, plan.outputChannels, plan.internalSampleRateHz / 2U,
                     std::max(1U, plan.internalSampleRateHz / VoicePacketsPerSecond), generation);
    analysis_.prepare(plan.outputChannels, plan.internalSampleRateHz,
                      plan.internalSampleRateHz / 2U, generation);
    recording_.setGeneration(generation);
    spectrum_.prepare(plan.internalSampleRateHz);
    backingSpectrum_.prepare(plan.internalSampleRateHz);
    ownVoice_.prepare(plan.internalSampleRateHz);
    aligner_.prepare(plan.outputChannels, plan.internalSampleRateHz / PerformanceLeadDivisor,
                     plan.maximumBlockFrames);
    latencyMeter_.prepare(plan.internalSampleRateHz, plan.inputSampleRateHz);
    updateGraphSnapshot();
    latency_.set(LatencyRegistry::Stage::ClockBridge,
                 LatencyRegistry::convertFrames(plan.clockBridgeCapacityFrames,
                                                plan.inputSampleRateHz, plan.internalSampleRateHz),
                 0, 0);
}
void RealtimeEngine::invalidate(GenerationId generation) noexcept {
    generation_.store(generation, std::memory_order_release);
    recording_.setGeneration(generation);
    analysis_.setGeneration(generation);
    network_.setGeneration(generation);
}
void RealtimeEngine::reset() noexcept {
    clockBridge_.reset();
    // Render may start before capture. Never seed new device clocks from the old session.
    lastCapturePosition_.store(-1, std::memory_order_relaxed);
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
    if (plan_.inputChannels != 0) {
        snapshot.stages.push_back({"Capture", 0, 0});
        snapshot.stages.push_back({"InputBoundaryConversion", 0, 0});
        snapshot.stages.push_back({"RawInput", 0, 0});
        if (plan_.independentClocks || plan_.needsInputResampling)
            snapshot.stages.push_back({"ClockBridge", plan_.clockBridgeTargetFrames, 0});
        snapshot.stages.push_back({"MicrophoneGate", 0, 0});
        snapshot.stages.push_back({"InputGain", 0, 0});
        if (dspEnabled_.load(std::memory_order_relaxed))
            snapshot.stages.push_back({"DSP", 0, dsp_.latencyFrames()});
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
        if (energy > strongestEnergy) {
            strongestEnergy = energy;
            selectedChannel = channel;
        }
    }
    for (std::uint32_t frame = 0; frame < frames; ++frame) {
        const auto value =
            input[static_cast<std::size_t>(frame) * inputChannels + selectedChannel];
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
    const auto deliveredAt = monotonicTicksNow();
    const auto duration = static_cast<MonotonicTicks>(buffer.frames) * NanosecondsPerSecond /
                          plan_.inputSampleRateHz;
    // A packet's first frame was recorded at least its own length before it was delivered. Some
    // drivers stamp the packet's end instead of its start (WASAPI documents the start); taken at
    // face value that made every voice one capture period late and inflated the measured hidden
    // latency by the same period. The stamp is held to the latest physically possible moment.
    const auto captureStart =
        buffer.captureTicks == 0 ? 0 : std::min(buffer.captureTicks, deliveredAt - duration);
    captureStampCorrectionNs_.store(buffer.captureTicks - captureStart, std::memory_order_relaxed);
    const auto inputSamples = static_cast<std::size_t>(buffer.frames) * buffer.channels;
    signal_.observe(std::span<const float>{buffer.input, inputSamples});
    auto mapped = buffers_.buffer(0, buffer.frames);
    mapMicrophone(std::span<const float>{buffer.input, inputSamples}, buffer.channels, mapped,
                  plan_.outputChannels, buffer.frames);
    if (!clockBridge_.push(mapped, buffer.frames)) {
        captureOverruns_.fetch_add(1, std::memory_order_relaxed);
        trace_.push(
            {monotonicTicksNow(), sessionFrame(), generation, TraceCaptureOverrun, buffer.frames});
    } else {
        const auto pushedAt = monotonicTicksNow();
        capturePushedAt_.store(pushedAt, std::memory_order_relaxed);
        const auto capturedEnd = captureStart == 0 ? 0 : captureStart + duration;
        capturedEndTicks_.store(capturedEnd, std::memory_order_relaxed);
        captureAgeNs_.store(capturedEnd == 0 ? 0 : pushedAt - capturedEnd, std::memory_order_relaxed);
    }
    latencyMeter_.capture(std::span<const float>{buffer.input, inputSamples}, buffer.frames,
                          buffer.channels, captureStart);
    lastCapturePosition_.store(buffer.devicePosition, std::memory_order_relaxed);
    lastCaptureTimestamp_.store(buffer.timestamp, std::memory_order_relaxed);
}
void RealtimeEngine::addMedia(MediaSlot slot, std::span<float> output, std::uint32_t frames,
                              float gain, MonotonicTicks presentationTicks) noexcept {
    auto scratch = buffers_.buffer(2, frames);
    std::fill(scratch.begin(), scratch.end(), 0.0F);
    (void)media_.render(slot, scratch, frames, presentationTicks);
    mixer_.add(output, scratch, gain);
}
void RealtimeEngine::renderTone(std::span<float> output, std::uint32_t frames) noexcept {
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
            tonePhase_ = 0.0;
            renderedToneSequence_ = sequence;
        }
    }
    if (toneFramesRemaining_ == 0)
        return;
    const auto count = std::min(frames, toneFramesRemaining_);
    const auto step = 2.0 * Pi * static_cast<double>(renderedToneFrequencyHz_) /
                      plan_.internalSampleRateHz;
    for (std::uint32_t frame = 0; frame < count; ++frame) {
        const auto sample = static_cast<float>(std::sin(tonePhase_)) * renderedToneGain_;
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
                                                     NanosecondsPerSecond / plan_.internalSampleRateHz;
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
    const auto area = static_cast<double>(bridgeFillAfterRenderFrames_) *
                          static_cast<double>(pushedAt - lastRenderAt_) +
                      static_cast<double>(fillBeforePullFrames) *
                          static_cast<double>(renderAt - pushedAt);
    return area / static_cast<double>(intervalNs);
}
std::uint32_t RealtimeEngine::smoothBridgeLatencyFrames(double meanFillFrames) noexcept {
    bridgeLatencyFrames_ = bridgeLatencyFrames_ < 0.0
                               ? meanFillFrames
                               : bridgeLatencyFrames_ +
                                     (meanFillFrames - bridgeLatencyFrames_) * BridgeLatencySmoothing;
    return static_cast<std::uint32_t>(std::lround(bridgeLatencyFrames_));
}
// Song-timeline moment of the microphone samples pulled now: their device capture time (the
// newest bridged sample minus everything still waiting before it), minus the acoustic latency the
// devices do not report and the DSP delay. Without device capture times the configured capture
// latency and the bridge fill are used instead.
MonotonicTicks RealtimeEngine::voiceSungAt(std::uint32_t bridgeFillBeforePullFrames) const noexcept {
    const auto capturedEnd = capturedEndTicks_.load(std::memory_order_relaxed);
    const auto dspNs = static_cast<MonotonicTicks>(
        dspEnabled_.load(std::memory_order_relaxed) ? dsp_.latencyFrames() : 0U) *
        NanosecondsPerSecond / plan_.internalSampleRateHz;
    MonotonicTicks capturedAt = 0;
    if (capturedEnd != 0) {
        capturedAt = capturedEnd - static_cast<MonotonicTicks>(bridgeFillBeforePullFrames) *
                                       NanosecondsPerSecond / plan_.inputSampleRateHz;
    } else {
        const auto capture = latency_.get(LatencyRegistry::Stage::Capture);
        const auto frames = static_cast<std::uint64_t>(capture.algorithmicFrames) +
            capture.currentFillFrames + LatencyRegistry::convertFrames(
                bridgeFillBeforePullFrames, plan_.inputSampleRateHz, plan_.internalSampleRateHz);
        capturedAt = monotonicTicksNow() -
            static_cast<MonotonicTicks>(frames) * NanosecondsPerSecond / plan_.internalSampleRateHz;
    }
    return capturedAt - acousticLatencyNs_.load(std::memory_order_relaxed) - dspNs;
}
// How far the pulled voice trails the music rendered now, smoothed over capture/render phase.
std::uint32_t RealtimeEngine::smoothVoiceLateFrames(MonotonicTicks presentationTicks,
                                                    MonotonicTicks sungAt) noexcept {
    const auto lateFrames =
        static_cast<double>(std::max<MonotonicTicks>(0, presentationTicks - sungAt)) *
        plan_.internalSampleRateHz / static_cast<double>(NanosecondsPerSecond);
    voiceLateFrames_ = voiceLateFrames_ < 0.0
                           ? lateFrames
                           : voiceLateFrames_ + (lateFrames - voiceLateFrames_) * VoiceLateSmoothing;
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
    const auto renderAt = monotonicTicksNow();
    publishOutputLatency(buffer.presentationTicks, renderAt);
    notePresentationContinuity(buffer.presentationTicks, buffer.frames);
    const auto samples = static_cast<std::size_t>(buffer.frames) * buffer.channels;
    auto output = std::span<float>{buffer.output, samples};
    mixer_.clear(output);
    auto mic = buffers_.buffer(1, buffer.frames);
    const auto bridgeFillBeforePullFrames = clockBridge_.snapshot().fillFrames;
    if (plan_.inputChannels == 0) {
        std::fill(mic.begin(), mic.end(), 0.0F);
    } else {
        const auto capturePosition = lastCapturePosition_.load(std::memory_order_relaxed);
        clocks_.observe({capturePosition, buffer.devicePosition,
                         lastCaptureTimestamp_.load(std::memory_order_relaxed), buffer.timestamp,
                         true});
        const auto nominalRatio = static_cast<double>(plan_.inputSampleRateHz) /
                                  static_cast<double>(plan_.internalSampleRateHz);
        const auto micFrames =
            clockBridge_.pull(mic, buffer.frames, nominalRatio * clocks_.correctionRatio());
        if (micFrames < buffer.frames) {
            renderUnderruns_.fetch_add(1, std::memory_order_relaxed);
            trace_.push({monotonicTicksNow(), sessionFrame(), generation, TraceRenderUnderrun,
                         buffer.frames - micFrames});
        }
    }
    // Every downstream tap uses the negotiated internal clock after boundary conversion.
    recording_.push(generation, RecordingTap::RawInput, sessionFrame(), mic, buffer.frames);
    analysis_.push(generation, mic, buffer.frames);
    const auto gains = mixer_.gains();
    const auto microphoneEnabled = microphoneEnabled_.load(std::memory_order_relaxed);
    const auto monitoring = monitoring_.load(std::memory_order_relaxed);
    if (microphoneEnabled) {
        dsp_.process(mic, buffer.frames);
        ownVoice_.note(mic, plan_.outputChannels, buffer.frames);
        recording_.push(generation, RecordingTap::ProcessedVoice, sessionFrame(), mic,
                        buffer.frames);
        if (monitoring)
            mixer_.add(output, mic, gains.microphone);
    }
    const auto bridge = clockBridge_.snapshot();
    const auto sungAt = voiceSungAt(bridgeFillBeforePullFrames);
    const auto presentationTicks = buffer.presentationTicks != 0
        ? buffer.presentationTicks
        : renderAt + static_cast<MonotonicTicks>(
              latency_.get(LatencyRegistry::Stage::OutputDriver).currentFillFrames) *
              NanosecondsPerSecond / plan_.internalSampleRateHz;
    const auto voiceLateFrames = smoothVoiceLateFrames(presentationTicks, sungAt);
    // Following the room leader delays the song by the playout delay of the leader's voice.
    const auto musicSnapshot = media_.snapshot(MediaSlot::Music);
    const auto musicState = musicSnapshot.state;
    if (media_.context() != MediaContext::Karaoke ||
        (musicState != PlaybackState::Playing && musicState != PlaybackState::Paused))
        songUnderway_ = false;
    network_.setFollowLocked(songUnderway_);
    {
        // The accompaniment sits under the quiet phrases of the quietest voice in this mix. A voice
        // first measured during a song still pushes it down at once; it never rises mid-song.
        const auto own = microphoneEnabled ? ownVoice_.quietRms() * gains.microphone : 0.0F;
        const auto remote = network_.quietestVoiceRms();
        const auto quietest = own > 0.0F && remote > 0.0F ? std::min(own, remote) : std::max(own, remote);
        const auto trim = musicAutoTrim(quietest, musicSnapshot.loudnessRms, gains.music);
        musicTrim_ = songUnderway_ ? std::min(musicTrim_, trim) : trim;
        musicTrimPublished_.store(musicTrim_, std::memory_order_relaxed);
    }
    const auto followTargetFrames = network_.followTargetDelayFrames();
    const auto followFrames = followRoomDelay(followTargetFrames);
    const auto remoteDelayFrames =
        followTargetFrames != 0 ? followTargetFrames : network_.sharedTargetDelayFrames();
    const auto followNs =
        static_cast<MonotonicTicks>(followFrames) * NanosecondsPerSecond / plan_.internalSampleRateHz;
    roomFollowFrames_.store(followFrames, std::memory_order_relaxed);
    roomFollowTicks_.store(followNs, std::memory_order_relaxed);
    const auto songPresentationTicks = presentationTicks - followNs;
    // The voice is stamped with the song moment it was sung to, which a follower hears later.
    if (plan_.inputChannels != 0)
        network_.pushLocal(generation, mic, buffer.frames,
                           network_.roomTimelineFrame(sungAt - followNs, sessionFrame().value()),
                           microphoneEnabled ? gains.microphone : 0.0F);
    auto performance = buffers_.buffer(3, buffer.frames);
    mixer_.clear(performance);
    switch (media_.context()) {
    case MediaContext::Karaoke: {
        // Start-time scheduling aligns participants; PCM is rendered exactly once without
        // time-stretching, queue correction, or pitch-changing resampling of the backing track.
        auto music = buffers_.buffer(2, buffer.frames);
        mixer_.clear(music);
        if (media_.render(MediaSlot::Music, music, buffer.frames, songPresentationTicks) != 0)
            songUnderway_ = true;
        backingSpectrum_.observe(music, buffer.channels, gains.music * gains.master);
        mixer_.add(output, music, gains.music * musicTrim_);
        mixer_.add(performance, music, gains.music * musicTrim_);

        // Reference vocal and melody are guides for the same song timeline. In a room they must
        // pass through the exact same shared delay as the backing track; otherwise singers using
        // a guide hear it on a different timeline and an acoustic loop test measures that deliberate
        // mismatch in addition to the actual transport latency.
        auto guide = buffers_.buffer(4, buffer.frames);
        mixer_.clear(guide);
        // The guides belong to the accompaniment and step back under the voices with it.
        addMedia(MediaSlot::ReferenceVocal, guide, buffer.frames, gains.reference * musicTrim_,
                 songPresentationTicks);
        addMedia(MediaSlot::Melody, guide, buffer.frames, gains.melody * musicTrim_,
                 songPresentationTicks);
        mixer_.add(output, guide, 1.0F);
        break;
    }
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
    // The saved performance is built on the song timeline: each voice is placed on the music it
    // was sung to rather than where it was heard (see PerformanceAligner).
    if (media_.context() != MediaContext::Karaoke) {
        backingSpectrum_.observe(performance, buffer.channels);
        std::copy(output.begin(), output.end(), performance.begin());
    }
    aligner_.add(performance, buffer.frames, 1.0F, 0);
    // Monitoring is a speaker preference, not a recording gate. Outside karaoke the output copied
    // above already carries a monitored microphone.
    if (microphoneEnabled && (media_.context() == MediaContext::Karaoke || !monitoring))
        aligner_.add(mic, buffer.frames, gains.microphone, voiceLateFrames);
    network_.setOwnVoiceRms(microphoneEnabled ? ownVoice_.rms() * gains.microphone : 0.0F);
    auto remote = buffers_.buffer(2, buffer.frames);
    std::fill(remote.begin(), remote.end(), 0.0F);
    (void)network_.renderRemote(generation, remote, buffer.frames,
                                network_.roomTimelineFrame(buffer.presentationTicks != 0
                                    ? buffer.presentationTicks : monotonicTicksNow(), sessionFrame().value()));
    mixer_.add(output, remote, gains.remote);
    // Remote voices are heard one room playout delay after the music they were sung to, minus
    // whatever this singer's own song is delayed to follow them.
    aligner_.add(remote, buffer.frames, gains.remote,
                 remoteDelayFrames > followFrames ? remoteDelayFrames - followFrames : 0U);
    aligner_.read(performance, buffer.frames);
    renderTone(output, buffer.frames);
    mixer_.applyMaster(performance);
    recording_.push(generation, RecordingTap::PerformanceMix, sessionFrame(), performance,
                    buffer.frames);
    mixer_.applyMaster(output);
    // After the master volume: a calibration must stay audible even when the mix is turned down.
    latencyMeter_.render(output, buffer.frames, buffer.channels, buffer.presentationTicks);
    spectrum_.observe(output, buffer.channels);
    recording_.push(generation, RecordingTap::MasterMix, sessionFrame(), output, buffer.frames);
    sessionFrameValue_.fetch_add(buffer.frames, std::memory_order_relaxed);
    latency_.set(LatencyRegistry::Stage::ClockBridge,
                 LatencyRegistry::convertFrames(bridge.capacityFrames, plan_.inputSampleRateHz,
                                                plan_.internalSampleRateHz),
                 0,
                 LatencyRegistry::convertFrames(
                     smoothBridgeLatencyFrames(
                         meanBridgeFillFrames(bridgeFillBeforePullFrames, renderAt)),
                     plan_.inputSampleRateHz, plan_.internalSampleRateHz));
    lastRenderAt_ = renderAt;
    bridgeFillAfterRenderFrames_ = bridge.fillFrames;
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
            renderUnderruns_.load(std::memory_order_relaxed),
            presentationJumps_.load(std::memory_order_relaxed),
            presentationJumpMaxNs_.load(std::memory_order_relaxed)};
}
