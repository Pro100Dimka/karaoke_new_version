#pragma once
#ifdef _WIN32
#include "media/IAudioDecoder.hpp"
#include <atomic>
#include <cstddef>
#include <cstdint>
#include <memory>
#include <mutex>
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
    friend struct MediaFoundationTestAccess;
    IMFSourceReader* reader_{nullptr};
    std::mutex readerMutex_; // Publication and cancel/close lifetime; never held during ReadSample.
    std::atomic<bool> cancelled_{false};
    DecodedAudioFormat format_{};
    std::vector<float> pending_;
    std::size_t pendingOffset_{0};
    bool mfStarted_{false};
    bool comInitialized_{false};
    bool eof_{false};
};
#endif
