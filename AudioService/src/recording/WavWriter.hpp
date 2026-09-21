#pragma once

#include <cstdint>
#include <fstream>
#include <span>
#include <string>

class WavWriter {
  public:
    void open(const std::string& path, std::uint32_t sampleRateHz, std::uint32_t channels);
    void write(std::span<const float> interleaved);
    void close();
    void abandon() noexcept;
    [[nodiscard]] bool open() const noexcept {
        return file_.is_open();
    }

  private:
    void writeHeader(std::uint32_t dataBytes);
    std::fstream file_;
    std::uint32_t sampleRateHz_{0};
    std::uint32_t channels_{0};
    std::uint64_t dataBytes_{0};
};
