#ifdef _WIN32
#include "backend/wasapi/WasapiPcm.hpp"

#include <ksmedia.h>

#include <algorithm>
#include <cmath>
#include <cstring>

namespace WasapiPcm {
bool eventCallbackMissedDeadline(std::chrono::steady_clock::time_point waitStarted,
                                 std::chrono::steady_clock::time_point eventReady,
                                 std::chrono::steady_clock::time_point completed,
                                 std::chrono::steady_clock::duration period) noexcept {
    (void)waitStarted;
    return completed - eventReady > period;
}

std::vector<std::byte> copyWithSampleRate(const WAVEFORMATEX* format,
                                          std::uint32_t sampleRateHz) {
    if (format == nullptr || sampleRateHz == 0)
        return {};
    const auto bytes = sizeof(WAVEFORMATEX) + static_cast<std::size_t>(format->cbSize);
    std::vector<std::byte> result(bytes);
    std::memcpy(result.data(), format, bytes);
    auto* copy = reinterpret_cast<WAVEFORMATEX*>(result.data());
    copy->nSamplesPerSec = sampleRateHz;
    copy->nAvgBytesPerSec = sampleRateHz * copy->nBlockAlign;
    return result;
}

AudioSampleFormat sampleFormat(const WAVEFORMATEX* format) noexcept {
    if (format == nullptr || format->nChannels == 0 || format->nSamplesPerSec == 0 ||
        format->wBitsPerSample == 0 || format->wBitsPerSample % 8 != 0 ||
        format->nBlockAlign != format->nChannels * (format->wBitsPerSample / 8))
        return AudioSampleFormat::Unknown;
    WORD tag = format->wFormatTag;
    if (tag == WAVE_FORMAT_EXTENSIBLE) {
        if (format->cbSize < sizeof(WAVEFORMATEXTENSIBLE) - sizeof(WAVEFORMATEX))
            return AudioSampleFormat::Unknown;
        const auto* ext = reinterpret_cast<const WAVEFORMATEXTENSIBLE*>(format);
        if (ext->SubFormat == KSDATAFORMAT_SUBTYPE_IEEE_FLOAT)
            tag = WAVE_FORMAT_IEEE_FLOAT;
        if (ext->SubFormat == KSDATAFORMAT_SUBTYPE_PCM)
            tag = WAVE_FORMAT_PCM;
    }
    if (tag == WAVE_FORMAT_IEEE_FLOAT && format->wBitsPerSample == 32)
        return AudioSampleFormat::Float32;
    if (tag == WAVE_FORMAT_PCM) {
        if (format->wBitsPerSample == 16)
            return AudioSampleFormat::Int16;
        if (format->wBitsPerSample == 24)
            return AudioSampleFormat::Int24;
        if (format->wBitsPerSample == 32)
            return AudioSampleFormat::Int32;
    }
    return AudioSampleFormat::Unknown;
}
void toFloat(const BYTE* input, float* output, std::uint32_t frames, const WAVEFORMATEX* format,
             bool silent) noexcept {
    const auto channels = format->nChannels;
    const auto samples = static_cast<std::size_t>(frames) * channels;
    if (silent) {
        std::fill_n(output, samples, 0.0F);
        return;
    }
    const auto type = sampleFormat(format);
    if (type == AudioSampleFormat::Float32) {
        std::memcpy(output, input, samples * sizeof(float));
        return;
    }
    if (type == AudioSampleFormat::Int16) {
        for (std::size_t i = 0; i < samples; ++i) {
            std::int16_t v{};
            std::memcpy(&v, input + i * 2U, 2U);
            output[i] = static_cast<float>(v) / 32768.0F;
        }
        return;
    }
    if (type == AudioSampleFormat::Int24) {
        for (std::size_t i = 0; i < samples; ++i) {
            const auto o = i * 3U;
            std::int32_t v = static_cast<std::int32_t>(input[o]) |
                             (static_cast<std::int32_t>(input[o + 1U]) << 8) |
                             (static_cast<std::int32_t>(input[o + 2U]) << 16);
            if ((v & 0x00800000) != 0)
                v |= static_cast<std::int32_t>(0xFF000000U);
            output[i] = static_cast<float>(v) / 8388608.0F;
        }
        return;
    }
    if (type == AudioSampleFormat::Int32) {
        for (std::size_t i = 0; i < samples; ++i) {
            std::int32_t v{};
            std::memcpy(&v, input + i * 4U, 4U);
            output[i] = static_cast<float>(static_cast<double>(v) / 2147483648.0);
        }
        return;
    }
    std::fill_n(output, samples, 0.0F);
}
void fromFloat(const float* input, BYTE* output, std::uint32_t frames,
               const WAVEFORMATEX* format) noexcept {
    const auto channels = format->nChannels;
    const auto samples = static_cast<std::size_t>(frames) * channels;
    const auto type = sampleFormat(format);
    if (type == AudioSampleFormat::Float32) {
        std::memcpy(output, input, samples * sizeof(float));
        return;
    }
    if (type == AudioSampleFormat::Int16) {
        for (std::size_t i = 0; i < samples; ++i) {
            const auto x = std::clamp(input[i], -1.0F, 1.0F);
            const auto v = static_cast<std::int16_t>(std::lrint(x * 32767.0F));
            std::memcpy(output + i * 2U, &v, 2U);
        }
        return;
    }
    if (type == AudioSampleFormat::Int24) {
        for (std::size_t i = 0; i < samples; ++i) {
            const auto x = std::clamp(input[i], -1.0F, 1.0F);
            const auto v = static_cast<std::int32_t>(std::lrint(x * 8388607.0F));
            const auto o = i * 3U;
            output[o] = static_cast<BYTE>(v & 0xff);
            output[o + 1U] = static_cast<BYTE>((v >> 8) & 0xff);
            output[o + 2U] = static_cast<BYTE>((v >> 16) & 0xff);
        }
        return;
    }
    if (type == AudioSampleFormat::Int32) {
        for (std::size_t i = 0; i < samples; ++i) {
            const auto x = std::clamp(static_cast<double>(input[i]), -1.0, 1.0);
            const auto v = static_cast<std::int32_t>(std::llround(x * 2147483647.0));
            std::memcpy(output + i * 4U, &v, 4U);
        }
        return;
    }
    std::memset(output, 0, static_cast<std::size_t>(frames) * format->nBlockAlign);
}

} // namespace WasapiPcm
#endif
