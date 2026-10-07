#include "diagnostics/LatencyRegistry.hpp"

#include <algorithm>
#include <array>
#include <span>

namespace {
constexpr std::array<std::string_view, 10> names{
    "Capture",        "ClockBridge", "MediaDecoder",  "MediaPitch",    "DSP",
    "RecordingQueue", "NetworkSend", "NetworkJitter", "RenderPadding", "OutputDriver"};
static_assert(names.size() == static_cast<std::size_t>(LatencyRegistry::Stage::Count));

std::uint32_t saturateFrames(std::uint64_t frames) noexcept {
    return static_cast<std::uint32_t>(std::min<std::uint64_t>(frames, UINT32_MAX));
}
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

std::uint32_t LatencyRegistry::convertFrames(std::uint32_t frames, std::uint32_t fromRate,
                                             std::uint32_t toRate) noexcept {
    if (fromRate == 0 || toRate == 0)
        return 0;
    const auto value = (static_cast<std::uint64_t>(frames) * toRate + fromRate - 1U) / fromRate;
    return saturateFrames(value);
}

std::uint32_t LatencyRegistry::totalFrames(Path path) const noexcept {
    constexpr std::array monitoring{Stage::Capture, Stage::ClockBridge, Stage::Dsp,
                                    Stage::OutputDriver};
    constexpr std::array playback{Stage::MediaPitch, Stage::OutputDriver};
    const std::array routes{std::span<const Stage>{monitoring}, std::span<const Stage>{playback}};
    std::uint64_t total = 0;
    for (const auto stage : routes[static_cast<std::size_t>(path)]) {
        const auto& value = values_[static_cast<std::size_t>(stage)];
        total += static_cast<std::uint64_t>(value.algorithmic.load(std::memory_order_relaxed)) +
                 value.fill.load(std::memory_order_acquire);
    }
    return saturateFrames(total);
}
