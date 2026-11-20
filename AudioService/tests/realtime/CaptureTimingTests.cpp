#include "TestHarness.hpp"
#include "app/AudioService.hpp"
#include "backend/fake/FakeAudioBackend.hpp"
#include "media/WavDecoder.hpp"

#include <algorithm>
#include <array>
#include <span>

namespace Tests {
namespace {
constexpr std::uint32_t SampleRate = 48'000;
constexpr std::uint32_t TotalFrames = 38'400;
constexpr std::uint32_t FaultFrame = 28'800;
constexpr MonotonicTicks RenderLeadNs = 30'000'000;

struct CaptureChange {
    const char* name;
    MonotonicTicks timestampOffsetNs{0};
    std::int64_t positionOffsetFrames{0};
    std::uint32_t packets{1};
    bool zeroTimestamp{false};
    bool firstPacket{false};
    bool discontinuity{false};
    bool overflowBeforeFault{false};
    bool lateDelivery{false};
};

struct CaptureResult {
    std::vector<float> monitor, recorded;
    RealtimeSnapshot state;
    MonotonicTicks latePacketAgeNs{0};
};

MonotonicTicks frameTime(std::uint32_t frame) {
    return static_cast<MonotonicTicks>(frame) * 1'000'000'000 / SampleRate;
}

CaptureResult captureTimingRun(const CaptureChange& change, std::uint32_t period,
                              RecordingTap tap) {
    FakeBackendSettings settings;
    settings.runtime.inputPeriodFrames = settings.runtime.outputPeriodFrames = period;
    settings.runtime.inputEndpointBufferFrames = settings.runtime.outputEndpointBufferFrames = period * 2;
    settings.runtime.clockRelationship = ClockRelationship::Independent;
    AudioService service{std::make_unique<FakeAudioBackend>(settings)};
    service.start();
    (void)service.session().prepare(RequestedConfiguration{.sampleRateHz = SampleRate});
    service.session().start();
    auto& engine = service.realtime();
    engine.setDspEnabled(false);
    engine.setMonitoring(true);
    const auto generation = service.session().generationId();
    const auto path = tempRoot / (std::string{change.name} + "-" + std::to_string(period) + "-" +
                                  std::to_string(static_cast<int>(tap)) + ".wav");
    service.recording().prepare(change.name, path.string(), SampleRate, 2, tap, SampleRate);
    service.recording().start(engine.sessionFrame(), 0,
                              tap == RecordingTap::PerformanceMix ? engine.performanceLeadFrames() : 0);
    // A short deterministic trace stays in the monotonic past without sleeping. The paced
    // WASAPI reproduction separately checks the backend's one-second QPC plausibility gate.
    const auto origin = (monotonicTicksNow() - 950'000'000) / 100 * 100;
    std::vector<float> input(period), output(period * 2);
    CaptureResult result;
    result.monitor.reserve(TotalFrames * 2);
    std::uint32_t captured = 0, renderStallFrames = 0;
    const auto capture = [&](bool invalid) {
        for (std::uint32_t frame = 0; frame < period; ++frame) {
            const auto phase = 2.0 * 3.141592653589793 * 220.0 * (captured + frame) / SampleRate;
            input[frame] = static_cast<float>(0.15 * std::sin(phase) + 0.05 * std::sin(phase * 2) +
                                               0.03 * std::sin(phase * 4));
        }
        const auto ticks = origin + frameTime(captured);
        BackendAudioBuffer buffer{input.data(), nullptr, period, 1, captured, ticks / 100, 0, 0,
                                  ticks / 100 * 100};
        if (invalid) {
            buffer.flags = 4; // AUDCLNT_BUFFERFLAGS_TIMESTAMP_ERROR; PCM remains valid.
            buffer.captureTimestampValid = false;
            buffer.devicePosition += change.positionOffsetFrames;
            buffer.timestamp = change.zeroTimestamp ? 0 : (ticks + change.timestampOffsetNs) / 100;
            buffer.captureTicks = buffer.timestamp * 100;
            engine.onBackendEvent(generation, BackendEventType::TimestampError, 4);
            if (change.discontinuity) {
                buffer.flags |= 1;
                engine.onBackendEvent(generation, BackendEventType::DataDiscontinuity, 1);
            }
        }
        engine.onCapture(generation, buffer);
        captured += period;
    };
    const auto fault = change.firstPacket ? 0U : FaultFrame;
    for (std::uint32_t frame = 0; frame < TotalFrames; frame += period) {
        if (change.overflowBeforeFault && frame + period == FaultFrame) {
            const auto packets = service.session().plan().clockBridgeCapacityFrames / period + 2;
            for (std::uint32_t packet = 0; packet < packets; ++packet)
                capture(false);
            renderStallFrames += packets * period;
        }
        if (change.lateDelivery && frame == FaultFrame + period * 2) {
            capture(false);
            capture(false);
        }
        if (!(change.lateDelivery && frame >= FaultFrame && frame < FaultFrame + period * 2))
            capture(frame >= fault && frame < fault + change.packets * period && !change.lateDelivery);
        const auto renderPosition = frame + renderStallFrames;
        const auto presentation = origin + frameTime(renderPosition) + RenderLeadNs;
        engine.onRender(generation, {nullptr, output.data(), period, 2, renderPosition, presentation / 100, 0,
                                     presentation});
        result.monitor.insert(result.monitor.end(), output.begin(), output.end());
        if (frame == FaultFrame + period * 2)
            result.latePacketAgeNs = engine.observedMonitoringLatencyNs();
    }
    result.state = engine.snapshot();
    const auto recording = engine.finishRecording(RecordingState::Finished);
    require(recording.finalized && recording.overrunCount == 0 && recording.gaps.empty(),
            "capture timing test must not substitute a recording queue failure");
    WavDecoder decoder;
    const auto format = decoder.open(path.string());
    require(format.totalFrames == TotalFrames && format.channels == 2,
            "capture timing test preserves the complete recorded duration");
    result.recorded.resize(TotalFrames * 2);
    require(decoder.read(result.recorded, TotalFrames) == TotalFrames,
            "capture timing test reads the finalized recording");
    service.shutdown();
    return result;
}

float largestDifference(std::span<const float> first, std::span<const float> second) {
    require(first.size() == second.size(), "capture comparison requires identical frame counts");
    float difference = 0;
    for (std::size_t index = 0; index < first.size(); ++index)
        difference = std::max(difference, std::abs(first[index] - second[index]));
    return difference;
}
} // namespace

void invalidCaptureTimingPreservesWaveform() {
    constexpr CaptureChange baseline{"valid", 0, 0, 0};
    constexpr std::array changes{
        CaptureChange{"flag-only"}, CaptureChange{"stale-small", -5'000'000},
        CaptureChange{"stale-large", -200'000'000},
        CaptureChange{"invalid-position", 0, -9'600},
        CaptureChange{"invalid-pair", -200'000'000, -9'600},
        CaptureChange{.name = "zero-pair", .zeroTimestamp = true},
        CaptureChange{"consecutive-small", -5'000'000, 0, 3},
        CaptureChange{"consecutive-large", -200'000'000, -9'600, 3},
        CaptureChange{.name = "consecutive-zero", .packets = 3, .zeroTimestamp = true},
    };
    for (const auto period : {128U, 480U})
        for (const auto tap : {RecordingTap::RawInput, RecordingTap::PerformanceMix}) {
            const auto reference = captureTimingRun(baseline, period, tap);
            for (const auto& change : changes) {
                const auto actual = captureTimingRun(change, period, tap);
                const auto monitorError = largestDifference(reference.monitor, actual.monitor);
                const auto recordingError = largestDifference(reference.recorded, actual.recorded);
                expect(monitorError < 0.0001F && recordingError < 0.0001F &&
                           actual.state.micInsertedSilenceFrames == reference.state.micInsertedSilenceFrames,
                       std::string{change.name} + " period=" + std::to_string(period) +
                           " tap=" + std::to_string(static_cast<int>(tap)) +
                           " invalid timing must preserve PCM; monitor error=" +
                           std::to_string(monitorError) + " recording error=" +
                           std::to_string(recordingError));
                expect(actual.state.micCaptureSkippedFrames == reference.state.micCaptureSkippedFrames &&
                           actual.state.micCaptureRepeatedFrames == reference.state.micCaptureRepeatedFrames,
                       std::string{change.name} + " invalid position must not report missing or repeated PCM");
            }
        }
}

void captureTimingRecoveryPreservesRealDiscontinuities() {
    for (const auto period : {128U, 480U}) {
        constexpr CaptureChange baseline{"valid-delay-control", 0, 0, 0};
        const auto reference = captureTimingRun(baseline, period, RecordingTap::RawInput);
        const auto delayed = captureTimingRun({.name = "valid-late", .lateDelivery = true}, period,
                                             RecordingTap::RawInput);
        expect(delayed.state.micInsertedSilenceFrames == period * 2 &&
                   delayed.latePacketAgeNs >= reference.latePacketAgeNs + frameTime(period * 2) - 100,
               "valid capture delivered late retains its physical age and real PCM shortage");

        constexpr std::array unanchored{
            CaptureChange{.name = "first-invalid", .packets = 3, .zeroTimestamp = true,
                          .firstPacket = true},
            CaptureChange{.name = "discontinuous-invalid", .packets = 3, .zeroTimestamp = true,
                          .discontinuity = true},
        };
        for (const auto& change : unanchored) {
            const auto actual = captureTimingRun(change, period, RecordingTap::PerformanceMix);
            for (const auto* pcm : {&actual.monitor, &actual.recorded})
                expect(std::ranges::all_of(*pcm, [](float value) {
                           return std::isfinite(value) && std::abs(value) < 0.3F;
                       }) && std::ranges::any_of(*pcm, [](float value) { return std::abs(value) > 0.05F; }),
                       "unanchored capture timing keeps valid PCM finite, bounded and present");
            expect(actual.state.micInsertedSilenceFrames == 0,
                   "missing timestamp anchors must not discard present microphone PCM");
        }

        const auto overflow = captureTimingRun(
            {.name = "valid-overflow", .packets = 0, .overflowBeforeFault = true}, period,
            RecordingTap::PerformanceMix);
        const auto invalidAfterOverflow = captureTimingRun(
            {.name = "invalid-after-overflow", .zeroTimestamp = true, .overflowBeforeFault = true},
            period, RecordingTap::PerformanceMix);
        const auto monitorError = largestDifference(overflow.monitor, invalidAfterOverflow.monitor);
        const auto recordingError = largestDifference(overflow.recorded, invalidAfterOverflow.recorded);
        expect(overflow.state.captureOverruns > 0 &&
                   invalidAfterOverflow.state.captureOverruns == overflow.state.captureOverruns &&
                   monitorError < 0.0001F && recordingError < 0.0001F,
               "rejected capture preserves source time; period=" + std::to_string(period) +
                   " monitor error=" + std::to_string(monitorError) +
                   " recording error=" + std::to_string(recordingError));
    }
}
} // namespace Tests
