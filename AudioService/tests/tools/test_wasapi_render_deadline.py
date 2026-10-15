"""Deterministic control-flow regression, NOT a Windows/device/audio test.

Compile the actual waitForSharedEnginePass() body and actual JIT target policy with
fake wait-any/QPC/capture operations. This detects deadline starvation without
copying a second implementation of the production loop into the test.

Run: python AudioService/tests/tools/test_wasapi_render_deadline.py
Set WASAPI_TEST_BACKEND_SOURCE to the old .cpp to reproduce RED.
Requires g++ or clang++; Windows-only backend integration still needs Windows.
"""
from __future__ import annotations

import os
from pathlib import Path
import shutil
import subprocess
import tempfile
import unittest

ROOT = Path(__file__).resolve().parents[2]


def function(source: str, signature: str) -> str:
    start = source.index(signature)
    opening = source.index("{", start)
    depth = 0
    for offset in range(opening, len(source)):
        if source[offset] == "{":
            depth += 1
        elif source[offset] == "}":
            depth -= 1
            if depth == 0:
                return source[start:offset + 1]
    raise ValueError(f"Unterminated function: {signature}")


HARNESS = r'''
#include <algorithm>
#include <atomic>
#include <cstdint>
#include <iostream>
#include <stdexcept>
#include <string>
#include <vector>
using MonotonicTicks = std::int64_t;
using LONGLONG = std::int64_t;
using HANDLE = int;
using DWORD = std::uint32_t;
constexpr bool FALSE = false;
constexpr DWORD WAIT_OBJECT_0=0, WAIT_FAILED=0xffffffffU, INFINITE=0xffffffffU;
struct LARGE_INTEGER { LONGLONG QuadPart{}; };
constexpr MonotonicTicks Ms=1'000'000, Start=100*Ms;
struct Simulation {
    MonotonicTicks now{Start}, due{0}, captureCost{Ms/4}, dispatchDelay{0};
    MonotonicTicks renderAt{0}, stopAt{0};
    bool armed{false}, timerFailure{false}, waitFailure{false}, resignal{false};
    std::vector<MonotonicTicks> captureTimes;
    std::size_t nextCapture{0};
    int calls{0}, captures{0}, cancels{0};
} sim;
MonotonicTicks monotonicTicksNow() { return sim.now; }
bool SetWaitableTimer(HANDLE, LARGE_INTEGER* due, int, void*, void*, bool) {
    if(sim.timerFailure) return false;
    sim.due=sim.now-due->QuadPart*100; sim.armed=true; return true;
}
bool CancelWaitableTimer(HANDLE) { sim.armed=false; ++sim.cancels; return true; }
bool SetEvent(HANDLE handle) {
    if(handle!=2) throw std::runtime_error("unexpected event");
    sim.resignal=true; return true;
}
int GetLastError() { return 123; }
DWORD WaitForMultipleObjects(int count, const HANDLE* handles, bool, DWORD) {
    if(++sim.calls>200) throw std::runtime_error("unbounded render wait");
    if(sim.waitFailure) return WAIT_FAILED;
    auto captureAt=sim.nextCapture<sim.captureTimes.size()
        ?sim.captureTimes[sim.nextCapture]:0;
    auto ready=[&](HANDLE handle) {
        if(handle==1) return sim.stopAt && sim.now>=sim.stopAt;
        if(handle==2) return sim.resignal || (captureAt && sim.now>=captureAt);
        if(handle==3) return sim.armed && sim.now>=sim.due;
        return sim.renderAt && sim.now>=sim.renderAt;
    };
    for(;;) {
        for(int i=0;i<count;++i) if(ready(handles[i])) {
            if(handles[i]==2) sim.resignal=false;
            if(handles[i]==4) sim.renderAt=0;
            // The handle can become signaled before this thread is actually dispatched.
            sim.now+=sim.dispatchDelay; sim.dispatchDelay=0;
            return static_cast<DWORD>(i);
        }
        MonotonicTicks next=sim.now+1000*Ms;
        for(auto time: {captureAt,sim.stopAt,sim.renderAt,sim.armed?sim.due:0})
            if(time>sim.now) next=std::min(next,time);
        sim.now=next;
    }
}
namespace WasapiPcm {
struct RecentMeasurements {
    std::vector<std::uint32_t> samples;
    void observe(std::uint32_t value) { samples.push_back(value); }
};
// Actual production target policy follows.
__TARGET_POLICY__
}
enum class WasapiMode { Shared, Exclusive };
enum class BackendEventType { DeviceLost };
struct Callback { int lost{0}; void onBackendEvent(int,BackendEventType,int) { ++lost; } };
struct Subject {
    WasapiMode mode{WasapiMode::Shared};
    bool renderImmediate{false};
    HANDLE captureDeadline{3}, stopEvent{1}, captureEvent{2}, renderEvent{4};
    struct { std::uint32_t outputPeriodFrames{480}, outputSampleRateHz{48000}; } runtime;
    struct { std::uint32_t periods{1}; } sharedQueue;
    MonotonicTicks lastRenderEventAt{Start}, renderWorkPeakNs{0};
    MonotonicTicks lastCaptureEventObservedAt{0}, lastWakeObservedAt{0};
    std::uint32_t lastRenderEventGapUs{10000};
    WasapiPcm::RecentMeasurements renderJitWaitSamples, renderJitWaitOnlySamples,
        renderJitDeadlineOvershootSamples;
    std::atomic<std::uint64_t> renderJitLateEvents{0}, renderJitDeferredCaptures{0};
    Callback observer; Callback* callback{&observer}; int generation{1};
    void processCapture() {
        if(sim.nextCapture>=sim.captureTimes.size())
            throw std::runtime_error("no PCM to capture");
        ++sim.captures; ++sim.nextCapture; sim.now+=sim.captureCost;
    }
    // Actual production wait-loop body follows.
    __WAIT_LOOP__
};
int failures=0;
void check(bool ok, const char* message) {
    std::cout<<(ok?"PASS ":"FAIL ")<<message<<"\n";
    if(!ok) ++failures;
}
int main() {
    {
        sim={}; sim.captureTimes={102*Ms,104*Ms}; Subject s;
        check(s.waitForSharedEnginePass() && sim.captures==2 && sim.now==107*Ms,
              "ordinary timely capture is served before the unchanged target");
        check(!sim.armed, "timer is cancelled after normal completion");
    }
    {
        sim={}; sim.captureTimes={106*Ms,108*Ms,110*Ms,112*Ms,114*Ms,116*Ms};
        sim.captureCost=4*Ms; Subject s; s.waitForSharedEnginePass();
        std::cout<<"overrun_exit_us="<<(sim.now-Start)/1000
                 <<" capture_batches="<<sim.captures<<"\n";
        check(sim.captures==1 && sim.now==110*Ms,
              "a capture batch crossing the target cannot start another batch");
        check(sim.nextCapture<sim.captureTimes.size(),
              "unserved capture remains available for the next outer pass");
        if(!s.renderJitWaitOnlySamples.samples.empty()) {
            check(s.renderJitWaitOnlySamples.samples.back()==6000 &&
                  s.renderJitWaitSamples.samples.back()==10000 &&
                  s.renderJitDeadlineOvershootSamples.samples.back()==3000,
                  "wait time excludes 4ms capture work; target overshoot stays visible");
        }
    }
    {
        sim={}; sim.captureTimes={107*Ms}; Subject s; s.waitForSharedEnginePass();
        check(sim.captures==0 && sim.now==107*Ms,
              "an already-ready deadline beats simultaneous capture");
    }
    {
        sim={}; sim.captureTimes={103*Ms}; sim.renderAt=103*Ms;
        Subject s; s.waitForSharedEnginePass();
        check(sim.captures==1 && sim.now==103*Ms+Ms/4 && s.renderJitLateEvents.load()==1,
              "before the target coalesced capture supplies fresh PCM before render");
    }
    {
        sim={}; sim.captureTimes={102*Ms}; sim.dispatchDelay=10*Ms;
        Subject s; s.waitForSharedEnginePass();
        check(sim.captures==0 && sim.now==112*Ms && sim.resignal,
              "late dispatch re-signals auto-reset capture and renders first");
        check(!sim.armed, "late dispatch cancels its timer");
    }
    {
        sim={}; sim.captureTimes={103*Ms}; sim.stopAt=103*Ms;
        Subject s; s.waitForSharedEnginePass();
        check(sim.captures==0 && !sim.armed, "stop wins and cancels the wait");
    }
    {
        sim={}; sim.waitFailure=true; Subject s; s.waitForSharedEnginePass();
        check(s.observer.lost==1 && !sim.armed, "wait failure reports device loss");
    }
    {
        sim={}; sim.timerFailure=true; Subject s;
        check(!s.waitForSharedEnginePass() && sim.calls==0,
              "failed timer does not delay render");
    }
    {
        sim={}; Subject s; s.sharedQueue.periods=2;
        check(!s.waitForSharedEnginePass() && sim.calls==0 && s.sharedQueue.periods==2,
              "deeper safety queue is unchanged and still renders immediately");
    }
    {
        sim={}; Subject s; s.mode=WasapiMode::Exclusive;
        check(!s.waitForSharedEnginePass() && sim.calls==0,
              "Exclusive is unchanged");
    }
    {
        sim={}; Subject s; s.renderImmediate=true;
        check(!s.waitForSharedEnginePass() && sim.calls==0,
              "existing immediate diagnostic policy is unchanged");
    }
    {
        sim={}; Subject s; s.captureDeadline=0;
        check(!s.waitForSharedEnginePass() && sim.calls==0,
              "systems without the precise timer are unchanged");
    }
    return failures==0?0:1;
}
'''


class ActualWasapiWaitLoopTests(unittest.TestCase):
    def test_deadline_and_wait_accounting(self):
        compiler = shutil.which("g++") or shutil.which("clang++")
        if compiler is None:
            self.skipTest("g++/clang++ not available; Windows backend integration is separate")
        backend = Path(os.environ.get(
            "WASAPI_TEST_BACKEND_SOURCE",
            str(ROOT / "src/backend/wasapi/WasapiBackend.cpp"),
        ))
        pcm = ROOT / "src/backend/wasapi/WasapiPcm.cpp"
        code = HARNESS.replace("__TARGET_POLICY__", function(
            pcm.read_text(encoding="utf-8"), "MonotonicTicks justInTimeRenderAt("))
        code = code.replace("__WAIT_LOOP__", function(
            backend.read_text(encoding="utf-8"), "bool waitForSharedEnginePass() noexcept"))
        with tempfile.TemporaryDirectory() as directory:
            source = Path(directory) / "actual_wait_loop.cpp"
            executable = Path(directory) / "actual_wait_loop"
            source.write_text(code, encoding="utf-8")
            built = subprocess.run(
                [compiler, "-std=c++20", "-O2", "-Wall", "-Wextra", "-Werror",
                 str(source), "-o", str(executable)], capture_output=True, text=True, timeout=45,
            )
            self.assertEqual(built.returncode, 0, built.stdout + built.stderr)
            result = subprocess.run([str(executable)], capture_output=True, text=True, timeout=10)
            print(result.stdout, end="")
            self.assertEqual(result.returncode, 0, result.stdout + result.stderr)


if __name__ == "__main__":
    unittest.main()
