#include "realtime/PcmRingBuffer.hpp"
#include "realtime/RealtimeInstrumentation.hpp"

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
    RealtimeInstrumentation::reportBlockingCall();
    // Only the control/worker thread waits. Callbacks reject access during the reset.
    while (clearing_.test_and_set())
        clearing_.wait(true);
    for (auto count = users_.load(); count != 0; count = users_.load())
        users_.wait(count);
    readFrame_.store(writeFrame_.load(std::memory_order_acquire), std::memory_order_release);
    epoch_.fetch_add(1, std::memory_order_release);
    clearing_.clear();
    clearing_.notify_all();
}

bool PcmRingBuffer::enter() const noexcept {
    users_.fetch_add(1);
    if (!clearing_.test())
        return true;
    leave();
    return false;
}

void PcmRingBuffer::leave() const noexcept {
    if (users_.fetch_sub(1) == 1 && clearing_.test())
        users_.notify_all();
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
    if (!enter())
        return false;
    const auto result = pushAvailable(interleaved, frames);
    leave();
    return result;
}

bool PcmRingBuffer::pushAvailable(std::span<const float> interleaved,
                                  std::uint32_t frames) noexcept {
    if (capacityFrames_ == 0 || channels_ == 0 || frames > freeFrames() ||
        interleaved.size() < static_cast<std::size_t>(frames) * channels_) {
        return false;
    }

    const auto write = writeFrame_.load(std::memory_order_relaxed);
    if (frames != 0) {
        const auto start = static_cast<std::uint32_t>(write % capacityFrames_);
        const auto first =
            static_cast<std::size_t>(std::min(frames, capacityFrames_ - start)) * channels_;
        const auto remaining = static_cast<std::size_t>(frames) * channels_ - first;
        std::copy_n(interleaved.data(), first,
                    data_.data() + static_cast<std::size_t>(start) * channels_);
        std::copy_n(interleaved.data() + first, remaining, data_.data());
    }
    writeFrame_.store(write + frames, std::memory_order_release);
    return true;
}

std::uint32_t PcmRingBuffer::peek(std::span<float> output, std::uint32_t frames) const noexcept {
    if (!enter())
        return 0;
    const auto count = peekAvailable(output, frames);
    leave();
    return count;
}

std::uint32_t PcmRingBuffer::peekAvailable(std::span<float> output,
                                           std::uint32_t frames) const noexcept {
    const auto read = readFrame_.load(std::memory_order_acquire);
    const auto write = writeFrame_.load(std::memory_order_acquire);
    const auto available = write > read ? write - read : 0U;
    const auto count = static_cast<std::uint32_t>(
        std::min<std::uint64_t>(std::min<std::uint64_t>(available, capacityFrames_), frames));
    if (output.size() < static_cast<std::size_t>(count) * channels_)
        return 0;

    if (count != 0) {
        const auto start = static_cast<std::uint32_t>(read % capacityFrames_);
        const auto first =
            static_cast<std::size_t>(std::min(count, capacityFrames_ - start)) * channels_;
        const auto remaining = static_cast<std::size_t>(count) * channels_ - first;
        std::copy_n(data_.data() + static_cast<std::size_t>(start) * channels_, first,
                    output.data());
        std::copy_n(data_.data(), remaining, output.data() + first);
    }
    return count;
}

std::uint32_t PcmRingBuffer::discard(std::uint32_t frames) noexcept {
    if (!enter())
        return 0;
    const auto count = discardAvailable(frames);
    leave();
    return count;
}

std::uint32_t PcmRingBuffer::discardAvailable(std::uint32_t frames) noexcept {
    const auto read = readFrame_.load(std::memory_order_relaxed);
    const auto count = std::min(frames, availableFrames());
    readFrame_.store(read + count, std::memory_order_release);
    return count;
}

std::uint32_t PcmRingBuffer::pop(std::span<float> output, std::uint32_t frames) noexcept {
    if (!enter())
        return 0;
    const auto count = peekAvailable(output, frames);
    (void)discardAvailable(count);
    leave();
    return count;
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
    if (!ring_.enter())
        return false;
    // Check identity under the same lease that protects publication from reset.
    const auto accepted = generation == generation_.load(std::memory_order_acquire) &&
                          ring_.pushAvailable(samples, frames) &&
                          generation == generation_.load(std::memory_order_acquire);
    ring_.leave();
    return accepted;
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
