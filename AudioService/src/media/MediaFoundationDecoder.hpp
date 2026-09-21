#pragma once
#ifdef _WIN32
#include "media/IAudioDecoder.hpp"
#include <cstddef>
#include <cstdint>
#include <memory>
#include <vector>
struct IMFSourceReader;
class MediaFoundationDecoder final : public IAudioDecoder {
  public:
    MediaFoundationDecoder();
    ~MediaFoundationDecoder() override;
    DecodedAudioFormat open(const std::string& pathOrUrl) override;
    std::uint32_t read(std::span<float> interleaved, std::uint32_t maxFrames) override;
    void seek(std::uint64_t frame) override;
    void cancel() noexcept override;
    void close() noexcept override;

  private:
    IMFSourceReader* reader_{nullptr};
    DecodedAudioFormat format_{};
    std::vector<float> pending_;
    std::size_t pendingOffset_{0};
    bool mfStarted_{false};
};
#endif
