#pragma once

#include <array>
#include <atomic>
#include <cstdint>
#include <string_view>

struct LatencyStageSnapshot {
    std::string_view name;
    std::uint32_t bufferedFrames{0};
    std::uint32_t algorithmicFrames{0};
    std::uint32_t currentFillFrames{0};
};

class LatencyRegistry {
  public:
    enum class Path { Monitoring, Playback };
    enum class Stage : std::size_t {
        Capture,
        ClockBridge,
        MediaDecoder,
        MediaPitch,
        Dsp,
        RecordingQueue,
        NetworkSend,
        NetworkJitter,
        RenderPadding,
        OutputDriver,
        Count
    };

    void set(Stage stage, std::uint32_t bufferedFrames, std::uint32_t algorithmicFrames,
             std::uint32_t currentFillFrames) noexcept;
    [[nodiscard]] LatencyStageSnapshot get(Stage stage) const noexcept;
    // Stage frames use the negotiated output sample clock. Parallel destinations are never summed.
    [[nodiscard]] std::uint32_t totalFrames(Path path = Path::Monitoring) const noexcept;
    [[nodiscard]] static std::uint32_t convertFrames(std::uint32_t frames, std::uint32_t fromRate,
                                                     std::uint32_t toRate) noexcept;

  private:
    struct Value {
        std::atomic<std::uint32_t> buffered{0};
        std::atomic<std::uint32_t> algorithmic{0};
        std::atomic<std::uint32_t> fill{0};
    };
    std::array<Value, static_cast<std::size_t>(Stage::Count)> values_{};
};
