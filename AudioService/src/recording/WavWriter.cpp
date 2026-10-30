#include "recording/WavWriter.hpp"
#include "realtime/RealtimeInstrumentation.hpp"

#include <algorithm>
#include <array>
#include <cmath>
#include <filesystem>
#include <limits>
#include <stdexcept>
#include <vector>
#ifdef _WIN32
#include <Windows.h>
#endif

template <typename T> void writeValue(std::ostream& out, T value) {
    out.write(reinterpret_cast<const char*>(&value), sizeof(T));
}

void WavWriter::open(const std::string& path, std::uint32_t sampleRateHz, std::uint32_t channels,
                     bool floatingCapture) {
    RealtimeInstrumentation::reportDiskIo();
    close();
    const auto sampleBytes = floatingCapture ? 4U : 2U;
    if (sampleRateHz == 0 || channels == 0 ||
        channels > std::numeric_limits<std::uint16_t>::max() / sampleBytes ||
        static_cast<std::uint64_t>(sampleRateHz) * channels * sampleBytes >
            std::numeric_limits<std::uint32_t>::max())
        throw std::invalid_argument("invalid WAV format");
    file_.open(std::filesystem::path{std::u8string{path.begin(), path.end()}},
               std::ios::binary | std::ios::out | std::ios::trunc | std::ios::in);
    if (!file_)
        throw std::runtime_error("cannot open recording file: " + path);
    sampleRateHz_ = sampleRateHz;
    channels_ = channels;
    dataBytes_ = 0;
    filePath_ = path;
    floatingCapture_ = floatingCapture;
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
    const auto sampleBytes = floatingCapture_ ? sizeof(float) : sizeof(std::int16_t);
    if (dataBytes_ > maximumDataBytes ||
        samples.size() > (maximumDataBytes - dataBytes_) / sampleBytes)
        throw std::length_error("recording exceeds the RIFF WAV size limit");
    if (floatingCapture_) {
        const auto bytes = samples.size_bytes();
        file_.write(reinterpret_cast<const char*>(samples.data()), static_cast<std::streamsize>(bytes));
        if (!file_)
            throw std::runtime_error("recording write failed");
        dataBytes_ += bytes;
        return;
    }
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
    const auto sampleBytes = floatingCapture_ ? 4U : 2U;
    writeValue<std::uint16_t>(file_, floatingCapture_ ? 3U : 1U);
    writeValue<std::uint16_t>(file_, static_cast<std::uint16_t>(channels_));
    writeValue(file_, sampleRateHz_);
    const auto byteRate = sampleRateHz_ * channels_ * sampleBytes;
    writeValue(file_, byteRate);
    writeValue<std::uint16_t>(file_, static_cast<std::uint16_t>(channels_ * sampleBytes));
    writeValue<std::uint16_t>(file_, static_cast<std::uint16_t>(sampleBytes * 8U));
    file_.write("data", 4);
    writeValue(file_, dataBytes);
}
void WavWriter::close(float gain, bool preserveFloat) {
    RealtimeInstrumentation::reportDiskIo();
    if (!file_.is_open())
        return;
    if (!std::isfinite(gain) || gain < 0.0F || gain > 1.0F || (preserveFloat && gain != 1.0F))
        throw std::invalid_argument("invalid recording attenuation");
    if (floatingCapture_ && !preserveFloat) {
        // Preserve unclipped capture until a complete PCM16 replacement is safely published.
        writeHeader(static_cast<std::uint32_t>(dataBytes_));
        file_.flush();
        if (!file_)
            throw std::runtime_error("recording capture finalization failed");
        const auto temporary = filePath_ + ".normalizing";
        WavWriter normalized;
        normalized.open(temporary, sampleRateHz_, channels_);
        std::vector<float> samples(std::max(1U, 8192U / channels_) * channels_);
        for (std::uint64_t offset = 0; offset < dataBytes_;) {
            const auto bytes = std::min<std::uint64_t>(samples.size() * sizeof(float), dataBytes_ - offset);
            file_.seekg(static_cast<std::streamoff>(44U + offset));
            file_.read(reinterpret_cast<char*>(samples.data()), static_cast<std::streamsize>(bytes));
            if (!file_)
                throw std::runtime_error("recording capture read failed");
            const auto count = static_cast<std::size_t>(bytes / sizeof(float));
            for (std::size_t index = 0; index < count; ++index)
                samples[index] *= gain;
            normalized.write(std::span<const float>{samples.data(), count});
            offset += bytes;
        }
        normalized.close();
        file_.close();
        const std::filesystem::path source{std::u8string{temporary.begin(), temporary.end()}};
        const std::filesystem::path target{std::u8string{filePath_.begin(), filePath_.end()}};
#ifdef _WIN32
        if (!MoveFileExW(source.c_str(), target.c_str(), MOVEFILE_REPLACE_EXISTING | MOVEFILE_WRITE_THROUGH))
            throw std::runtime_error("recording headroom publication failed");
#else
        std::filesystem::rename(source, target);
#endif
        floatingCapture_ = false;
        dataBytes_ /= 2U;
        return;
    }
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
