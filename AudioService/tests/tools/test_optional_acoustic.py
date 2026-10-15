"""Focused production-code tests; not Windows/device or acoustic acceptance.

Runs the real latency formula and real service calibration methods/IPC branch bodies against
controlled collaborators. This does not pretend to run the complete audio graph.
"""
from __future__ import annotations

from pathlib import Path
import subprocess
import sys
import tempfile
import unittest

sys.path.insert(0, str(Path(__file__).resolve().parent))
import cxx_compiler  # noqa: E402

ROOT = Path(__file__).resolve().parents[2]


def function(source: str, signature: str) -> str:
    start = source.index(signature)
    opening = source.index('{', start)
    depth = 0
    for offset in range(opening, len(source)):
        depth += (source[offset] == '{') - (source[offset] == '}')
        if depth == 0:
            return source[start:offset + 1]
    raise ValueError(signature)


SUPPORT = r'''
#include "diagnostics/LatencyRegistry.hpp"
#include "diagnostics/SongCalibrationPolicy.hpp"
#include <cmath>
#include <map>
#include <optional>
#include <stdexcept>
#include <string>
#include <iostream>
constexpr float MaxAcousticLatencyMs = 500;
constexpr double NanosecondsPerMillisecond = 1e6;
enum class PlaybackState { Empty, Ready, Playing, Paused, Finished };
enum class RecordingState { Idle, Prepared, Recording, Paused, Finalizing, Finished, Failed };
enum class MediaSlot { Music, Preview, Radio, RecordingPreview };
enum class ControlCommand { SetAcousticLatency, RememberAcousticLatency, MeasureAcousticLatency };
enum class ControlStatus { Ok, InvalidRequest };
struct ControlResponse { ControlStatus status; std::string text; };
struct ControlRequest {
    ControlCommand command;
    std::map<std::string,std::string,std::less<>> fields;
    std::string_view value(std::string_view key) const {
        auto it=fields.find(key); return it==fields.end()?std::string_view{}:it->second;
    }
};
struct AudioService {
    struct Media {
        PlaybackState state{PlaybackState::Ready}, other{PlaybackState::Ready};
        struct Snapshot { PlaybackState state; };
        Snapshot snapshot(MediaSlot slot) const { return {slot==MediaSlot::Music?state:other}; }
    } media_;
    struct Recording {
        RecordingState value{RecordingState::Idle};
        RecordingState state() const { return value; }
    } recording_;
    struct Realtime {
        bool valid{false}, accepted{true};
        MonotonicTicks ns{0}; int applied{0}, measurements{0};
        bool acousticCalibrationValid() const { return valid; }
        void setAcousticLatency(MonotonicTicks value) { ns=value;valid=true;++applied; }
        MonotonicTicks calibrationContext() const { return 123; }
        bool acceptsAcousticLatency(MonotonicTicks) const { return accepted; }
        bool startAcousticLatencyMeasurement() { ++measurements; return true; }
    } realtime_;
    std::map<std::string,MonotonicTicks,std::less<>> rememberedCalibrations_;
    CalibrationOrigin calibrationOrigin_{CalibrationOrigin::None};
    std::string path{"WASAPI Shared,mic,out,48000,48000,480,480,1056,1056"};
    std::string calibrationFingerprint() const { return path; }
    static float floatValue(std::string_view text,float fallback) {
        return text.empty()?fallback:std::stof(std::string(text));
    }
    void applyRememberedCalibration() noexcept;
    bool calibrationChangeBlocked() const noexcept;
    std::optional<ControlResponse> handleMixerControl(const ControlRequest& request);
    void dispatchPreamble() { __PREAMBLE__ }
};
__METHODS__
std::optional<ControlResponse> AudioService::handleMixerControl(const ControlRequest& request) {
    switch(request.command) {
        __CASES__
    default: return std::nullopt;
    }
}
int checks=0;
void check(bool value,const char* text) {
    ++checks; if(!value) throw std::runtime_error(text);
    std::cout<<"PASS "<<text<<'\n';
}
int main() {
    constexpr MonotonicTicks start=1'000'000'000, end=1'030'000'000;
    check(LatencyRegistry::observedMonitoringTicks(start,end,0,48000)==30'000'000,
          "uncalibrated observed interval exists without any PCM correlation");
    check(LatencyRegistry::observedMonitoringTicks(start,end,96,48000)==32'000'000,
          "only algorithmic DSP is added to timestamp difference");
    check(LatencyRegistry::observedMonitoringTicks(start,end,441,44100)==40'000'000,
          "algorithmic delay uses the actual internal sample rate");
    for(auto capture: {MonotonicTicks{0},MonotonicTicks{-1},end,end+1})
        check(LatencyRegistry::observedMonitoringTicks(capture,end,0,48000)==-1,
              "invalid capture interval is unknown, not zero");
    check(LatencyRegistry::observedMonitoringTicks(start,0,0,48000)==-1,"missing presentation is unknown");
    check(LatencyRegistry::observedMonitoringTicks(start,end,0,0)==-1,"missing rate is unknown");
    check(LatencyRegistry::observedMonitoringTicks(1,INT64_MAX,UINT32_MAX,1)==-1,"overflow is unknown");
    LatencyRegistry registry;
    registry.set(LatencyRegistry::Stage::Capture,10000,0,480);
    registry.set(LatencyRegistry::Stage::ClockBridge,10000,0,48);
    registry.set(LatencyRegistry::Stage::Dsp,0,96,0);
    registry.set(LatencyRegistry::Stage::OutputDriver,10000,0,480);
    for(auto stage:{LatencyRegistry::Stage::NetworkSend,LatencyRegistry::Stage::RecordingQueue,
                   LatencyRegistry::Stage::NetworkJitter,LatencyRegistry::Stage::RenderPadding})
        registry.set(stage,10000,1000,5000);
    check(registry.totalFrames()==1104,"parallel network/recording queues and endpoint capacity do not inflate local model");
    check(LatencyRegistry::observedMonitoringTicks(start,end,96,48000)==32'000'000,
          "queues are not counted twice in the observed interval");

    AudioService s;
    s.dispatchPreamble();
    check(!s.realtime_.valid && s.realtime_.measurements==0,"new profile never starts an acoustic measurement");
    ControlRequest remember{ControlCommand::RememberAcousticLatency,{{"ms","44.7"},{"fingerprint",s.path}}};
    auto result=s.handleMixerControl(remember);
    check(result->status==ControlStatus::Ok && std::llabs(s.realtime_.ns-44'700'000)<=2,
          "saved profile restores at idle (existing float IPC precision)");
    check(s.calibrationOrigin_==CalibrationOrigin::Profile,"saved profile retains its origin");
    s.realtime_.setAcousticLatency(45'200'000);
    const auto calls=s.realtime_.applied;
    s.dispatchPreamble();
    (void)s.handleMixerControl(remember);
    check(s.realtime_.ns==45'200'000 && s.realtime_.applied==calls,"a valid active correction is never reset or silently replaced");
    for(auto state:{PlaybackState::Playing,PlaybackState::Paused}) {
        AudioService active; active.media_.state=state;
        ControlRequest req{ControlCommand::RememberAcousticLatency,{{"ms","44.7"},{"fingerprint",active.path}}};
        (void)active.handleMixerControl(req); active.dispatchPreamble();
        check(!active.realtime_.valid && active.rememberedCalibrations_.size()==1,"late profile saved but deferred during playing/paused song");
        auto measure=active.handleMixerControl({ControlCommand::MeasureAcousticLatency,{}});
        check(measure->status==ControlStatus::InvalidRequest && active.realtime_.measurements==0,"no diagnostic chirps during playing/paused song");
        auto set=active.handleMixerControl({ControlCommand::SetAcousticLatency,{{"ms","0"},{"context","123"}}});
        check(set->status==ControlStatus::InvalidRequest,"explicit calibration cannot retime active performance");
        active.media_.state=PlaybackState::Finished; active.dispatchPreamble();
        check(active.realtime_.valid,"deferred profile restores after song ends");
    }
    for(auto state:{RecordingState::Prepared,RecordingState::Recording,RecordingState::Paused,RecordingState::Finalizing}) {
        AudioService active; active.recording_.value=state;
        (void)active.handleMixerControl({ControlCommand::RememberAcousticLatency,{{"ms","44.7"},{"fingerprint",active.path}}});
        active.dispatchPreamble();
        check(!active.realtime_.valid,"profile cannot retime an open recording, including pause/finalization");
        auto measure=active.handleMixerControl({ControlCommand::MeasureAcousticLatency,{}});
        check(measure->status==ControlStatus::InvalidRequest && active.realtime_.measurements==0,"open recording prevents diagnostic sounds");
    }
    {
        AudioService radio; radio.media_.other=PlaybackState::Playing;
        auto measure=radio.handleMixerControl({ControlCommand::MeasureAcousticLatency,{}});
        check(measure->status==ControlStatus::InvalidRequest && radio.realtime_.measurements==0,"no diagnostic chirps over a playing preview or radio");
    }
    AudioService idle;
    auto measured=idle.handleMixerControl({ControlCommand::MeasureAcousticLatency,{}});
    check(measured->status==ControlStatus::Ok && idle.realtime_.measurements==1,"explicit optional diagnostic remains available at idle");
    idle.realtime_.accepted=false;
    auto invalid=idle.handleMixerControl({ControlCommand::SetAcousticLatency,{{"ms","45"},{"context","123"}}});
    check(invalid->status==ControlStatus::InvalidRequest && !idle.realtime_.valid,"original measurement-validity check is not weakened");
    for(int i=0;i<64;++i) idle.rememberedCalibrations_[std::to_string(i)]=i+1;
    const auto before=idle.rememberedCalibrations_;
    auto full=idle.handleMixerControl({ControlCommand::RememberAcousticLatency,{{"ms","45"},{"fingerprint","new"}}});
    check(full->status==ControlStatus::InvalidRequest && before==idle.rememberedCalibrations_,"full cache never deletes a checked profile to admit another");
    std::cout<<"CHECKS "<<checks<<'\n';
}
'''


class OptionalAcousticTests(unittest.TestCase):
    def test_real_formula_and_calibration_control(self):
        if not cxx_compiler.available():
            self.skipTest('C++20 compiler required; not a passed native build')
        service = (ROOT / 'src/app/AudioService.cpp').read_text()
        commands = (ROOT / 'src/app/AudioServiceCommands.cpp').read_text()
        methods = '\n'.join(function(service, signature) for signature in (
            'void AudioService::applyRememberedCalibration()',
            'bool AudioService::calibrationChangeBlocked()',
        ))
        begin = commands.index('    case ControlCommand::SetAcousticLatency:')
        end = commands.index('    case ControlCommand::SetRoomFollow:', begin)
        measure_start = commands.index('    case ControlCommand::MeasureAcousticLatency:')
        measure_end = commands.index('    case ControlCommand::GetAcousticLatency:', measure_start)
        preamble_start = commands.index('    if (!realtime_.acousticCalibrationValid() && !calibrationChangeBlocked())')
        preamble_end = commands.index('    if (request.protocolVersion', preamble_start)
        program = (SUPPORT.replace('__METHODS__',methods)
                   .replace('__CASES__',commands[begin:end]+commands[measure_start:measure_end])
                   .replace('__PREAMBLE__',commands[preamble_start:preamble_end]))
        with tempfile.TemporaryDirectory() as directory:
            source=Path(directory)/'main.cpp'; binary=Path(directory)/'checks';source.write_text(program)
            built=cxx_compiler.build([source,ROOT/'src/diagnostics/LatencyRegistry.cpp'],binary,
                                     [ROOT/'src'])
            self.assertEqual(built.returncode,0,built.stdout+built.stderr)
            subprocess.run([str(cxx_compiler.executable(binary))],check=True)

    def test_normal_audio_never_runs_passive_acoustic_analysis(self):
        source=(ROOT/'src/realtime/RealtimeEngine.cpp').read_text()
        commands=(ROOT/'src/app/AudioServiceCommands.cpp').read_text()
        self.assertNotIn('passiveLatency_.prepare(',source)
        self.assertNotIn('passiveLatency_.observe(',source)
        self.assertNotIn('adoptPassiveCalibration()',commands)
        # Routing and compensation remain real, not dependent on a recording or monitoring gate.
        capture=function(source,'void RealtimeEngine::onCapture(')
        self.assertIn('network_.pushLocal(',capture)
        self.assertNotIn('monitoring_',capture)
        sung=function(source,'RealtimeEngine::voiceSungAt(')
        self.assertIn('acousticLatencyNs_.load',sung)
        render=function(source,'void RealtimeEngine::onRender(')
        self.assertIn('if (performanceActive && microphoneEnabled)',render)
        self.assertNotIn('MediaContext::Karaoke || !monitoring',render)
        self.assertIn('captureTimelineUsable_.load',render)
        self.assertIn('micFrames == buffer.frames',render)
        backend=(ROOT/'src/backend/wasapi/WasapiBackend.cpp').read_text()
        self.assertIn('qpc != 0 && (flags & AUDCLNT_BUFFERFLAGS_TIMESTAMP_ERROR) == 0',backend)


if __name__=='__main__':
    unittest.main(verbosity=2)
