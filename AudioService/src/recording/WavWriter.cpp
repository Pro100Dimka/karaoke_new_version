#include "recording/WavWriter.hpp"
#include "realtime/RealtimeInstrumentation.hpp"

#include <algorithm>
#include <array>
#include <cmath>
#include <stdexcept>

template <typename T> void writeValue(std::ostream& out, T value) {
    out.write(reinterpret_cast<const char*>(&value), sizeof(T));
}

void WavWriter::open(const std::string& path, std::uint32_t sampleRateHz, std::uint32_t channels) {
    RealtimeInstrumentation::reportDiskIo();
    close();
    if (sampleRateHz == 0 || channels == 0)
        throw std::invalid_argument("invalid WAV format");
    file_.open(path, std::ios::binary | std::ios::out | std::ios::trunc | std::ios::in);
    if (!file_)
        throw std::runtime_error("cannot open recording file: " + path);
    sampleRateHz_ = sampleRateHz;
    channels_ = channels;
    dataBytes_ = 0;
    writeHeader(0);
}
void WavWriter::write(std::span<const float> samples) {
    RealtimeInstrumentation::reportDiskIo();
    if (!file_)
        throw std::runtime_error("recording writer is closed");
    std::array<std::int16_t, 8192> converted{};
    std::size_t offset = 0;
    while (offset < samples.size()) {
        const auto count = std::min(converted.size(), samples.size() - offset);
        for (std::size_t i = 0; i < count; ++i) {
            const auto clamped = std::clamp(samples[offset + i], -1.0F, 1.0F);
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
void WavWriter::close() {
    RealtimeInstrumentation::reportDiskIo();
    if (!file_.is_open())
        return;
    const auto bytes =
        static_cast<std::uint32_t>(std::min<std::uint64_t>(dataBytes_, 0xFFFFFFFFULL));
    writeHeader(bytes);
    file_.flush();
    file_.close();
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
