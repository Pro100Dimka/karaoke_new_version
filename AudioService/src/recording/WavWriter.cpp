#include "recording/WavWriter.hpp"
#include "realtime/RealtimeInstrumentation.hpp"

#include <algorithm>
#include <array>
#include <cmath>
#include <filesystem>
#include <limits>
#include <stdexcept>

template <typename T> void writeValue(std::ostream& out, T value) {
    out.write(reinterpret_cast<const char*>(&value), sizeof(T));
}

void WavWriter::open(const std::string& path, std::uint32_t sampleRateHz, std::uint32_t channels) {
    RealtimeInstrumentation::reportDiskIo();
    close();
    if (sampleRateHz == 0 || channels == 0 ||
        channels > std::numeric_limits<std::uint16_t>::max() / 2U ||
        static_cast<std::uint64_t>(sampleRateHz) * channels * 2U >
            std::numeric_limits<std::uint32_t>::max())
        throw std::invalid_argument("invalid WAV format");
    file_.open(std::filesystem::path{std::u8string{path.begin(), path.end()}},
               std::ios::binary | std::ios::out | std::ios::trunc | std::ios::in);
    if (!file_)
        throw std::runtime_error("cannot open recording file: " + path);
    sampleRateHz_ = sampleRateHz;
    channels_ = channels;
    dataBytes_ = 0;
    writeHeader(0);
    if (!file_) {
        abandon();
        throw std::runtime_error("recording header write failed");
    }
}
void WavWriter::write(std::span<const float> samples) {
    RealtimeInstrumentation::reportDiskIo();
    if (!file_.is_open() || !file_)
        throw std::runtime_error("recording writer is closed");
    if (samples.size() % channels_ != 0)
        throw std::invalid_argument("recording block contains a partial frame");
    constexpr auto maximumDataBytes = std::numeric_limits<std::uint32_t>::max() - 36ULL;
    if (dataBytes_ > maximumDataBytes ||
        samples.size() > (maximumDataBytes - dataBytes_) / sizeof(std::int16_t))
        throw std::length_error("recording exceeds the RIFF WAV size limit");
    std::array<std::int16_t, 8192> converted{};
    std::size_t offset = 0;
    while (offset < samples.size()) {
        const auto count = std::min(converted.size(), samples.size() - offset);
        for (std::size_t i = 0; i < count; ++i) {
            const auto sample = samples[offset + i];
            const auto clamped = std::isfinite(sample) ? std::clamp(sample, -1.0F, 1.0F) : 0.0F;
            converted[i] = static_cast<std::int16_t>(std::lrint(clamped * 32767.0F));
        }
        file_.write(reinterpret_cast<const char*>(converted.data()),
                    static_cast<std::streamsize>(count * sizeof(std::int16_t)));
        if (!file_)
            throw std::runtime_error("recording write failed");
        dataBytes_ += count * sizeof(std::int16_t);
        offset += count;
    }
}
void WavWriter::writeHeader(std::uint32_t dataBytes) {
    RealtimeInstrumentation::reportDiskIo();
    file_.seekp(0, std::ios::beg);
    file_.write("RIFF", 4);
    writeValue(file_, 36U + dataBytes);
    file_.write("WAVE", 4);
    file_.write("fmt ", 4);
    writeValue(file_, 16U);
    writeValue<std::uint16_t>(file_, 1U);
    writeValue<std::uint16_t>(file_, static_cast<std::uint16_t>(channels_));
    writeValue(file_, sampleRateHz_);
    const auto byteRate = sampleRateHz_ * channels_ * 2U;
    writeValue(file_, byteRate);
    writeValue<std::uint16_t>(file_, static_cast<std::uint16_t>(channels_ * 2U));
    writeValue<std::uint16_t>(file_, 16U);
    file_.write("data", 4);
    writeValue(file_, dataBytes);
}
void WavWriter::close(float gain) {
    RealtimeInstrumentation::reportDiskIo();
    if (!file_.is_open())
        return;
    if (!std::isfinite(gain) || gain < 0.0F || gain > 1.0F)
        throw std::invalid_argument("invalid recording attenuation");
    // Finalization runs on the disk worker, after its PCM queue is drained. It needs no
    // second song scan, DSP pass, or realtime work; channels share the same constant gain.
    if (gain < 1.0F) {
        std::array<std::int16_t, 8192> samples{};
        for (std::uint64_t offset = 0; offset < dataBytes_;) {
            const auto bytes = std::min<std::uint64_t>(samples.size() * sizeof(samples[0]), dataBytes_ - offset);
            const auto position = static_cast<std::streamoff>(44U + offset);
            file_.seekg(position);
            file_.read(reinterpret_cast<char*>(samples.data()), static_cast<std::streamsize>(bytes));
            if (!file_)
                throw std::runtime_error("recording headroom read failed");
            for (std::size_t index = 0; index < bytes / sizeof(samples[0]); ++index)
                samples[index] = static_cast<std::int16_t>(std::lrint(samples[index] * gain));
            file_.seekp(position);
            file_.write(reinterpret_cast<const char*>(samples.data()), static_cast<std::streamsize>(bytes));
            if (!file_)
                throw std::runtime_error("recording headroom write failed");
            offset += bytes;
        }
    }
    writeHeader(static_cast<std::uint32_t>(dataBytes_));
    file_.flush();
    const auto written = static_cast<bool>(file_);
    file_.close();
    if (!written || file_.fail())
        throw std::runtime_error("recording finalization failed");
}

void WavWriter::abandon() noexcept {
    RealtimeInstrumentation::reportDiskIo();
    if (!file_.is_open())
        return;
    file_.close();
    sampleRateHz_ = 0;
    channels_ = 0;
    dataBytes_ = 0;
}
