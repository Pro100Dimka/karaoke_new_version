#include "network/NetworkAudioEngine.hpp"

#include <algorithm>
#include <cmath>
#include <cstring>

namespace {
constexpr std::uint32_t Magic = 0x32445541U; // AUD2
struct PacketHeader {
    std::uint32_t magic;
    std::uint32_t sequence;
    std::uint32_t participantKey;
    std::uint64_t timestampFrame;
    std::uint16_t channels;
    std::uint16_t frames;
};
} // namespace

NetworkAudioEngine::NetworkAudioEngine() {
    for (auto& slot : remote_)
        slot = std::make_unique<RemoteSlot>();
}
NetworkAudioEngine::~NetworkAudioEngine() {
    stop();
}

std::uint32_t NetworkAudioEngine::participantKey(std::string_view id) noexcept {
    std::uint32_t hash = 2166136261U;
    for (const auto ch : id) {
        hash ^= static_cast<std::uint8_t>(ch);
        hash *= 16777619U;
    }
    return hash == 0 ? 1U : hash;
}

void NetworkAudioEngine::prepare(std::uint32_t sampleRateHz, std::uint32_t channels,
                                 std::uint32_t queueFrames, std::uint32_t packetFrames,
                                 GenerationId generation) {
    stop();
    sampleRateHz_ = sampleRateHz;
    channels_ = channels;
    queueFrames_ = queueFrames;
    packetFrames_ = packetFrames;
    sequence_.store(0, std::memory_order_relaxed);
    packetsSent_.store(0, std::memory_order_relaxed);
    packetsReceived_.store(0, std::memory_order_relaxed);
    droppedSendBlocks_.store(0, std::memory_order_relaxed);
    staleBlocks_.store(0, std::memory_order_relaxed);
    generation_.store(generation, std::memory_order_release);
    sendQueue_.prepare(queueFrames, channels);
    remoteScratch_.assign(static_cast<std::size_t>(MaxBlockFrames) * channels, 0.0F);
    for (auto& owned : remote_) {
        auto& slot = *owned;
        slot.active.store(false, std::memory_order_relaxed);
        slot.participantKey.store(0, std::memory_order_relaxed);
        slot.participantId.clear();
        slot.gain.store(1.0F, std::memory_order_relaxed);
        slot.muted.store(false, std::memory_order_relaxed);
        slot.level.store(0.0F, std::memory_order_relaxed);
        slot.decodeUnderruns.store(0, std::memory_order_relaxed);
        slot.queueOverruns.store(0, std::memory_order_relaxed);
        slot.queue.prepare(queueFrames, channels);
        std::lock_guard lock(slot.jitterMutex);
        slot.jitter.configure(2, 12);
        slot.jitter.reset();
    }
}

void NetworkAudioEngine::setGeneration(GenerationId generation) noexcept {
    generation_.store(generation, std::memory_order_release);
    sendQueue_.clear();
    for (auto& owned : remote_) {
        auto& slot = *owned;
        slot.queue.clear();
        std::lock_guard lock(slot.jitterMutex);
        slot.jitter.reset();
    }
    sendCv_.notify_all();
}

void NetworkAudioEngine::setLocalParticipant(std::string participantId) {
    localParticipantKey_.store(participantKey(participantId), std::memory_order_release);
}

bool NetworkAudioEngine::addRemoteParticipant(std::string participantId) {
    if (participantId.empty())
        return false;
    if (slotForId(participantId) != nullptr)
        return true;
    const auto key = participantKey(participantId);
    for (auto& owned : remote_) {
        auto& slot = *owned;
        if (slot.active.load(std::memory_order_acquire))
            continue;
        if (slot.participantKey.load(std::memory_order_acquire) != 0)
            continue;
        slot.participantId = std::move(participantId);
        slot.queue.clear();
        {
            std::lock_guard lock(slot.jitterMutex);
            slot.jitter.reset();
        }
        slot.gain.store(1.0F, std::memory_order_relaxed);
        slot.muted.store(false, std::memory_order_relaxed);
        slot.level.store(0.0F, std::memory_order_relaxed);
        slot.decodeUnderruns.store(0, std::memory_order_relaxed);
        slot.queueOverruns.store(0, std::memory_order_relaxed);
        slot.participantKey.store(key, std::memory_order_release);
        slot.active.store(true, std::memory_order_release);
        return true;
    }
    return false;
}

bool NetworkAudioEngine::removeRemoteParticipant(std::string_view participantId) noexcept {
    auto* slot = slotForId(participantId);
    if (slot == nullptr)
        return false;
    slot->active.store(false, std::memory_order_release);
    slot->queue.clear();
    slot->participantKey.store(0, std::memory_order_release);
    slot->participantId.clear();
    return true;
}

bool NetworkAudioEngine::setRemoteGain(std::string_view participantId, float gain) noexcept {
    auto* slot = slotForId(participantId);
    if (slot == nullptr)
        return false;
    slot->gain.store(std::clamp(gain, 0.0F, 4.0F), std::memory_order_relaxed);
    return true;
}

bool NetworkAudioEngine::setRemoteMute(std::string_view participantId, bool muted) noexcept {
    auto* slot = slotForId(participantId);
    if (slot == nullptr)
        return false;
    slot->muted.store(muted, std::memory_order_relaxed);
    return true;
}

NetworkAudioEngine::RemoteSlot* NetworkAudioEngine::slotForKey(std::uint32_t key) noexcept {
    for (auto& owned : remote_) {
        auto& slot = *owned;
        if (slot.active.load(std::memory_order_acquire) &&
            slot.participantKey.load(std::memory_order_relaxed) == key)
            return &slot;
    }
    return nullptr;
}
NetworkAudioEngine::RemoteSlot* NetworkAudioEngine::slotForId(std::string_view id) noexcept {
    const auto key = participantKey(id);
    for (auto& owned : remote_) {
        auto& slot = *owned;
        if (slot.active.load(std::memory_order_acquire) &&
            slot.participantKey.load(std::memory_order_relaxed) == key && slot.participantId == id)
            return &slot;
    }
    return nullptr;
}
const NetworkAudioEngine::RemoteSlot*
NetworkAudioEngine::slotForId(std::string_view id) const noexcept {
    const auto key = participantKey(id);
    for (const auto& owned : remote_) {
        const auto& slot = *owned;
        if (slot.active.load(std::memory_order_acquire) &&
            slot.participantKey.load(std::memory_order_relaxed) == key && slot.participantId == id)
            return &slot;
    }
    return nullptr;
}

void NetworkAudioEngine::startSend(const std::string& host, std::uint16_t port) {
    sendSocket_.connect(host, port);
    sendEnabled_.store(true, std::memory_order_release);
    running_.store(true, std::memory_order_release);
    if (!sendThread_.joinable())
        sendThread_ = std::thread(&NetworkAudioEngine::sendMain, this);
}
void NetworkAudioEngine::startReceive(std::uint16_t port) {
    receiveSocket_.bind(port);
    receiveSocket_.setReceiveTimeoutMs(100);
    running_.store(true, std::memory_order_release);
    if (!receiveThread_.joinable())
        receiveThread_ = std::thread(&NetworkAudioEngine::receiveMain, this);
}
void NetworkAudioEngine::stop() noexcept {
    running_.store(false, std::memory_order_release);
    sendEnabled_.store(false, std::memory_order_release);
    sendCv_.notify_all();
    sendSocket_.close();
    receiveSocket_.close();
    if (sendThread_.joinable())
        sendThread_.join();
    if (receiveThread_.joinable())
        receiveThread_.join();
    sendQueue_.clear();
    for (auto& owned : remote_)
        owned->queue.clear();
}
void NetworkAudioEngine::pushLocal(GenerationId generation, std::span<const float> samples,
                                   std::uint32_t frames) noexcept {
    if (generation != generation_.load(std::memory_order_acquire)) {
        staleBlocks_.fetch_add(1, std::memory_order_relaxed);
        return;
    }
    if (!running_.load(std::memory_order_acquire) || !sendEnabled_.load(std::memory_order_acquire))
        return;
    if (!sendQueue_.push(samples, frames)) {
        droppedSendBlocks_.fetch_add(1, std::memory_order_relaxed);
        return;
    }
    sendCv_.notify_one();
}

std::uint32_t NetworkAudioEngine::renderRemote(GenerationId generation, std::span<float> output,
                                               std::uint32_t frames) noexcept {
    if (generation != generation_.load(std::memory_order_acquire)) {
        staleBlocks_.fetch_add(1, std::memory_order_relaxed);
        return 0;
    }
    const auto sampleCount = static_cast<std::size_t>(frames) * channels_;
    if (frames > MaxBlockFrames || output.size() < sampleCount ||
        remoteScratch_.size() < sampleCount)
        return 0;
    std::fill_n(output.data(), sampleCount, 0.0F);
    bool any = false;
    for (auto& owned : remote_) {
        auto& slot = *owned;
        if (!slot.active.load(std::memory_order_acquire))
            continue;
        const auto read =
            slot.queue.pop(std::span<float>{remoteScratch_.data(), sampleCount}, frames);
        if (read < frames) {
            const auto begin = static_cast<std::size_t>(read) * channels_;
            std::fill(remoteScratch_.begin() + static_cast<std::ptrdiff_t>(begin),
                      remoteScratch_.begin() + static_cast<std::ptrdiff_t>(sampleCount), 0.0F);
            slot.decodeUnderruns.fetch_add(1, std::memory_order_relaxed);
        }
        if (slot.muted.load(std::memory_order_relaxed))
            continue;
        const auto gain = slot.gain.load(std::memory_order_relaxed);
        float peak = 0.0F;
        for (std::size_t index = 0; index < sampleCount; ++index) {
            const auto sample = remoteScratch_[index] * gain;
            output[index] += sample;
            peak = std::max(peak, std::abs(sample));
        }
        slot.level.store(peak, std::memory_order_relaxed);
        any = any || read != 0;
    }
    return any ? frames : 0;
}

void NetworkAudioEngine::sendMain() noexcept {
    std::vector<float> samples(static_cast<std::size_t>(packetFrames_) * channels_);
    while (running_.load(std::memory_order_acquire) &&
           sendEnabled_.load(std::memory_order_acquire)) {
        {
            std::unique_lock lock(sendMutex_);
            sendCv_.wait(lock, [this] {
                return !running_.load(std::memory_order_acquire) ||
                       !sendEnabled_.load(std::memory_order_acquire) ||
                       sendQueue_.availableFrames() >= packetFrames_;
            });
        }
        if (!running_.load(std::memory_order_acquire) ||
            !sendEnabled_.load(std::memory_order_acquire))
            break;
        const auto workGeneration = generation_.load(std::memory_order_acquire);
        const auto frames = sendQueue_.pop(samples, packetFrames_);
        if (frames == 0)
            continue;
        if (workGeneration != generation_.load(std::memory_order_acquire)) {
            staleBlocks_.fetch_add(1, std::memory_order_relaxed);
            continue;
        }
        const auto payload = codec_.encode(
            std::span<const float>{samples.data(), static_cast<std::size_t>(frames) * channels_});
        PacketHeader header{Magic,
                            sequence_.fetch_add(1, std::memory_order_relaxed),
                            localParticipantKey_.load(std::memory_order_relaxed),
                            0,
                            static_cast<std::uint16_t>(channels_),
                            static_cast<std::uint16_t>(frames)};
        std::vector<std::byte> packet(sizeof(header) + payload.size());
        std::memcpy(packet.data(), &header, sizeof(header));
        std::memcpy(packet.data() + static_cast<std::ptrdiff_t>(sizeof(header)), payload.data(),
                    payload.size());
        if (sendSocket_.send(packet))
            packetsSent_.fetch_add(1, std::memory_order_relaxed);
    }
}

void NetworkAudioEngine::receiveMain() noexcept {
    std::vector<std::byte> bytes(65536);
    while (running_.load(std::memory_order_acquire)) {
        const auto workGeneration = generation_.load(std::memory_order_acquire);
        const auto count = receiveSocket_.receive(bytes);
        if (count < sizeof(PacketHeader))
            continue;
        if (workGeneration != generation_.load(std::memory_order_acquire)) {
            staleBlocks_.fetch_add(1, std::memory_order_relaxed);
            continue;
        }
        PacketHeader header{};
        std::memcpy(&header, bytes.data(), sizeof(header));
        if (header.magic != Magic || header.channels != channels_ || header.frames == 0)
            continue;
        auto* slot = slotForKey(header.participantKey);
        if (slot == nullptr)
            continue;
        auto samples = codec_.decode(std::span<const std::byte>{
            bytes.data() + static_cast<std::ptrdiff_t>(sizeof(header)), count - sizeof(header)});
        if (samples.size() < static_cast<std::size_t>(header.frames) * channels_)
            continue;
        {
            std::lock_guard lock(slot->jitterMutex);
            slot->jitter.push(
                {header.sequence, header.timestampFrame, header.channels, std::move(samples)});
        }
        packetsReceived_.fetch_add(1, std::memory_order_relaxed);
        while (true) {
            NetworkAudioPacket packet;
            {
                std::lock_guard lock(slot->jitterMutex);
                if (!slot->jitter.pop(packet))
                    break;
            }
            if (workGeneration != generation_.load(std::memory_order_acquire)) {
                staleBlocks_.fetch_add(1, std::memory_order_relaxed);
                break;
            }
            const auto frames = static_cast<std::uint32_t>(packet.samples.size() / channels_);
            if (!slot->queue.push(packet.samples, frames)) {
                slot->queueOverruns.fetch_add(1, std::memory_order_relaxed);
            }
        }
    }
}

NetworkDiagnostics NetworkAudioEngine::diagnostics() const {
    NetworkDiagnostics out;
    out.packetsSent = packetsSent_.load(std::memory_order_relaxed);
    out.packetsReceived = packetsReceived_.load(std::memory_order_relaxed);
    out.droppedSendBlocks = droppedSendBlocks_.load(std::memory_order_relaxed);
    out.staleBlocks = staleBlocks_.load(std::memory_order_relaxed);
    out.sendQueueFillFrames = sendQueue_.availableFrames();
    for (const auto& owned : remote_) {
        const auto& slot = *owned;
        if (!slot.active.load(std::memory_order_acquire))
            continue;
        RemoteParticipantDiagnostics participant;
        participant.participantId = slot.participantId;
        participant.gain = slot.gain.load(std::memory_order_relaxed);
        participant.muted = slot.muted.load(std::memory_order_relaxed);
        participant.level = slot.level.load(std::memory_order_relaxed);
        participant.queueFillFrames = slot.queue.availableFrames();
        participant.decodeUnderruns = slot.decodeUnderruns.load(std::memory_order_relaxed);
        participant.queueOverruns = slot.queueOverruns.load(std::memory_order_relaxed);
        out.receiveQueueOverruns += participant.queueOverruns;
        out.receiveQueueFillFrames += participant.queueFillFrames;
        out.decodeUnderruns += participant.decodeUnderruns;
        {
            std::lock_guard lock(slot.jitterMutex);
            participant.jitter = slot.jitter.snapshot();
        }
        if (participant.jitter.currentTargetPackets > out.jitter.currentTargetPackets)
            out.jitter = participant.jitter;
        out.participants.push_back(std::move(participant));
    }
    return out;
}
