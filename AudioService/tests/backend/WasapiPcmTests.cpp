#include "TestHarness.hpp"

#ifdef _WIN32
#include "backend/wasapi/WasapiPcm.hpp"
#include "backend/wasapi/WasapiBackend.hpp"

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
    Tests::expect(std::abs(exclusive - shared) < 0.0001F,
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

void Tests::wasapiExclusiveKeepsMicrophoneCaptureShareable() {
    Tests::expect(WasapiBackend::captureModeFor(WasapiMode::Exclusive) == WasapiMode::Shared,
                  "exclusive listening must not take exclusive ownership of the room microphone");
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
    Tests::expect(extended->Format.nSamplesPerSec == 48'000 &&
                      extended->Format.nChannels == 6 &&
                      extended->Format.wBitsPerSample == 24 &&
                      extended->Samples.wValidBitsPerSample == 24 &&
                      extended->dwChannelMask == 0x3FU &&
                      extended->SubFormat == KSDATAFORMAT_SUBTYPE_PCM,
                  "exclusive WASAPI changes only the requested rate and keeps the system native PCM layout");
}

void Tests::wasapiDeadlineMetricExcludesEventWaitTime() {
    using namespace std::chrono_literals;
    const std::chrono::steady_clock::time_point start{};
    expect(!WasapiPcm::eventCallbackMissedDeadline(start, start + 10ms, start + 14ms, 10ms) &&
               WasapiPcm::eventCallbackMissedDeadline(start, start + 10ms, start + 21ms, 10ms),
           "WASAPI deadline diagnostics measure callback work after the event, not the event wait");
}
#else
void Tests::wasapiConversionPreservesOutputLevel() {}
void Tests::wasapiRejectsInvalidSampleLayouts() {}
void Tests::wasapiExclusiveKeepsMicrophoneCaptureShareable() {}
void Tests::wasapiExclusivePreservesSystemNativePcmFormat() {}
void Tests::wasapiDeadlineMetricExcludesEventWaitTime() {}
#endif
