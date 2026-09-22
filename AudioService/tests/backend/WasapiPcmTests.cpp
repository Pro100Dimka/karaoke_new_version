#include "TestHarness.hpp"

#ifdef _WIN32
#include "backend/wasapi/WasapiPcm.hpp"
#include "backend/wasapi/WasapiBackend.hpp"

#include <array>
#include <cmath>
#include <cstring>
#include <mmreg.h>

void Tests::wasapiExclusiveAppliesListeningLevelCompensation() {
    WAVEFORMATEX format{};
    format.wFormatTag = WAVE_FORMAT_IEEE_FLOAT;
    format.nChannels = 1;
    format.nSamplesPerSec = 48000;
    format.wBitsPerSample = 32;
    format.nBlockAlign = 4;
    format.nAvgBytesPerSec = format.nSamplesPerSec * format.nBlockAlign;
    const std::array input{0.25F};
    std::array<BYTE, sizeof(float)> sharedBytes{}, exclusiveBytes{};

    WasapiPcm::fromFloat(input.data(), sharedBytes.data(), 1, &format, 1.0F);
    WasapiPcm::fromFloat(input.data(), exclusiveBytes.data(), 1, &format,
                         WasapiPcm::ExclusiveListeningLevelCompensation);

    float shared{}, exclusive{};
    std::memcpy(&shared, sharedBytes.data(), sizeof(float));
    std::memcpy(&exclusive, exclusiveBytes.data(), sizeof(float));
    Tests::expect(std::abs(shared - 0.25F) < 0.0001F, "shared WASAPI must retain unity output");
    Tests::expect(exclusive > shared * 1.4F && exclusive < shared * 1.43F,
                  "exclusive WASAPI should compensate its lower direct-path listening level");
}

void Tests::wasapiExclusiveKeepsMicrophoneCaptureShareable() {
    Tests::expect(WasapiBackend::captureModeFor(WasapiMode::Exclusive) == WasapiMode::Shared,
                  "exclusive listening must not take exclusive ownership of the room microphone");
}
#else
void Tests::wasapiExclusiveAppliesListeningLevelCompensation() {}
void Tests::wasapiExclusiveKeepsMicrophoneCaptureShareable() {}
#endif
