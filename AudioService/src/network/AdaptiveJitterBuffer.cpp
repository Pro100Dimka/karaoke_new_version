#include "network/AdaptiveJitterBuffer.hpp"

#include <algorithm>

namespace {
[[nodiscard]] bool sequenceBefore(std::uint32_t left, std::uint32_t right) noexcept {
    return static_cast<std::int32_t>(left - right) < 0;
}

[[nodiscard]] bool sequenceAfter(std::uint32_t left, std::uint32_t right) noexcept {
    return static_cast<std::int32_t>(left - right) > 0;
}
} // namespace

void AdaptiveJitterBuffer::configure(std::uint32_t minimumTargetPackets,
                                     std::uint32_t maximumTargetPackets) {
    minTarget_ = std::max(1U, minimumTargetPackets);
    maxTarget_ = std::max(minTarget_, maximumTargetPackets);
    target_ = std::clamp(target_, minTarget_, maxTarget_);
    packets_.clear();
    packets_.reserve(maxTarget_);
}

void AdaptiveJitterBuffer::reset() noexcept {
    packets_.clear();
    expectedSequence_ = 0;
    started_ = false;
    target_ = minTarget_;
    lost_ = 0;
    late_ = 0;
    duplicates_ = 0;
    overflows_ = 0;
    stablePops_ = 0;
}

void AdaptiveJitterBuffer::push(NetworkAudioPacket packet) {
    if (started_ && sequenceBefore(packet.sequence, expectedSequence_)) {
        ++late_;
        updateTarget(true);
        return;
    }
    if (started_ && sequenceAfter(packet.sequence, expectedSequence_)) {
        const auto missing = packet.sequence - expectedSequence_;
        if (missing > maxTarget_ * 4U) {
            // A multi-second outage is a discontinuity, not thousands of individual frames that
            // should be synthesized with PLC. Rebase at the live head and retain the full gap in
            // diagnostics so playback catches the current room position immediately.
            lost_ += missing;
            packets_.clear();
            expectedSequence_ = packet.sequence;
            target_ = minTarget_;
            stablePops_ = 0;
        }
    }

    const auto it = std::lower_bound(
        packets_.begin(), packets_.end(), packet.sequence,
        [](const NetworkAudioPacket& current, std::uint32_t sequence) {
            return sequenceBefore(current.sequence, sequence);
        });
    if (it != packets_.end() && it->sequence == packet.sequence) {
        ++duplicates_;
        return;
    }

    if (packets_.size() == maxTarget_) {
        ++overflows_;
        // Keep packets closest to the playout head. A very-far-future packet is less useful
        // than an earlier packet that can close a gap.
        if (it == packets_.end())
            return;
        packets_.pop_back();
    }
    packets_.insert(it, std::move(packet));
}

void AdaptiveJitterBuffer::updateTarget(bool late) noexcept {
    if (late) {
        target_ = std::min(maxTarget_, target_ + 1U);
        stablePops_ = 0;
        return;
    }
    if (++stablePops_ >= 200U && target_ > minTarget_) {
        --target_;
        stablePops_ = 0;
    }
}

JitterPopOutcome AdaptiveJitterBuffer::pop(NetworkAudioPacket& packet) {
    if (!started_) {
        if (packets_.size() < target_)
            return JitterPopOutcome::Empty;
        expectedSequence_ = packets_.front().sequence;
        started_ = true;
    }

    if (!packets_.empty() && packets_.front().sequence == expectedSequence_) {
        packet = std::move(packets_.front());
        packets_.erase(packets_.begin());
        ++expectedSequence_;
        updateTarget(false);
        return JitterPopOutcome::Delivered;
    }

    if (!packets_.empty() && sequenceAfter(packets_.front().sequence, expectedSequence_)) {
        // A future packet is not proof of loss by itself: keep the configured reorder window open
        // so a delayed packet can still arrive before PLC is committed.
        if (packets_.size() < target_)
            return JitterPopOutcome::Empty;
        ++lost_;
        ++expectedSequence_;
        updateTarget(true);
        return JitterPopOutcome::Lost;
    }
    return JitterPopOutcome::Empty;
}

JitterBufferSnapshot AdaptiveJitterBuffer::snapshot() const noexcept {
    return {minTarget_, target_, maxTarget_,  static_cast<std::uint32_t>(packets_.size()),
            lost_,      late_,   duplicates_, overflows_};
}
