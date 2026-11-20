#include "TestHarness.hpp"

#include "app/AudioService.hpp"
#include "backend/fake/FakeAudioBackend.hpp"
#include "media/WavDecoder.hpp"

#include <algorithm>
#include <array>
#include <chrono>
#include <memory>
#include <span>
#include <thread>

namespace Tests {
namespace {
struct BoundaryTake {
    std::vector<float> dry, wet, backing;
    std::uint32_t renderedLookahead{0};
};
struct BoundaryTimeline {
    std::uint32_t blocks{5}, prefillBlocks{0};
    std::optional<std::int32_t> markerOffset;
};

BoundaryTake captureAtStop(std::string_view label, std::uint32_t inputRate,
                           std::uint32_t outputRate, std::uint32_t presentationLead,
                           std::span<const float> pending, bool renderLookahead = false,
                           BoundaryTimeline timeline = {}) {
    const auto inputBlock = inputRate / 100U;
    const auto outputBlock = outputRate / 100U;
    const auto cutoff = outputBlock * timeline.blocks;
    const auto path = tempRoot / (std::string(label) + ".wav");
    const auto source = tempRoot / (std::string(label) + "-backing.wav");
    {
        WavWriter writer;
        writer.open(source.string(), outputRate, 2, true);
        const std::vector<float> silence(static_cast<std::size_t>(cutoff + outputBlock) * 2U);
        writer.write(silence);
        writer.close(1.0F, true);
    }
    FakeBackendSettings settings;
    settings.runtime.inputSampleRateHz = inputRate;
    settings.runtime.outputSampleRateHz = outputRate;
    settings.runtime.inputPeriodFrames = inputBlock;
    settings.runtime.outputPeriodFrames = outputBlock;
    settings.runtime.inputEndpointBufferFrames = inputBlock * 2U;
    settings.runtime.outputEndpointBufferFrames = outputBlock * 2U;
    settings.runtime.clockRelationship = ClockRelationship::Independent;
    AudioService service{std::make_unique<FakeAudioBackend>(settings)};
    service.start();
    RequestedConfiguration requested;
    requested.sampleRateHz = outputRate;
    (void)service.session().prepare(requested);
    service.session().start();
    auto& engine = service.realtime();
    engine.setDspEnabled(false);
    engine.setMonitoring(false);
    engine.setSystemGain(1.0F);
    const auto generation = service.session().generationId();
    service.media().load(MediaSlot::Music, source.string());
    require(service.media().waitUntilReady(MediaSlot::Music) == PlaybackState::Ready,
            "capture boundary fixture needs a decoded silent accompaniment");
    require(service.handleLine("1|PrepareRecording|id=capture-boundary|tap=performance|backing=true|path=" +
                               path.string()).status == ControlStatus::Ok &&
                service.handleLine("1|StartRecording").status == ControlStatus::Ok,
            "capture boundary fixture starts the original paired recording path");
    service.media().play(MediaContext::Karaoke);
    const auto origin = monotonicTicksNow() - 5'000'000'000LL;
    std::vector<float> input(inputBlock), output(outputBlock * 2U);
    const auto capture = [&](std::uint32_t frame, std::span<const float> pcm) {
        const auto ticks = origin + static_cast<MonotonicTicks>(frame) * 1'000'000'000LL / inputRate;
        std::vector<float> marker;
        if (timeline.markerOffset) {
            marker.resize(pcm.size());
            const auto position = static_cast<std::int64_t>(cutoff + presentationLead) +
                                  *timeline.markerOffset;
            for (std::size_t index = 0; index < marker.size(); ++index)
                if (static_cast<std::int64_t>(frame) + static_cast<std::int64_t>(index) == position)
                    marker[index] = 0.4F;
            pcm = marker;
        }
        engine.onCapture(generation, {pcm.data(), nullptr, static_cast<std::uint32_t>(pcm.size()),
                                       1, frame, ticks / 100, 0, 0, ticks});
    };
    const auto render = [&](std::uint32_t frame, std::uint32_t frames) {
        const auto deadline = std::chrono::steady_clock::now() + std::chrono::seconds(2);
        while (service.media().snapshot(MediaSlot::Music).bufferFillFrames < frames &&
               std::chrono::steady_clock::now() < deadline)
            std::this_thread::yield();
        require(service.media().snapshot(MediaSlot::Music).bufferFillFrames >= frames,
                "the ordinary render control cannot underrun its accompaniment");
        const auto presentation = origin + static_cast<MonotonicTicks>(frame + presentationLead) *
                                              1'000'000'000LL / outputRate;
        // Keep the device-clock offset fixed even when the causal control renders one frame.
        const auto clock = origin + static_cast<MonotonicTicks>(frame + outputBlock) *
                                       1'000'000'000LL / outputRate;
        engine.onRender(generation, {nullptr, output.data(), frames, 2, frame,
                                      clock / 100, 0, presentation});
    };
    for (std::uint32_t block = 0; block < timeline.prefillBlocks; ++block)
        capture(block * inputBlock, input);
    for (std::uint32_t block = 0; block < timeline.blocks; ++block) {
        capture((block + timeline.prefillBlocks) * inputBlock, input);
        render(block * outputBlock, outputBlock);
    }
    capture(inputBlock * (timeline.blocks + timeline.prefillBlocks), pending);
    require(engine.snapshot().clockBridge.fillFrames >= pending.size() &&
                engine.snapshot().captureOverruns == 0,
            "the finite last packet is accepted after the last original render");
    std::uint32_t extraFrames = 0;
    if (renderLookahead) {
        // The control has one duplicated last input sample as ordinary interpolation lookahead.
        // Stop rendering as soon as that guard alone remains: it is not part of the oracle span.
        while (engine.snapshot().clockBridge.fillFrames > 1U && extraFrames < 8U) {
            render(cutoff + extraFrames, 1);
            ++extraFrames;
        }
        require(engine.snapshot().clockBridge.fillFrames == 1U && extraFrames != 0,
                "the causal control renders the original finite input and leaves only its guard");
    }
    const auto frames = cutoff + extraFrames;
    require(engine.sessionFrame() == SessionFrame{frames},
            "the stop boundary is the last completed render, not a future capture timestamp");
    if (timeline.prefillBlocks != 0) {
        const auto before = engine.snapshot();
        require(before.correctionRatio == 1.0 && before.driftPpm == 0.0 &&
                    before.clockBridge.fillCorrectionRatio > 1.0005 &&
                    before.clockBridge.droppedFrames == 0 && before.micInsertedSilenceFrames == 0,
                "the boundary control has actual fill correction, equal device clocks and no PCM loss");
    }
    service.session().stop();
    const auto result = service.recording().result();
    require(result.finalized && result.durationFrames == frames &&
                result.stopSessionFrame == SessionFrame{frames} && result.overrunCount == 0 &&
                result.errorMessage.empty(),
            "stopped capture finalizes at the fixed cutoff without a writer overrun or error");
    const auto decode = [&](std::string_view suffix) {
        WavDecoder decoder;
        const auto format = decoder.open(path.string() + std::string(suffix));
        require(format.sampleRateHz == outputRate && format.channels == 2 &&
                    format.totalFrames == frames,
                "every capture boundary stem retains its original output format and cutoff");
        std::vector<float> pcm(static_cast<std::size_t>(frames) * 2U);
        require(decoder.read(pcm, frames) == frames, "the complete saved stem is readable");
        return pcm;
    };
    return {decode(".dry.wav"), decode(".vocal.wav"), decode(".backing.wav"), extraFrames};
}

std::vector<float> nonzeroMono(std::span<const float> stereo) {
    std::vector<float> values;
    for (std::size_t sample = 0; sample < stereo.size(); sample += 2U) {
        require(stereo[sample] == stereo[sample + 1U], "the captured mono voice stays centred");
        if (std::abs(stereo[sample]) > 1.0e-7F)
            values.push_back(stereo[sample]);
    }
    return values;
}
} // namespace

void performancePendingCaptureRespectsPhysicalCutoff() {
    constexpr std::uint32_t Rate = 48'000, Block = 480, Cutoff = Block * 5U;
    std::vector<float> packet(Block);
    for (std::uint32_t frame = 0; frame < Block; ++frame)
        packet[frame] = 0.1F + static_cast<float>(frame) * 0.0002F;
    // The capture timestamp stays contiguous. Changing the output's presentation offset makes
    // the same packet wholly before, cross, or start exactly at the physical stop boundary.
    for (const auto beforeCutoff : {Block, Block / 2U, 0U}) {
        const auto saved = captureAtStop("capture-cutoff-" + std::to_string(beforeCutoff),
                                         Rate, Rate, beforeCutoff, packet);
        std::vector<float> expected(Cutoff * 2U);
        for (std::uint32_t frame = 0; frame < beforeCutoff; ++frame)
            for (std::uint32_t channel = 0; channel < 2; ++channel)
                expected[(Cutoff - beforeCutoff + frame) * 2U + channel] = packet[frame];
        const auto same = [](float a, float b) { return std::abs(a - b) < 1.0e-6F; };
        expect(std::equal(saved.dry.begin(), saved.dry.end(), expected.begin(), same) &&
                   std::equal(saved.wet.begin(), saved.wet.end(), expected.begin(), same),
               "only the captured samples strictly before the physical cutoff enter wet and dry stems");
        expect(std::ranges::all_of(saved.backing, [](float value) { return value == 0.0F; }),
               "draining pending microphone PCM never adds or rewrites accompaniment");
    }
    const std::vector<float> silence(Block);
    for (const auto markerOffset : {-2, 1}) {
        // Three initial packets activate the real fill regulator while both device clocks
        // remain exactly 48 kHz. A source impulse one frame AFTER P_C must not leak through
        // the faster conversion; the impulse two frames BEFORE P_C is the paired control.
        const auto saved = captureAtStop("regulated-cutoff-" + std::to_string(markerOffset),
                                         Rate, Rate, Block * 2U, silence, false,
                                         {50, 2, markerOffset});
        const auto captured = nonzeroMono(saved.dry);
        expect(markerOffset < 0 ? !captured.empty() : captured.empty(),
               "fill correction retains the before-cutoff impulse and excludes the after-cutoff impulse");
        expect(saved.dry == saved.wet,
               "physical cutoff clipping remains identical for paired raw and processed voice without DSP");
        expect(std::ranges::all_of(saved.backing, [](float value) { return value == 0.0F; }),
               "regulated microphone draining cannot rewrite the fixed accompaniment");
    }
}

void performancePendingCaptureRetainsFractionalTail() {
    struct Rates { std::uint32_t input, output, finalFrames; };
    // Five 10-ms packets leave a fractional interpolation phase at 44.1 -> 48 kHz. At the
    // reverse rate a single final source sample still spans one output frame. These expected
    // lengths come from the two sample grids, not from the new terminal-drain implementation.
    for (const auto rates : {Rates{44'100, 48'000, 3}, Rates{48'000, 44'100, 1}}) {
        const auto label = "capture-singleton-" + std::to_string(rates.input);
        const std::array<float, 1> terminal{0.35F};
        const std::array<float, 2> lookahead{0.35F, 0.35F};
        const auto lead = rates.output * 3U / 100U;
        const auto stopped = captureAtStop(label, rates.input, rates.output, lead, terminal);
        const auto rendered = captureAtStop(label + "-render", rates.input, rates.output, lead,
                                            lookahead, true);
        const auto actual = nonzeroMono(stopped.dry);
        const auto ordinary = nonzeroMono(rendered.dry);
        require(rendered.renderedLookahead == rates.finalFrames &&
                    ordinary.size() >= rates.finalFrames,
                "ordinary interpolation establishes the finite singleton's output sample count");
        expect(actual.size() == rates.finalFrames,
               "stopping retains each finite fractional-tail sample without adding a lookahead sample");
        if (actual.size() == rates.finalFrames)
            expect(std::equal(actual.begin(), actual.end(), ordinary.begin(),
                               [](float a, float b) { return std::abs(a - b) < 1.0e-6F; }),
                   "the stopped singleton uses the same phase and waveform as ordinary interpolation");
        expect(stopped.dry == stopped.wet,
               "mixed-rate terminal conversion keeps raw and processed capture paired with DSP disabled");
        expect(std::equal(stopped.backing.begin(), stopped.backing.end(), rendered.backing.begin()),
               "a fractional capture tail cannot advance the recorded accompaniment");
    }
}
} // namespace Tests
