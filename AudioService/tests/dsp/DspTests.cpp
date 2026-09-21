#include "TestHarness.hpp"
#include "dsp/DspChain.hpp"

#include <algorithm>
#include <vector>

namespace Tests {
void disabledDspIsExactBypass() {
    DspChain chain;
    chain.prepare(48000, 256, 2);
    std::vector<float> samples(512, 0.25F);
    const auto original = samples;
    chain.process(samples, 256);
    expect(samples == original, "disabled DSP is exact bypass");
}

void dspParametersAreValidated() {
    DspChain chain;
    chain.prepare(48000, 256, 2);
    chain.setEnabled(true);
    expect(chain.setParameter("pitch.semitones", 2.0F), "pitch parameter accepted");
    expect(chain.setParameter("reverb.mix", 0.2F), "reverb parameter accepted");
    expect(!chain.setParameter("unknown", 1.0F), "unknown DSP parameter rejected");
}

void activePitchReportsLatency() {
    DspChain chain;
    chain.prepare(48000, 256, 2);
    chain.setEnabled(true);
    expect(chain.setParameter("pitch.semitones", 2.0F), "pitch parameter accepted");
    expect(chain.latencyFrames() > 0, "active pitch reports DSP latency");
}

void dspOutputRemainsFinite() {
    DspChain chain;
    chain.prepare(48000, 256, 2);
    chain.setEnabled(true);
    expect(chain.setParameter("reverb.mix", 0.2F), "reverb parameter accepted");
    std::vector<float> samples(512, 0.25F);
    chain.process(samples, 256);
    expect(std::all_of(
               samples.begin(), samples.end(),
               [](float value) { return value == value && value >= -10.0F && value <= 10.0F; }),
           "DSP output remains finite and bounded");
}
} // namespace Tests
