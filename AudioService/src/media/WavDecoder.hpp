#pragma once

#include "media/IAudioDecoder.hpp"

#include <cstdint>
#include <fstream>
#include <string>
#include <vector>

class WavDecoder final : public IAudioDecoder {
  public:
    DecodedAudioFormat open(const std::string& path) override;
    std::uint32_t read(std::span<float> interleaved, std::uint32_t maxFrames) override;
    void seek(std::uint64_t frame) override;
    void cancel() noexcept override;
    void close() noexcept override;

  private:
    std::ifstream file_;
    DecodedAudioFormat format_{};
    std::uint16_t formatTag_{0};
    std::uint16_t bitsPerSample_{0};
    std::uint16_t blockAlign_{0};
    std::uint64_t dataOffset_{0};
    std::uint64_t dataBytes_{0};
    std::uint64_t positionFrames_{0};
    std::vector<std::byte> raw_;
};
