"""Actual render-routing block against controlled PCM/media/aligner collaborators.

This verifies monitor-independent user PerformanceMix routing, not device audio, the real
PerformanceAligner, an end-to-end recording or the deliberate MasterMix output diagnostic tap.
AD_VOICE_ROUTING_SOURCE may select an original file to demonstrate the pre-fix regression.
"""
from pathlib import Path
import os
import subprocess
import sys
import tempfile
import unittest

sys.path.insert(0, str(Path(__file__).resolve().parent))
import cxx_compiler  # noqa: E402

ROOT = Path(__file__).resolve().parents[2]
SUPPORT = r'''
#include <algorithm>
#include <array>
#include <cmath>
#include <cstdint>
#include <iostream>
#include <span>
#include <stdexcept>
#include <vector>
using MonotonicTicks = long long;
enum class MediaSlot { Music, ReferenceVocal, Melody, Preview, Radio, RecordingPreview };
enum class MediaContext { Karaoke, EditorPreview, Radio, RecordingPreview, None };
enum class RecordingTap { RawInput, PerformanceMix };
struct Buffer { unsigned frames{4}, channels{2}; };
struct Gains { float master{0.5F}, music{0.8F}, reference{0.7F}, melody{0.6F}, preview{0.9F}, radio{0.4F}, microphone{0.75F}; };
struct Media {
    MediaContext current{MediaContext::None};
    MediaContext context()const { return current; }
    unsigned render(MediaSlot slot,std::span<float> data,unsigned frames,MonotonicTicks = 0) {
        const auto value = 0.01F*(1+static_cast<unsigned>(slot));
        std::fill(data.begin(),data.end(),value); return frames;
    }
};
struct Buffers {
    std::array<std::array<float,8>,6> data{};
    std::span<float> buffer(unsigned index,unsigned frames) { return {data.at(index).data(),frames*2}; }
};
struct Mixer {
    void clear(std::span<float> data) { std::fill(data.begin(),data.end(),0); }
    void add(std::span<float> to,std::span<const float> from,float gain) {
        for(unsigned i=0;i<to.size();++i) to[i]+=from[i]*gain;
    }
};
struct Spectrum { void observe(std::span<const float>,unsigned,float = 1) {} };
struct Recording {
    bool backing{false}; RecordingTap tap{RecordingTap::PerformanceMix};
    float observedVoicePeak{0};
    bool backingEnabled()const { return backing; }
    RecordingTap selectedTap()const { return tap; }
    void observeVoicePeak(float peak) { observedVoicePeak=peak; }
};
struct Contribution { std::vector<float> pcm; unsigned lateFrames; bool voice{false}; };
struct Aligner {
    std::vector<Contribution> contributions;
    void add(std::span<const float> samples,unsigned,float gain,unsigned delay) {
        auto pcm=std::vector<float>(samples.begin(),samples.end());
        for(auto& sample:pcm) sample*=gain;
        contributions.push_back({std::move(pcm),delay});
    }
    void addVoice(std::span<const float> samples,unsigned frames,float gain,unsigned delay) {
        add(samples,frames,gain,delay); contributions.back().voice=true;
    }
};
__PCM_PEAK__
struct RealtimeEngine {
    Buffers buffers_; Mixer mixer_; Media media_; Spectrum backingSpectrum_; Recording recording_;
    Aligner aligner_,dryAligner_,backingAligner_;
    bool songUnderway_{};
    unsigned dspLatencyFrames()const { return 5; }
    std::uint32_t addMedia(MediaSlot,std::span<float>,unsigned,float,MonotonicTicks = 0) noexcept;
    void route(MediaContext context,bool monitoring,bool microphoneEnabled,bool performanceActive) {
        media_.current=context;
        Buffer buffer; Gains gains;
        auto output=buffers_.buffer(0,buffer.frames);
        // The earlier production monitor stage can supply any limited/faded self-voice.
        std::fill(output.begin(),output.end(),monitoring?0.03F:0.0F);
        auto mic=buffers_.buffer(1,buffer.frames); std::fill(mic.begin(),mic.end(),0.2F);
        auto rawMic=buffers_.buffer(5,buffer.frames); std::fill(rawMic.begin(),rawMic.end(),0.4F);
        const float songLoudness=1.2F;
        const unsigned voiceLateFrames=17;
        const MonotonicTicks presentationTicks=1'000'000'000;
        __ROUTING__
        (void)mediaFrames;
    }
};
__ADDMEDIA__
int checks=0;
void check(bool good,const char* label) {
    if(!good) throw std::runtime_error(label);
    ++checks; std::cout<<"PASS "<<label<<'\n';
}
bool same(const std::vector<Contribution>& a,const std::vector<Contribution>& b) {
    if(a.size()!=b.size()) return false;
    for(unsigned i=0;i<a.size();++i)
        if(a[i].lateFrames!=b[i].lateFrames || a[i].pcm!=b[i].pcm || a[i].voice!=b[i].voice)
            return false;
    return true;
}
int main() {
    for(auto recording:{Recording{false,RecordingTap::PerformanceMix},
                        Recording{true,RecordingTap::PerformanceMix},
                        Recording{true,RecordingTap::RawInput}})
    for(auto context:{MediaContext::Karaoke,MediaContext::EditorPreview,MediaContext::Radio,
                     MediaContext::RecordingPreview,MediaContext::None}) {
        RealtimeEngine off,on,stopped,disabled;
        for(auto* engine:{&off,&on,&stopped,&disabled}) engine->recording_=recording;
        off.route(context,false,true,true); on.route(context,true,true,true);
        check(same(off.aligner_.contributions,on.aligner_.contributions),"identical recorded PCM and timing with monitoring on/off");
        check(on.aligner_.contributions.size()==2 && on.aligner_.contributions[1].lateFrames==17 &&
              on.aligner_.contributions[1].voice,
              "processed voice enters user recording once at the corrected time");
        check(std::abs(on.aligner_.contributions[1].pcm[0]-0.15F)<1e-6F,
              "recorded own voice does not inherit monitor fade/limiter");
        check(std::abs(on.recording_.observedVoicePeak-0.15F)<1e-6F &&
              on.recording_.observedVoicePeak==off.recording_.observedVoicePeak,
              "voice peak observation uses the same gained processed PCM with either monitor state");
        const auto audible=on.buffers_.data[0][0]-off.buffers_.data[0][0];
        check(std::abs(audible-0.03F)<1e-6F,"monitor toggle affects only local listening");
        stopped.route(context,true,true,false);
        check(stopped.aligner_.contributions.empty() && stopped.dryAligner_.contributions.empty() &&
              stopped.backingAligner_.contributions.empty(),
              "no user recording writes before recording is active");
        disabled.route(context,true,false,true);
        check(disabled.aligner_.contributions.size()==1,"microphone disable still gates user voice, not backing");
        const auto paired=recording.backing && recording.tap==RecordingTap::PerformanceMix;
        const auto pairedCount=paired?1U:0U;
        check(on.dryAligner_.contributions.size()==pairedCount &&
              on.backingAligner_.contributions.size()==pairedCount,
              "raw and backing stems are written only for paired performance recording");
        check(same(off.dryAligner_.contributions,on.dryAligner_.contributions) &&
              same(off.backingAligner_.contributions,on.backingAligner_.contributions),
              "paired raw and backing PCM and timing do not depend on monitoring");
        check(disabled.dryAligner_.contributions.empty() &&
              disabled.backingAligner_.contributions.size()==pairedCount,
              "microphone disable gates raw voice while preserving paired backing");
        if(paired) {
            const auto& dry=on.dryAligner_.contributions.front();
            const auto& backing=on.backingAligner_.contributions.front();
            check(dry.voice && dry.lateFrames==12 && dry.pcm==std::vector<float>(8,0.4F),
                  "raw voice is captured once at unity before backing reuse, with DSP delay removed");
            check(!backing.voice && backing.lateFrames==0 &&
                  backing.pcm==on.aligner_.contributions.front().pcm,
                  "paired backing preserves the exact gained accompaniment without voice");
        }
    }
    std::cout<<"CHECKS "<<checks<<'\n';
}
'''

class MonitorRecordingTests(unittest.TestCase):
    def test_real_media_and_voice_routing(self):
        if not cxx_compiler.available():
            self.skipTest('C++20 compiler required')
        source=Path(os.environ.get('AD_VOICE_ROUTING_SOURCE',ROOT/'src/realtime/RealtimeEngine.cpp')).read_text()
        start=source.index('    const auto songPresentationTicks = presentationTicks;')
        end=source.index('    auto remote = buffers_.buffer',start)
        addstart=source.rindex(chr(10),0,source.index('RealtimeEngine::addMedia('))+1
        addend=source.index('// Test and synchronisation tones',addstart)
        peakstart=source.index('[[nodiscard]] float pcmPeak(')
        peakend=source.index('void retainPeak(',peakstart)
        program=SUPPORT.replace('__ROUTING__',source[start:end]).replace('__ADDMEDIA__',source[addstart:addend])
        program=program.replace('__PCM_PEAK__',source[peakstart:peakend])
        if source[addstart:].startswith('void'):  # a pre-fix source passed for the RED check
            program=(program.replace('std::uint32_t addMedia(','void addMedia(')
                     .replace('(void)mediaFrames;',''))
        with tempfile.TemporaryDirectory() as directory:
            main=Path(directory)/'main.cpp'; binary=Path(directory)/'checks'; main.write_text(program)
            built=cxx_compiler.build([main],binary)
            self.assertEqual(built.returncode,0,built.stdout+built.stderr)
            subprocess.run([str(cxx_compiler.executable(binary))],check=True)

if __name__=='__main__':
    unittest.main(verbosity=2)
