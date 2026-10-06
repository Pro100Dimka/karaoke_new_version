#include "TestHarness.hpp"
#ifdef _WIN32
#include "backend/wasapi/SystemVolumeFollower.hpp"
#endif

#ifdef _WIN32
#include "backend/wasapi/WasapiBackend.hpp"
#include "backend/wasapi/WasapiPcm.hpp"

#include <array>
#include <chrono>
#include <cmath>
#include <cstring>
#include <mmreg.h>

void Tests::wasapiConversionPreservesOutputLevel() {
    WAVEFORMATEX format{};
    format.wFormatTag = WAVE_FORMAT_IEEE_FLOAT;
    format.nChannels = 1;
    format.nSamplesPerSec = 48000;
    format.wBitsPerSample = 32;
    format.nBlockAlign = 4;
    format.nAvgBytesPerSec = format.nSamplesPerSec * format.nBlockAlign;
    const std::array input{0.9F};
    std::array<BYTE, sizeof(float)> sharedBytes{}, exclusiveBytes{};

    WasapiPcm::fromFloat(input.data(), sharedBytes.data(), 1, &format);
    WasapiPcm::fromFloat(input.data(), exclusiveBytes.data(), 1, &format);

    float shared{}, exclusive{};
    std::memcpy(&shared, sharedBytes.data(), sizeof(float));
    std::memcpy(&exclusive, exclusiveBytes.data(), sizeof(float));
    Tests::expect(std::abs(shared - 0.9F) < 0.0001F, "shared WASAPI must retain unity output");
    Tests::expect(
        std::abs(exclusive - shared) < 0.0001F,
        "Device mode must not add guessed gain or clip an otherwise unclipped master mix");
}

void Tests::wasapiRejectsInvalidSampleLayouts() {
    WAVEFORMATEXTENSIBLE format{};
    format.Format.wFormatTag = WAVE_FORMAT_EXTENSIBLE;
    format.Format.nChannels = 2;
    format.Format.nSamplesPerSec = 48000;
    format.Format.cbSize = sizeof(WAVEFORMATEXTENSIBLE) - sizeof(WAVEFORMATEX);
    format.SubFormat = KSDATAFORMAT_SUBTYPE_IEEE_FLOAT;
    format.Format.wBitsPerSample = 64;
    format.Format.nBlockAlign = 16;
    expect(WasapiPcm::sampleFormat(&format.Format) == AudioSampleFormat::Unknown,
           "Float64 must not be decoded as Float32");
    format.Format.wBitsPerSample = 32;
    format.Format.nBlockAlign = 4;
    expect(WasapiPcm::sampleFormat(&format.Format) == AudioSampleFormat::Unknown,
           "PCM layout must account for every channel before copying samples");
}

void Tests::wasapiExclusivePreservesSystemNativePcmFormat() {
    WAVEFORMATEXTENSIBLE native{};
    native.Format.wFormatTag = WAVE_FORMAT_EXTENSIBLE;
    native.Format.nChannels = 6;
    native.Format.nSamplesPerSec = 96'000;
    native.Format.wBitsPerSample = 24;
    native.Format.nBlockAlign = 18;
    native.Format.nAvgBytesPerSec = native.Format.nSamplesPerSec * native.Format.nBlockAlign;
    native.Format.cbSize = sizeof(WAVEFORMATEXTENSIBLE) - sizeof(WAVEFORMATEX);
    native.Samples.wValidBitsPerSample = 24;
    native.dwChannelMask = 0x3FU;
    native.SubFormat = KSDATAFORMAT_SUBTYPE_PCM;

    const auto copy = WasapiPcm::copyWithSampleRate(&native.Format, 48'000);
    const auto* extended = reinterpret_cast<const WAVEFORMATEXTENSIBLE*>(copy.data());
    Tests::expect(
        extended->Format.nSamplesPerSec == 48'000 && extended->Format.nChannels == 6 &&
            extended->Format.wBitsPerSample == 24 && extended->Samples.wValidBitsPerSample == 24 &&
            extended->dwChannelMask == 0x3FU && extended->SubFormat == KSDATAFORMAT_SUBTYPE_PCM,
        "exclusive WASAPI changes only the requested rate and keeps the system native PCM layout");
}

void Tests::wasapiDeadlineMetricExcludesEventWaitTime() {
    using namespace std::chrono_literals;
    const std::chrono::steady_clock::time_point start{};
    expect(!WasapiPcm::eventCallbackMissedDeadline(start, start + 10ms, start + 14ms, 10ms) &&
               WasapiPcm::eventCallbackMissedDeadline(start, start + 10ms, start + 21ms, 10ms),
           "WASAPI deadline diagnostics measure callback work after the event, not the event wait");
}

void Tests::wasapiRenderClockIgnoresSilenceAStarvedDeviceNeverCounted() {
    constexpr std::uint32_t buffer = 240, streamLatency = 240;
    expect(WasapiPcm::rebasedRenderSubmission(10'480, 10'000, 0, buffer, streamLatency) == 10'480,
           "a normally filled stream keeps its submitted count");
    // After glitches the device position lags everything submitted by far more than it can hold.
    expect(WasapiPcm::rebasedRenderSubmission(710'000, 10'000, 0, buffer, streamLatency) ==
               10'000 + buffer,
           "uncounted silence is dropped: the queue is one buffer ahead of the device again");
    expect(WasapiPcm::rebasedRenderSubmission(10'960, 10'000, 480, buffer, streamLatency) == 10'960,
           "shared-mode padding counts as queued audio, not as uncounted silence");
}

void Tests::bypassingOutputsFollowTheWindowsVolume() {
    expect(std::abs(SystemVolumeFollower::gainFor(-6.0F, false) - 0.501F) < 0.001F,
           "an output bypassing Windows is attenuated by the Windows volume in decibels");
    expect(SystemVolumeFollower::gainFor(-6.0F, true) == 0.0F, "a muted Windows output is silent");
    expect(SystemVolumeFollower::gainFor(0.0F, false) == 1.0F &&
               SystemVolumeFollower::gainFor(3.0F, false) == 1.0F,
           "the Windows volume never makes this app louder than full scale");
}

void Tests::wasapiSharedQueueGrowsOnlyWhileTheEngineStarves() {
    // One second of a 441-frame engine; the endpoint buffer holds two periods.
    constexpr std::uint32_t period = 441, maximum = 2;
    expect(WasapiPcm::sharedQueuePeriods(1, maximum, 44'100, 44'100, period) == 1,
           "an engine that played everything keeps the one-period queue");
    expect(WasapiPcm::sharedQueuePeriods(1, maximum, 44'100, 44'100 - period / 2, period) == 1,
           "clock rounding under one period is not starvation");
    expect(WasapiPcm::sharedQueuePeriods(1, maximum, 44'100, 35'000, period) == 2,
           "an engine that played a fifth of the time as silence gets one more queued period");
    expect(WasapiPcm::sharedQueuePeriods(2, maximum, 44'100, 35'000, period) == 2,
           "the queue never exceeds the endpoint buffer");
    expect(WasapiPcm::sharedQueuePeriods(2, maximum, 44'100, 44'100, period, true) == 1,
           "sustained silence allows a recovered engine to shed a temporary queued period");
    expect(WasapiPcm::sharedQueuePeriods(2, maximum, 44'100, 35'000, period, true) == 2,
           "silence cannot shrink a queue while the engine still starves");
    expect(WasapiPcm::sharedQueuePeriods(2, maximum, 44'100, 44'100, period) == 2,
           "audible playback does not probe a shallower queue");
}

void Tests::wasapiRecentMeasurementsExposePercentilesAndReset() {
    WasapiPcm::RecentMeasurements samples;
    for (std::uint32_t value = 1; value <= 100; ++value)
        samples.observe(value);
    const auto observed = samples.snapshot();
    expect(observed.count == 100 && observed.p50 == 50 && observed.p95 == 95 &&
               observed.p99 == 99 && observed.maximum == 100,
           "recent WASAPI measurements expose exact nearest-rank quantiles");
    samples.reset();
    expect(samples.snapshot().count == 0,
           "old endpoint timing measurements do not contaminate a new session");
}
#else
void Tests::bypassingOutputsFollowTheWindowsVolume() {}
void Tests::wasapiSharedQueueGrowsOnlyWhileTheEngineStarves() {}
void Tests::wasapiRecentMeasurementsExposePercentilesAndReset() {}
void Tests::wasapiRenderClockIgnoresSilenceAStarvedDeviceNeverCounted() {}
void Tests::wasapiConversionPreservesOutputLevel() {}
void Tests::wasapiRejectsInvalidSampleLayouts() {}
void Tests::wasapiExclusivePreservesSystemNativePcmFormat() {}
void Tests::wasapiDeadlineMetricExcludesEventWaitTime() {}
#endif
