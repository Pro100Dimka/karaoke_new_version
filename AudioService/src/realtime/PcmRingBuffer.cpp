#include "realtime/PcmRingBuffer.hpp"

#include <algorithm>

PcmRingBuffer::PcmRingBuffer(std::uint32_t capacityFrames, std::uint32_t channels) {
    prepare(capacityFrames, channels);
}

void PcmRingBuffer::prepare(std::uint32_t capacityFrames, std::uint32_t channels) {
    capacityFrames_ = std::max<std::uint32_t>(1, capacityFrames);
    channels_ = std::max<std::uint32_t>(1, channels);
    data_.assign(static_cast<std::size_t>(capacityFrames_) * channels_, 0.0F);
    readFrame_.store(0, std::memory_order_relaxed);
    writeFrame_.store(0, std::memory_order_relaxed);
    epoch_.fetch_add(1, std::memory_order_release);
}

void PcmRingBuffer::clear() noexcept {
    // Indices stay monotonic so an in-flight consumer cannot move readFrame backwards.
    const auto write = writeFrame_.load(std::memory_order_acquire);
    auto read = readFrame_.load(std::memory_order_relaxed);
    while (read < write && !readFrame_.compare_exchange_weak(read, write, std::memory_order_release,
                                                             std::memory_order_relaxed)) {
    }
    epoch_.fetch_add(1, std::memory_order_release);
}

std::uint32_t PcmRingBuffer::availableFrames() const noexcept {
    const auto write = writeFrame_.load(std::memory_order_acquire);
    const auto read = readFrame_.load(std::memory_order_acquire);
    if (write <= read)
        return 0;
    return static_cast<std::uint32_t>(std::min<std::uint64_t>(write - read, capacityFrames_));
}

std::uint32_t PcmRingBuffer::freeFrames() const noexcept {
    return capacityFrames_ - availableFrames();
}

bool PcmRingBuffer::push(std::span<const float> interleaved, std::uint32_t frames) noexcept {
    if (capacityFrames_ == 0 || channels_ == 0 || frames > freeFrames() ||
        interleaved.size() < static_cast<std::size_t>(frames) * channels_) {
        return false;
    }

    const auto write = writeFrame_.load(std::memory_order_relaxed);
    for (std::uint32_t frame = 0; frame < frames; ++frame) {
        const auto dstFrame = static_cast<std::uint32_t>((write + frame) % capacityFrames_);
        const auto dst = static_cast<std::size_t>(dstFrame) * channels_;
        const auto src = static_cast<std::size_t>(frame) * channels_;
        std::copy_n(interleaved.data() + src, channels_, data_.data() + dst);
    }
    writeFrame_.store(write + frames, std::memory_order_release);
    return true;
}

std::uint32_t PcmRingBuffer::peek(std::span<float> output, std::uint32_t frames) const noexcept {
    const auto read = readFrame_.load(std::memory_order_acquire);
    const auto write = writeFrame_.load(std::memory_order_acquire);
    const auto available = write > read ? write - read : 0U;
    const auto count = static_cast<std::uint32_t>(
        std::min<std::uint64_t>(std::min<std::uint64_t>(available, capacityFrames_), frames));
    if (output.size() < static_cast<std::size_t>(count) * channels_)
        return 0;

    for (std::uint32_t frame = 0; frame < count; ++frame) {
        const auto srcFrame = static_cast<std::uint32_t>((read + frame) % capacityFrames_);
        const auto src = static_cast<std::size_t>(srcFrame) * channels_;
        const auto dst = static_cast<std::size_t>(frame) * channels_;
        std::copy_n(data_.data() + src, channels_, output.data() + dst);
    }
    return count;
}

std::uint32_t PcmRingBuffer::discard(std::uint32_t frames) noexcept {
    while (true) {
        auto read = readFrame_.load(std::memory_order_acquire);
        const auto write = writeFrame_.load(std::memory_order_acquire);
        if (write <= read)
            return 0;
        const auto count = static_cast<std::uint32_t>(std::min<std::uint64_t>(
            frames, std::min<std::uint64_t>(write - read, capacityFrames_)));
        if (readFrame_.compare_exchange_weak(read, read + count, std::memory_order_release,
                                             std::memory_order_relaxed)) {
            return count;
        }
    }
}

std::uint32_t PcmRingBuffer::pop(std::span<float> output, std::uint32_t frames) noexcept {
    const auto count = peek(output, frames);
    const auto discarded = discard(count);
    return discarded == count ? count : 0;
}

void GenerationPcmRingBuffer::prepare(std::uint32_t capacityFrames, std::uint32_t channels) {
    ring_.prepare(capacityFrames, channels);
}

void GenerationPcmRingBuffer::reset(SourceGenerationId generation) noexcept {
    generation_.store(generation, std::memory_order_release);
    ring_.clear();
}

bool GenerationPcmRingBuffer::push(SourceGenerationId generation, std::span<const float> samples,
                                   std::uint32_t frames) noexcept {
    if (generation != generation_.load(std::memory_order_acquire))
        return false;
    const auto epoch = ring_.epoch();
    if (!ring_.push(samples, frames))
        return false;
    if (generation != generation_.load(std::memory_order_acquire) || epoch != ring_.epoch()) {
        // The control plane invalidated this source while the producer was writing.
        ring_.clear();
        return false;
    }
    return true;
}

std::uint32_t GenerationPcmRingBuffer::pop(std::span<float> output, std::uint32_t frames) noexcept {
    const auto generation = generation_.load(std::memory_order_acquire);
    const auto epoch = ring_.epoch();
    const auto count = ring_.pop(output, frames);
    if (generation != generation_.load(std::memory_order_acquire) || epoch != ring_.epoch()) {
        std::fill_n(output.data(), static_cast<std::size_t>(count) * ring_.channels(), 0.0F);
        return 0;
    }
    return count;
}

std::uint32_t GenerationPcmRingBuffer::peek(std::span<float> output,
                                            std::uint32_t frames) const noexcept {
    const auto generation = generation_.load(std::memory_order_acquire);
    const auto epoch = ring_.epoch();
    const auto count = ring_.peek(output, frames);
    if (generation != generation_.load(std::memory_order_acquire) || epoch != ring_.epoch()) {
        std::fill_n(output.data(), static_cast<std::size_t>(count) * ring_.channels(), 0.0F);
        return 0;
    }
    return count;
}

std::uint32_t GenerationPcmRingBuffer::discard(std::uint32_t frames) noexcept {
    return ring_.discard(frames);
}
