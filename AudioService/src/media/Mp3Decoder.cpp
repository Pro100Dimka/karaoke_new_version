#include "media/DecoderFactory.hpp"
#include "common/Types.hpp"
#include "realtime/RealtimeInstrumentation.hpp"

#include <algorithm>
#include <array>
#include <atomic>
#include <filesystem>
#include <stdexcept>

#define DR_MP3_IMPLEMENTATION
#include <dr_mp3.h>

namespace {
// A bounded index keeps karaoke seeks short without retaining decoded songs in memory or on disk.
constexpr std::size_t MaximumSeekPoints = 512;

class Mp3Decoder final : public IAudioDecoder {
  public:
    ~Mp3Decoder() override { close(); }

    DecodedAudioFormat open(const std::string& path) override try {
        close();
        RealtimeInstrumentation::reportDiskIo();
        cancelled_.store(false, std::memory_order_release);
#ifdef _WIN32
        const auto nativePath = std::filesystem::path{std::u8string{path.begin(), path.end()}};
        opened_ = drmp3_init_file_w(&decoder_, nativePath.c_str(), nullptr) != DRMP3_FALSE;
#else
        opened_ = drmp3_init_file(&decoder_, path.c_str(), nullptr) != DRMP3_FALSE;
#endif
        if (!opened_)
            throw std::runtime_error("Cannot open MP3 source");
        totalFrames_ = drmp3_get_pcm_frame_count(&decoder_);
        if (decoder_.sampleRate == 0 || decoder_.channels == 0 ||
            decoder_.channels > MaxAudioChannels || totalFrames_ == 0)
            throw std::runtime_error("Unsupported MP3 audio dimensions");
        auto count = static_cast<drmp3_uint32>(seekPoints_.size());
        if (!drmp3_calculate_seek_points(&decoder_, &count, seekPoints_.data()) ||
            !drmp3_bind_seek_table(&decoder_, count, seekPoints_.data()))
            throw std::runtime_error("Cannot index MP3 source");
        // dr_mp3 trims the Xing/LAME encoder delay and final padding. Its public seek/count APIs
        // address that same gapless PCM timeline, including the first sample after a seek.
        return {decoder_.sampleRate, decoder_.channels, totalFrames_};
    } catch (...) {
        close();
        throw;
    }

    std::uint32_t read(std::span<float> output, std::uint32_t maxFrames) override {
        RealtimeInstrumentation::reportDiskIo();
        if (!opened_ || cancelled_.load(std::memory_order_acquire))
            return 0;
        const auto count = std::min<std::size_t>(maxFrames, output.size() / decoder_.channels);
        const auto frames = drmp3_read_pcm_frames_f32(&decoder_, count, output.data());
        const auto cursor = decoder_.currentPCMFrame > decoder_.delayInPCMFrames
                                ? decoder_.currentPCMFrame - decoder_.delayInPCMFrames
                                : 0;
        if (frames < count && cursor < totalFrames_ &&
            !cancelled_.load(std::memory_order_acquire))
            throw std::runtime_error("MP3 read failed before the end of audio data");
        return static_cast<std::uint32_t>(frames);
    }

    void seek(std::uint64_t frame) override {
        RealtimeInstrumentation::reportDiskIo();
        if (!opened_)
            return;
        if (frame > totalFrames_ || !drmp3_seek_to_pcm_frame(&decoder_, frame))
            throw std::runtime_error("MP3 seek failed");
        cancelled_.store(false, std::memory_order_release);
    }

    void cancel() noexcept override { cancelled_.store(true, std::memory_order_release); }

    void close() noexcept override {
        RealtimeInstrumentation::reportDiskIo();
        if (opened_)
            drmp3_uninit(&decoder_);
        opened_ = false;
        totalFrames_ = 0;
    }

  private:
    drmp3 decoder_{};
    std::array<drmp3_seek_point, MaximumSeekPoints> seekPoints_{};
    std::uint64_t totalFrames_{0};
    bool opened_{false};
    std::atomic<bool> cancelled_{false};
};
} // namespace

std::unique_ptr<IAudioDecoder> createMp3Decoder() { return std::make_unique<Mp3Decoder>(); }
