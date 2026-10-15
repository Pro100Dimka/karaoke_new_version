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
struct Contribution { std::vector<float> pcm; unsigned lateFrames; };
struct Aligner {
    std::vector<Contribution> contributions;
    void add(std::span<const float> samples,unsigned,float gain,unsigned delay) {
        auto pcm=std::vector<float>(samples.begin(),samples.end());
        for(auto& sample:pcm) sample*=gain;
        contributions.push_back({std::move(pcm),delay});
    }
};
struct RealtimeEngine {
    Buffers buffers_; Mixer mixer_; Media media_; Spectrum backingSpectrum_; Aligner aligner_;
    bool songUnderway_{};
    std::uint32_t addMedia(MediaSlot,std::span<float>,unsigned,float,MonotonicTicks = 0) noexcept;
    void route(MediaContext context,bool monitoring,bool microphoneEnabled,bool performanceActive) {
        media_.current=context;
        Buffer buffer; Gains gains;
        auto output=buffers_.buffer(0,buffer.frames);
        // The earlier production monitor stage can supply any limited/faded self-voice.
        std::fill(output.begin(),output.end(),monitoring?0.03F:0.0F);
        auto mic=buffers_.buffer(1,buffer.frames); std::fill(mic.begin(),mic.end(),0.2F);
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
        if(a[i].lateFrames!=b[i].lateFrames || a[i].pcm!=b[i].pcm) return false;
    return true;
}
int main() {
    for(auto context:{MediaContext::Karaoke,MediaContext::EditorPreview,MediaContext::Radio,
                     MediaContext::RecordingPreview,MediaContext::None}) {
        RealtimeEngine off,on;
        off.route(context,false,true,true); on.route(context,true,true,true);
        check(same(off.aligner_.contributions,on.aligner_.contributions),"identical recorded PCM and timing with monitoring on/off");
        check(on.aligner_.contributions.size()==2 && on.aligner_.contributions[1].lateFrames==17,
              "processed voice enters user recording once at the corrected time");
        check(std::abs(on.aligner_.contributions[1].pcm[0]-0.15F)<1e-6F,
              "recorded own voice does not inherit monitor fade/limiter");
        const auto audible=on.buffers_.data[0][0]-off.buffers_.data[0][0];
        check(std::abs(audible-0.03F)<1e-6F,"monitor toggle affects only local listening");
        RealtimeEngine stopped; stopped.route(context,true,true,false);
        check(stopped.aligner_.contributions.empty(),"no user recording writes before recording is active");
        RealtimeEngine disabled; disabled.route(context,true,false,true);
        check(disabled.aligner_.contributions.size()==1,"microphone disable still gates user voice, not backing");
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
        program=SUPPORT.replace('__ROUTING__',source[start:end]).replace('__ADDMEDIA__',source[addstart:addend])
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
