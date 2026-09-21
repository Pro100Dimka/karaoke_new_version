#include "diagnostics/LatencyRegistry.hpp"

#include <array>

namespace {
constexpr std::array names{std::string_view{"Capture"},       std::string_view{"ClockBridge"},
                           std::string_view{"MediaDecoder"},  std::string_view{"MediaPitch"},
                           std::string_view{"DSP"},           std::string_view{"RecordingQueue"},
                           std::string_view{"NetworkSend"},   std::string_view{"NetworkJitter"},
                           std::string_view{"RenderPadding"}, std::string_view{"OutputDriver"}};
static_assert(names.size() == static_cast<std::size_t>(LatencyRegistry::Stage::Count));
} // namespace

void LatencyRegistry::set(Stage stage, std::uint32_t bufferedFrames,
                          std::uint32_t algorithmicFrames,
                          std::uint32_t currentFillFrames) noexcept {
    auto& value = values_[static_cast<std::size_t>(stage)];
    value.buffered.store(bufferedFrames, std::memory_order_relaxed);
    value.algorithmic.store(algorithmicFrames, std::memory_order_relaxed);
    value.fill.store(currentFillFrames, std::memory_order_release);
}

LatencyStageSnapshot LatencyRegistry::get(Stage stage) const noexcept {
    const auto index = static_cast<std::size_t>(stage);
    const auto& value = values_[index];
    return {names[index], value.buffered.load(std::memory_order_relaxed),
            value.algorithmic.load(std::memory_order_relaxed),
            value.fill.load(std::memory_order_acquire)};
}

std::uint32_t LatencyRegistry::totalFrames() const noexcept {
    std::uint64_t total = 0;
    for (const auto& value : values_) {
        total += value.algorithmic.load(std::memory_order_relaxed) +
                 value.fill.load(std::memory_order_acquire);
    }
    return static_cast<std::uint32_t>(total > 0xFFFFFFFFULL ? 0xFFFFFFFFULL : total);
}
