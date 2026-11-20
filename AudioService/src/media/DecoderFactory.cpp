#include "media/DecoderFactory.hpp"
#include <algorithm>
#include <array>
#include <atomic>
#include <cctype>
#include <filesystem>
#include <string_view>
#ifdef _WIN32
#include "media/MediaFoundationDecoder.hpp"
#else
#include "media/WavDecoder.hpp"
#endif

std::unique_ptr<IAudioDecoder> createLocalCompressedDecoder(const std::string& pathOrUrl) {
    if (pathOrUrl.find("://") != std::string::npos)
        return nullptr;
    auto extension = std::filesystem::path{std::u8string{pathOrUrl.begin(), pathOrUrl.end()}}
                         .extension().string();
    std::ranges::transform(extension, extension.begin(),
                           [](unsigned char value) { return static_cast<char>(std::tolower(value)); });
    using DecoderBuilder = std::unique_ptr<IAudioDecoder> (*)();
    constexpr std::array<std::pair<std::string_view, DecoderBuilder>, 2> decoders{
        {{".flac", createFlacDecoder}, {".mp3", createMp3Decoder}},
    };
    const auto selected = std::ranges::find_if(decoders, [&](const auto& item) {
        return item.first == extension;
    });
    return selected == decoders.end() ? nullptr : selected->second();
}

#ifndef _WIN32
namespace {
class FileDecoder final : public IAudioDecoder {
  public:
    DecodedAudioFormat open(const std::string& path) override {
        close();
        cancelled_.store(false, std::memory_order_release);
        auto decoder = createLocalCompressedDecoder(path);
        if (!decoder)
            decoder = std::make_unique<WavDecoder>();
        const auto format = decoder->open(path);
        decoder_ = std::move(decoder);
        return format;
    }
    std::uint32_t read(std::span<float> output, std::uint32_t frames) override {
        return decoder_ && !cancelled_.load(std::memory_order_acquire)
                   ? decoder_->read(output, frames) : 0;
    }
    void seek(std::uint64_t frame) override {
        if (decoder_)
            decoder_->seek(frame);
        cancelled_.store(false, std::memory_order_release);
    }
    void cancel() noexcept override { cancelled_.store(true, std::memory_order_release); }
    void close() noexcept override { decoder_.reset(); }

  private:
    std::unique_ptr<IAudioDecoder> decoder_;
    std::atomic<bool> cancelled_{false};
};
} // namespace
#endif

std::unique_ptr<IAudioDecoder> createDefaultAudioDecoder() {
#ifdef _WIN32
    return std::make_unique<MediaFoundationDecoder>();
#else
    return std::make_unique<FileDecoder>();
#endif
}
