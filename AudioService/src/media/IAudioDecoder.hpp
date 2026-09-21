#pragma once

#include <cstdint>
#include <span>
#include <string>

struct DecodedAudioFormat {
    std::uint32_t sampleRateHz{0};
    std::uint32_t channels{0};
    std::uint64_t totalFrames{0};
};

class IAudioDecoder {
  public:
    virtual ~IAudioDecoder() = default;
    virtual DecodedAudioFormat open(const std::string& pathOrUrl) = 0;
    virtual std::uint32_t read(std::span<float> interleaved, std::uint32_t maxFrames) = 0;
    virtual void seek(std::uint64_t frame) = 0;
    virtual void cancel() noexcept = 0;
    virtual void close() noexcept = 0;
};
