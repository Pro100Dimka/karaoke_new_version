#include "media/WavDecoder.hpp"
#include "realtime/RealtimeInstrumentation.hpp"

#include <algorithm>
#include <array>
#include <cstring>
#include <stdexcept>

template <typename T> T readValue(std::istream& stream) {
    T value{};
    stream.read(reinterpret_cast<char*>(&value), sizeof(T));
    if (!stream)
        throw std::runtime_error("Unexpected end of WAV file");
    return value;
}

DecodedAudioFormat WavDecoder::open(const std::string& path) {
    RealtimeInstrumentation::reportDiskIo();
    close();
    file_.open(path, std::ios::binary);
    if (!file_)
        throw std::runtime_error("Cannot open WAV file: " + path);
    std::array<char, 4> id{};
    file_.read(id.data(), 4);
    if (std::string_view{id.data(), 4} != "RIFF")
        throw std::runtime_error("Not a RIFF WAV file");
    (void)readValue<std::uint32_t>(file_);
    file_.read(id.data(), 4);
    if (std::string_view{id.data(), 4} != "WAVE")
        throw std::runtime_error("Not a WAVE file");

    bool haveFormat = false;
    bool haveData = false;
    std::uint32_t sampleRate = 0;
    std::uint16_t channels = 0;
    while (file_ && !haveData) {
        file_.read(id.data(), 4);
        if (!file_)
            break;
        const auto size = readValue<std::uint32_t>(file_);
        if (std::string_view{id.data(), 4} == "fmt ") {
            formatTag_ = readValue<std::uint16_t>(file_);
            channels = readValue<std::uint16_t>(file_);
            sampleRate = readValue<std::uint32_t>(file_);
            (void)readValue<std::uint32_t>(file_);
            blockAlign_ = readValue<std::uint16_t>(file_);
            bitsPerSample_ = readValue<std::uint16_t>(file_);
            const auto consumed = 16U;
            if (size > consumed)
                file_.seekg(static_cast<std::streamoff>(size - consumed), std::ios::cur);
            haveFormat = true;
        } else if (std::string_view{id.data(), 4} == "data") {
            dataOffset_ = static_cast<std::uint64_t>(file_.tellg());
            dataBytes_ = size;
            file_.seekg(static_cast<std::streamoff>(size), std::ios::cur);
            haveData = true;
        } else {
            file_.seekg(static_cast<std::streamoff>(size), std::ios::cur);
        }
        if ((size & 1U) != 0U)
            file_.seekg(1, std::ios::cur);
    }
    if (!haveFormat || !haveData || channels == 0 || sampleRate == 0 || blockAlign_ == 0)
        throw std::runtime_error("Incomplete WAV file");
    if (!((formatTag_ == 1 &&
           (bitsPerSample_ == 16 || bitsPerSample_ == 24 || bitsPerSample_ == 32)) ||
          (formatTag_ == 3 && bitsPerSample_ == 32)))
        throw std::runtime_error("Unsupported WAV encoding");
    format_ = {sampleRate, channels, dataBytes_ / blockAlign_};
    file_.clear();
    file_.seekg(static_cast<std::streamoff>(dataOffset_), std::ios::beg);
    return format_;
}

std::uint32_t WavDecoder::read(std::span<float> output, std::uint32_t maxFrames) {
    RealtimeInstrumentation::reportDiskIo();
    if (!file_ || format_.channels == 0)
        return 0;
    const auto maxSamples = static_cast<std::size_t>(maxFrames) * format_.channels;
    if (output.size() < maxSamples)
        maxFrames = static_cast<std::uint32_t>(output.size() / format_.channels);
    const auto bytes = static_cast<std::size_t>(maxFrames) * blockAlign_;
    raw_.resize(bytes);
    file_.read(reinterpret_cast<char*>(raw_.data()), static_cast<std::streamsize>(bytes));
    const auto bytesRead = static_cast<std::size_t>(file_.gcount());
    const auto frames = static_cast<std::uint32_t>(bytesRead / blockAlign_);
    const auto samples = static_cast<std::size_t>(frames) * format_.channels;
    const auto* data = reinterpret_cast<const unsigned char*>(raw_.data());
    if (formatTag_ == 3) {
        for (std::size_t i = 0; i < samples; ++i) {
            float value{};
            std::memcpy(&value, data + i * 4U, 4U);
            output[i] = value;
        }
    } else if (bitsPerSample_ == 16) {
        for (std::size_t i = 0; i < samples; ++i) {
            std::int16_t value{};
            std::memcpy(&value, data + i * 2U, 2U);
            output[i] = static_cast<float>(value) / 32768.0F;
        }
    } else if (bitsPerSample_ == 24) {
        for (std::size_t i = 0; i < samples; ++i) {
            const auto offset = i * 3U;
            std::int32_t value = static_cast<std::int32_t>(data[offset]) |
                                 (static_cast<std::int32_t>(data[offset + 1U]) << 8) |
                                 (static_cast<std::int32_t>(data[offset + 2U]) << 16);
            if ((value & 0x00800000) != 0)
                value |= static_cast<std::int32_t>(0xFF000000U);
            output[i] = static_cast<float>(value) / 8388608.0F;
        }
    } else {
        for (std::size_t i = 0; i < samples; ++i) {
            std::int32_t value{};
            std::memcpy(&value, data + i * 4U, 4U);
            output[i] = static_cast<float>(static_cast<double>(value) / 2147483648.0);
        }
    }
    return frames;
}

void WavDecoder::seek(std::uint64_t frame) {
    RealtimeInstrumentation::reportDiskIo();
    if (!file_)
        return;
    const auto clamped = std::min(frame, format_.totalFrames);
    file_.clear();
    file_.seekg(static_cast<std::streamoff>(dataOffset_ + clamped * blockAlign_), std::ios::beg);
}

void WavDecoder::cancel() noexcept {}

void WavDecoder::close() noexcept {
    RealtimeInstrumentation::reportDiskIo();
    if (file_.is_open())
        file_.close();
    format_ = {};
    raw_.clear();
}
