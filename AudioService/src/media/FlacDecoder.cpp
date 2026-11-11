#include "media/DecoderFactory.hpp"
#include "common/Types.hpp"
#include "realtime/RealtimeInstrumentation.hpp"
#include <algorithm>
#include <atomic>
#include <filesystem>
#include <stdexcept>

#define DR_FLAC_IMPLEMENTATION
#include <dr_flac.h>

namespace {
class FlacDecoder final : public IAudioDecoder {
  public:
    ~FlacDecoder() override { close(); }

    DecodedAudioFormat open(const std::string& path) override {
        close();
        RealtimeInstrumentation::reportDiskIo();
#ifdef _WIN32
        const auto nativePath = std::filesystem::path{std::u8string{path.begin(), path.end()}};
        decoder_ = drflac_open_file_w(nativePath.c_str(), nullptr);
#else
        decoder_ = drflac_open_file(path.c_str(), nullptr);
#endif
        if (decoder_ == nullptr)
            throw std::runtime_error("Cannot open FLAC source");
        if (decoder_->sampleRate == 0 || decoder_->channels == 0 ||
            decoder_->channels > MaxAudioChannels) {
            close();
            throw std::runtime_error("Unsupported FLAC audio dimensions");
        }
        cancelled_.store(false, std::memory_order_release);
        return {decoder_->sampleRate, decoder_->channels, decoder_->totalPCMFrameCount};
    }

    std::uint32_t read(std::span<float> output, std::uint32_t maxFrames) override {
        RealtimeInstrumentation::reportDiskIo();
        if (decoder_ == nullptr || cancelled_.load(std::memory_order_acquire))
            return 0;
        const auto count = std::min<std::size_t>(maxFrames, output.size() / decoder_->channels);
        return static_cast<std::uint32_t>(drflac_read_pcm_frames_f32(decoder_, count, output.data()));
    }

    void seek(std::uint64_t frame) override {
        RealtimeInstrumentation::reportDiskIo();
        if (decoder_ == nullptr)
            return;
        if (!drflac_seek_to_pcm_frame(decoder_, frame))
            throw std::runtime_error("FLAC seek failed");
        cancelled_.store(false, std::memory_order_release);
    }

    void cancel() noexcept override { cancelled_.store(true, std::memory_order_release); }

    void close() noexcept override {
        RealtimeInstrumentation::reportDiskIo();
        if (decoder_ != nullptr)
            drflac_close(decoder_);
        decoder_ = nullptr;
    }

  private:
    drflac* decoder_{nullptr};
    std::atomic<bool> cancelled_{false};
};
} // namespace

std::unique_ptr<IAudioDecoder> createFlacDecoder() { return std::make_unique<FlacDecoder>(); }
