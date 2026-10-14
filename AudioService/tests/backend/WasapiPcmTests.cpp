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
#include <endpointvolume.h>
#include <mmreg.h>

void Tests::wasapiPeriodChoicesUseFundamentalMultiplesAboveMinimum() {
    const auto periods = WasapiPcm::sharedPeriodChoices(130, 225, 32);
    expect(periods == std::vector<std::uint32_t>{160, 192, 224},
           "IAudioClient3 periods are absolute fundamental multiples within minimum/maximum");
}

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

void Tests::wasapiSharedRenderWritesJustBeforeTheEnginePass() {
    constexpr MonotonicTicks Ms = 1'000'000;
    constexpr MonotonicTicks Event = 1'000 * Ms;
    // A steady 10 ms engine and 0.5 ms of render work: write 3.5 ms before the next pass.
    expect(WasapiPcm::justInTimeRenderAt(Event, Event + Ms / 10, 10 * Ms, 10'000, 1, Ms / 2) ==
               Event + 10 * Ms - 3 * Ms - Ms / 2,
           "a freed period is written shortly before the engine takes it, not a period early");
    expect(WasapiPcm::justInTimeRenderAt(Event, Event + 8 * Ms, 10 * Ms, 10'000, 1, Ms / 2) == 0,
           "past the target the period is written at once");
    expect(WasapiPcm::justInTimeRenderAt(Event, Event + Ms / 2, 10 * Ms, 10'000, 1, 20 * Ms) ==
               Event + Ms,
           "slow render work never squeezes the write closer than a millisecond to the pass");
    expect(WasapiPcm::justInTimeRenderAt(Event, Event, 10 * Ms, 10'000, 2, 0) == 0,
           "a queue deepened after starvation keeps writing at once");
    expect(WasapiPcm::justInTimeRenderAt(Event, Event, 10 * Ms, 16'000, 1, 0) == 0 &&
               WasapiPcm::justInTimeRenderAt(0, Event, 10 * Ms, 10'000, 1, 0) == 0,
           "without steady engine events there is no pass to predict");
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
    // A device with its own volume control (most USB headsets) already applies it to every stream.
    expect(SystemVolumeFollower::gainFor(-6.0F, false, ENDPOINT_HARDWARE_SUPPORT_VOLUME) == 1.0F,
           "a volume the device applies itself is not applied twice in Exclusive mode");
    expect(SystemVolumeFollower::gainFor(-6.0F, true, ENDPOINT_HARDWARE_SUPPORT_VOLUME) == 0.0F,
           "a software mute still silences a device with hardware volume");
    expect(SystemVolumeFollower::gainFor(-6.0F, true,
                                         ENDPOINT_HARDWARE_SUPPORT_VOLUME |
                                             ENDPOINT_HARDWARE_SUPPORT_MUTE) == 1.0F,
           "a mute the device applies itself is left to the device");
}

void Tests::wasapiSharedQueueRequiresDirectEvidence() {
    using namespace WasapiPcm;
    SharedQueueState state{};
    SharedQueueEvidence event{128, 256, 48'000, 0, 2'700, true, 0, 260, false};
    expect(updateSharedQueue(state, event).periods == 1,
           "QPC/device-clock pressure and empty padding at an on-time wake do not add latency");
    event.timingPressureFrames = 1;
    expect(updateSharedQueue(state, event).periods == 1,
           "one-frame clock quantization does not add latency");
    event.renderEventGapUs = 4'100;
    expect(updateSharedQueue(state, event).periods == 1 &&
               updateSharedQueue(state, event).periods == 1,
           "one or two late empty render events are not a confirmed underrun");
    const auto sustained = updateSharedQueue(state, event);
    expect(sustained.periods == 2 && sustained.reason == SharedQueueReason::RepeatedLateEmpty,
           "repeated late empty render events raise the safety queue");
    expect(updateSharedQueue(state, event).periods == 2,
           "the queue cannot exceed the endpoint buffer");
    event = {128, 256, 48'000, 128, 2'700, true, 0, 0, true};
    expect(updateSharedQueue(state, event).periods == 1,
           "ten seconds of silence can safely restore a one-period target");
    event = {128, 256, 48'000, 0, 2'700, true, 32, 0, false};
    const auto underrun = updateSharedQueue(state, event);
    expect(underrun.periods == 2 && underrun.reason == SharedQueueReason::ConfirmedUnderrun,
           "device clock advancing past submitted frames raises the queue immediately");
    expect(timingPressureFrames(12'800, 128, 48'000) == 0 &&
               timingPressureFrames(12'801, 128, 48'000) == 0,
           "QPC rounding around one period is not timing pressure");
    expect(timingPressureFrames(20'000, 64, 48'000) > 0,
           "a real QPC/device-clock divergence remains visible as timing pressure");
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
void Tests::wasapiPeriodChoicesUseFundamentalMultiplesAboveMinimum() {}
void Tests::bypassingOutputsFollowTheWindowsVolume() {}
void Tests::wasapiSharedQueueRequiresDirectEvidence() {}
void Tests::wasapiRecentMeasurementsExposePercentilesAndReset() {}
void Tests::wasapiRenderClockIgnoresSilenceAStarvedDeviceNeverCounted() {}
void Tests::wasapiConversionPreservesOutputLevel() {}
void Tests::wasapiRejectsInvalidSampleLayouts() {}
void Tests::wasapiExclusivePreservesSystemNativePcmFormat() {}
void Tests::wasapiDeadlineMetricExcludesEventWaitTime() {}
void Tests::wasapiSharedRenderWritesJustBeforeTheEnginePass() {}
#endif
