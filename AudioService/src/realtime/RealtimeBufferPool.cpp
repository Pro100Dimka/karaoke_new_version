#include "realtime/RealtimeBufferPool.hpp"

#include <stdexcept>

void RealtimeBufferPool::prepare(std::uint32_t bufferCount, std::uint32_t maxFrames,
                                 std::uint32_t channels) {
    if (bufferCount == 0 || maxFrames == 0 || channels == 0) {
        throw std::invalid_argument("invalid realtime buffer pool shape");
    }
    bufferCount_ = bufferCount;
    maxFrames_ = maxFrames;
    channels_ = channels;
    storage_.assign(static_cast<std::size_t>(bufferCount_) * maxFrames_ * channels_, 0.0F);
}

std::span<float> RealtimeBufferPool::buffer(std::uint32_t index, std::uint32_t frames) noexcept {
    if (index >= bufferCount_ || frames > maxFrames_) {
        return {};
    }
    const auto stride = static_cast<std::size_t>(maxFrames_) * channels_;
    return {storage_.data() + static_cast<std::ptrdiff_t>(stride * index),
            static_cast<std::size_t>(frames) * channels_};
}
