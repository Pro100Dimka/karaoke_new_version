#include "TestHarness.hpp"
#include "analysis/PitchEstimator.hpp"
#include "realtime/RealtimeInstrumentation.hpp"

#include <cmath>
#include <numbers>
#include <vector>

namespace Tests {
void pitchEstimatorPreservesReferenceResults() {
    struct Fixture {
        std::uint32_t rate;
        double frequency;
        float pitch;
        float confidence;
        double level{0.3};
        double harmonic{0};
        double noise{0};
    };
    // Recorded from the scalar NSDF implementation before batching its independent lags.
    constexpr Fixture fixtures[]{
        {44100, 80, 79.997756958F, 0.999994397163F},
        {48000, 220, 219.975631714F, 0.999858736992F, 0.18, 2.2, 0.1},
        {96000, 220, 219.304031372F, 0.960661768913F, 0.18, 0, 1.4},
        {192000, 220, 219.996826172F, 0.999963641167F, 0.18, 2.2, 0.1},
        {44100, 1180, 1179.74414062F, 0.997695147991F},
        {192000, 80, 79.9981079102F, 0.999999046326F},
        {48000, 0, 0, 0, 0.35, 0, 1},
        {96000, 20, 0, 0, 0.1},
        {192000, 220, 219.98991394F, 0.999993264675F, 0.0005},
        {8000, 220, 219.974227905F, 0.997995197773F},
        {11025, 220, 219.983596802F, 0.999888956547F},
        {88200, 440, 439.97555542F, 0.999879956245F},
    };
    PitchEstimator estimator;
    for (const auto& fixture : fixtures) {
        const auto frames = static_cast<std::uint32_t>(std::ceil(2048.0 * fixture.rate / 48000));
        estimator.prepare(frames, fixture.rate);
        std::vector<float> samples(static_cast<std::size_t>(frames) * 2U);
        std::uint32_t noise = 12345;
        for (std::uint32_t frame = 0; frame < frames; ++frame) {
            noise = noise * 1664525U + 1013904223U;
            const auto random = static_cast<double>(noise) / 4294967295.0 * 2 - 1;
            const auto phase = 2 * std::numbers::pi * fixture.frequency * frame / fixture.rate;
            samples[static_cast<std::size_t>(frame) * 2U] = static_cast<float>(
                fixture.level * (std::sin(phase) + fixture.harmonic * std::sin(phase * 2) + fixture.noise * random));
            samples[static_cast<std::size_t>(frame) * 2U + 1U] = static_cast<float>(random);
        }
        float confidence = 0;
        const auto pitch = estimator.estimate(samples, 2, confidence);
        expect(std::abs(pitch - fixture.pitch) < 0.0002F &&
                   std::abs(confidence - fixture.confidence) < 0.000001F,
               "prepared pitch analysis preserves scalar estimates and confidence across rates, harmonics, noise and quiet voices");
    }
}

void pitchEstimatorReusesPreparedStorage() {
    constexpr std::uint32_t frames = 8192, rate = 192000;
    PitchEstimator estimator;
    estimator.prepare(frames, rate);
    std::vector<float> voice(frames), silence(frames);
    for (std::uint32_t frame = 0; frame < frames; ++frame)
        voice[frame] = static_cast<float>(0.3 * std::sin(2 * std::numbers::pi * 220 * frame / rate));
    RealtimeInstrumentation::reset();
    bool detected = true;
    {
        RealtimeScope allocationCheck;
        for (int window = 0; window < 8; ++window) {
            float confidence = 0;
            detected &= std::abs(estimator.estimate(voice, 1, confidence) - 220) < 1;
            detected &= estimator.estimate(silence, 1, confidence) == 0 && confidence == 0;
        }
    }
    const auto activity = RealtimeInstrumentation::snapshot();
    expect(detected, "reused pitch storage distinguishes every voiced and silent window");
    expect(activity.allocations == 0 && activity.deallocations == 0,
           "pitch windows reuse prepared buffers without recurring allocations or deallocations");
}

void pitchEstimatorRejectsIncompleteWindows() {
    PitchEstimator estimator;
    const std::vector<float> samples(2048, 0.5F);
    float confidence = 1;
    expect(estimator.estimate(samples, 1, confidence) == 0 && confidence == 0,
           "an unprepared pitch estimator has no estimate");
    estimator.prepare(2048, 48000);
    for (const auto channels : {0U, 2U})
        expect(estimator.estimate(samples, channels, confidence) == 0 && confidence == 0,
               "zero channels and incomplete interleaved windows cannot read past prepared samples");
}
} // namespace Tests
