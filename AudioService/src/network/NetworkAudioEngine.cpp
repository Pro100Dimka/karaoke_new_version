#include "network/NetworkAudioEngine.hpp"
#include "network/NetworkPacket.hpp"

#include <algorithm>
#include <chrono>
#include <cmath>
#include <cstring>

namespace {
[[nodiscard]] std::uint64_t steadyMicros() noexcept {
    return static_cast<std::uint64_t>(std::chrono::duration_cast<std::chrono::microseconds>(
                                         std::chrono::steady_clock::now().time_since_epoch())
                                         .count());
}
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
    renderChannels_ = std::clamp(channels, 1U, MaxAudioChannels);
    channels_ = 1;
    queueFrames_ = queueFrames;
    packetFrames_ = packetFrames;
    // Keep the shared-microphone feel: enough headroom for ordinary Internet jitter without the
    // clearly audible 100 ms voice lag that makes two singers fight each other's timing.
    playoutDelayFrames_ = std::max(packetFrames * 3U, sampleRateHz * 30U / 1000U);
    sharedTimeline_.store(false, std::memory_order_relaxed);
    sharedTargetDelayFrames_.store(playoutDelayFrames_, std::memory_order_relaxed);
    sequence_.store(0, std::memory_order_relaxed);
    packetsSent_.store(0, std::memory_order_relaxed);
    packetsReceived_.store(0, std::memory_order_relaxed);
    droppedSendBlocks_.store(0, std::memory_order_relaxed);
    staleBlocks_.store(0, std::memory_order_relaxed);
    generation_.store(generation, std::memory_order_release);
    sendQueue_.prepare(queueFrames, channels);
    nextSendTimestamp_.store(0, std::memory_order_relaxed);
    networkTiming_.reset();
    for (std::size_t index = 0; index < ProbeHistorySize; ++index) {
        sentProbeSequences_[index].store(UINT32_MAX, std::memory_order_relaxed);
        sentProbeMicros_[index].store(0, std::memory_order_relaxed);
    }
    remoteScratch_.assign(static_cast<std::size_t>(MaxBlockFrames) * channels_, 0.0F);
    localScratch_.assign(static_cast<std::size_t>(MaxBlockFrames) * channels_, 0.0F);
    // Local monitoring and solo karaoke never send network voice. Creating Opus here made an
    // otherwise valid system device format (for example 44.1 kHz) prevent the entire audio session
    // from opening. The codec is created only when a room actually starts its send path.
    encoder_.reset();
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
        slot.pendingCompensationFrames.store(0, std::memory_order_relaxed);
        slot.queue.prepare(queueFrames, channels);
        slot.decoder.reset();
        slot.timelineInitialized = false;
        slot.timing.reset();
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
        slot.pendingCompensationFrames.store(0, std::memory_order_release);
        std::lock_guard lock(slot.jitterMutex);
        slot.jitter.reset();
    }
    sendCv_.notify_all();
}

void NetworkAudioEngine::setLocalParticipant(std::string participantId) {
    localParticipantKey_.store(participantKey(participantId), std::memory_order_release);
}
void NetworkAudioEngine::setSessionToken(std::uint64_t token) noexcept {
    sessionToken_.store(token, std::memory_order_release);
}

void NetworkAudioEngine::setSharedTimeline(bool enabled) {
    sharedTimeline_.store(enabled, std::memory_order_release);
    sharedTargetDelayFrames_.store(playoutDelayFrames_, std::memory_order_release);
    sendQueue_.clear();
    nextSendTimestamp_.store(0, std::memory_order_release);
    std::lock_guard remoteLock(remoteMutex_);
    for (auto& owned : remote_) {
        auto& slot = *owned;
        slot.queue.clear();
        slot.pendingCompensationFrames.store(0, std::memory_order_release);
        slot.timelineInitialized = false;
        slot.timing.reset();
        std::lock_guard jitterLock(slot.jitterMutex);
        slot.jitter.reset();
    }
}

bool NetworkAudioEngine::addRemoteParticipant(std::string participantId) {
    std::lock_guard remoteLock(remoteMutex_);
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
        slot.pendingCompensationFrames.store(0, std::memory_order_relaxed);
        // A fresh decoder per join: reusing one across different participants (or a rejoin) would
        // carry stale Opus loss-concealment state into an unrelated stream.
        slot.decoder = std::make_unique<OpusVoiceDecoder>(sampleRateHz_, channels_);
        slot.timelineInitialized = false;
        slot.timing.reset();
        slot.participantKey.store(key, std::memory_order_release);
        slot.active.store(true, std::memory_order_release);
        return true;
    }
    return false;
}

bool NetworkAudioEngine::removeRemoteParticipant(std::string_view participantId) noexcept {
    std::lock_guard remoteLock(remoteMutex_);
    auto* slot = slotForId(participantId);
    if (slot == nullptr)
        return false;
    slot->active.store(false, std::memory_order_release);
    slot->queue.clear();
    slot->pendingCompensationFrames.store(0, std::memory_order_release);
    slot->participantKey.store(0, std::memory_order_release);
    slot->participantId.clear();
    slot->decoder.reset();
    return true;
}

bool NetworkAudioEngine::setRemoteGain(std::string_view participantId, float gain) noexcept {
    std::lock_guard remoteLock(remoteMutex_);
    auto* slot = slotForId(participantId);
    if (slot == nullptr)
        return false;
    slot->gain.store(std::clamp(gain, 0.0F, 4.0F), std::memory_order_relaxed);
    return true;
}

bool NetworkAudioEngine::setRemoteMute(std::string_view participantId, bool muted) noexcept {
    std::lock_guard remoteLock(remoteMutex_);
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
    // The socket was already bound to the local port by startReceive(), which always runs first (see
    // AudioService::handleNetworkControl); connecting it here keeps that same local port for the outbound path.
    if (!encoder_)
        encoder_ = std::make_unique<OpusVoiceEncoder>(sampleRateHz_, channels_);
    socket_.connect(host, port);
    sendEnabled_.store(true, std::memory_order_release);
    running_.store(true, std::memory_order_release);
    if (!sendThread_.joinable())
        sendThread_ = std::thread(&NetworkAudioEngine::sendMain, this);
}
void NetworkAudioEngine::startReceive(std::uint16_t port) {
    socket_.bind(port);
    socket_.setReceiveTimeoutMs(100);
    running_.store(true, std::memory_order_release);
    if (!receiveThread_.joinable())
        receiveThread_ = std::thread(&NetworkAudioEngine::receiveMain, this);
}
void NetworkAudioEngine::stop() noexcept {
    running_.store(false, std::memory_order_release);
    sendEnabled_.store(false, std::memory_order_release);
    sendCv_.notify_all();
    socket_.close();
    if (sendThread_.joinable())
        sendThread_.join();
    if (receiveThread_.joinable())
        receiveThread_.join();
    sendQueue_.clear();
    for (auto& owned : remote_)
        owned->queue.clear();
}
void NetworkAudioEngine::pushLocal(GenerationId generation, std::span<const float> samples,
                                   std::uint32_t frames, std::uint64_t timestampFrame) noexcept {
    if (generation != generation_.load(std::memory_order_acquire)) {
        staleBlocks_.fetch_add(1, std::memory_order_relaxed);
        return;
    }
    if (!running_.load(std::memory_order_acquire) || !sendEnabled_.load(std::memory_order_acquire))
        return;
    const auto sourceSamples = static_cast<std::size_t>(frames) * renderChannels_;
    if (frames > MaxBlockFrames || samples.size() < sourceSamples || localScratch_.size() < frames) {
        droppedSendBlocks_.fetch_add(1, std::memory_order_relaxed);
        return;
    }
    for (std::uint32_t frame = 0; frame < frames; ++frame) {
        float voice = 0.0F;
        const auto offset = static_cast<std::size_t>(frame) * renderChannels_;
        for (std::uint32_t channel = 0; channel < renderChannels_; ++channel)
            voice += samples[offset + channel];
        localScratch_[frame] = voice / static_cast<float>(renderChannels_);
    }
    const auto wasEmpty = sendQueue_.availableFrames() == 0;
    if (!sendQueue_.push(std::span<const float>{localScratch_.data(), frames}, frames)) {
        droppedSendBlocks_.fetch_add(1, std::memory_order_relaxed);
        return;
    }
    if (wasEmpty) {
        const auto timeline = sharedTimeline_.load(std::memory_order_acquire)
                                  ? timestampFrame | SharedAudioTimelineFlag
                                  : timestampFrame;
        nextSendTimestamp_.store(timeline, std::memory_order_release);
    }
    sendCv_.notify_one();
}

std::uint32_t NetworkAudioEngine::renderRemote(GenerationId generation, std::span<float> output,
                                               std::uint32_t frames,
                                               std::uint64_t timelineFrame) noexcept {
    localTimelineFrame_.store(timelineFrame, std::memory_order_release);
    if (generation != generation_.load(std::memory_order_acquire)) {
        staleBlocks_.fetch_add(1, std::memory_order_relaxed);
        return 0;
    }
    const auto sampleCount = static_cast<std::size_t>(frames) * renderChannels_;
    const auto transportSampleCount = static_cast<std::size_t>(frames) * channels_;
    if (frames > MaxBlockFrames || output.size() < sampleCount ||
        remoteScratch_.size() < transportSampleCount)
        return 0;
    std::fill_n(output.data(), sampleCount, 0.0F);
    bool any = false;
    for (auto& owned : remote_) {
        auto& slot = *owned;
        if (!slot.active.load(std::memory_order_acquire))
            continue;
        auto pending = slot.pendingCompensationFrames.load(std::memory_order_acquire);
        std::uint32_t silenceFrames{0};
        while (pending != 0) {
            silenceFrames = std::min(pending, frames);
            if (slot.pendingCompensationFrames.compare_exchange_weak(
                    pending, pending - silenceFrames, std::memory_order_acq_rel,
                    std::memory_order_acquire))
                break;
        }
        const auto silenceSamples = static_cast<std::size_t>(silenceFrames) * channels_;
        std::fill_n(remoteScratch_.data(), silenceSamples, 0.0F);
        const auto wantedFrames = frames - silenceFrames;
        const auto read = wantedFrames == 0
                              ? 0U
                              : slot.queue.pop(
                                    std::span<float>{remoteScratch_.data() + silenceSamples,
                                                     transportSampleCount - silenceSamples},
                                    wantedFrames);
        if (read < wantedFrames) {
            const auto begin = static_cast<std::size_t>(silenceFrames + read) * channels_;
            std::fill(remoteScratch_.begin() + static_cast<std::ptrdiff_t>(begin),
                      remoteScratch_.begin() + static_cast<std::ptrdiff_t>(transportSampleCount),
                      0.0F);
            slot.decodeUnderruns.fetch_add(1, std::memory_order_relaxed);
        }
        if (slot.muted.load(std::memory_order_relaxed))
            continue;
        const auto gain = slot.gain.load(std::memory_order_relaxed);
        float peak = 0.0F;
        for (std::uint32_t frame = 0; frame < frames; ++frame) {
            const auto sample = remoteScratch_[frame] * gain;
            const auto offset = static_cast<std::size_t>(frame) * renderChannels_;
            for (std::uint32_t channel = 0; channel < renderChannels_; ++channel)
                output[offset + channel] += sample;
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
        const auto payload = encoder_->encode(
            std::span<const float>{samples.data(), static_cast<std::size_t>(frames) * channels_},
            frames);
        if (payload.empty())
            continue;
        AudioPacketHeader header{sequence_.fetch_add(1, std::memory_order_relaxed),
                                 localParticipantKey_.load(std::memory_order_relaxed),
                                 sessionToken_.load(std::memory_order_relaxed),
                                 nextSendTimestamp_.fetch_add(frames, std::memory_order_acq_rel),
                                 static_cast<std::uint16_t>(channels_),
                                 static_cast<std::uint16_t>(frames)};
        const auto encodedHeader = encodeAudioPacketHeader(header);
        std::vector<std::byte> packet(AudioPacketHeaderBytes + payload.size());
        std::memcpy(packet.data(), encodedHeader.data(), encodedHeader.size());
        std::memcpy(packet.data() + static_cast<std::ptrdiff_t>(AudioPacketHeaderBytes), payload.data(),
                    payload.size());
        const auto probeIndex = static_cast<std::size_t>(header.sequence) % ProbeHistorySize;
        sentProbeMicros_[probeIndex].store(steadyMicros(), std::memory_order_relaxed);
        sentProbeSequences_[probeIndex].store(header.sequence, std::memory_order_release);
        if (socket_.send(packet))
            packetsSent_.fetch_add(1, std::memory_order_relaxed);
    }
}

void NetworkAudioEngine::receiveMain() noexcept {
    std::vector<std::byte> bytes(65536);
    while (running_.load(std::memory_order_acquire)) {
        const auto workGeneration = generation_.load(std::memory_order_acquire);
        const auto count = socket_.receive(bytes);
        if (count < AudioPacketHeaderBytes)
            continue;
        if (workGeneration != generation_.load(std::memory_order_acquire)) {
            staleBlocks_.fetch_add(1, std::memory_order_relaxed);
            continue;
        }
        AudioPacketHeader header{};
        if (!decodeAudioPacketHeader(std::span<const std::byte>{bytes.data(), count}, header) ||
            header.channels != channels_ || header.frames == 0 || header.frames > packetFrames_)
            continue;
        std::lock_guard remoteLock(remoteMutex_);
        if (header.participantKey == localParticipantKey_.load(std::memory_order_acquire)) {
            const auto probeIndex = static_cast<std::size_t>(header.sequence) % ProbeHistorySize;
            if (sentProbeSequences_[probeIndex].load(std::memory_order_acquire) == header.sequence) {
                const auto sentAt = sentProbeMicros_[probeIndex].load(std::memory_order_relaxed);
                const auto receivedAt = steadyMicros();
                if (sentAt != 0 && receivedAt > sentAt)
                    networkTiming_.noteRoundTrip(static_cast<float>(receivedAt - sentAt) / 1000.0F);
            }
            continue;
        }
        auto* slot = slotForKey(header.participantKey);
        if (slot == nullptr)
            continue;
        const auto mediaTimestampFrame = header.timestampFrame & ~SharedAudioTimelineFlag;
        slot->timing.noteArrival(mediaTimestampFrame, steadyMicros(), sampleRateHz_);
        // Payload stays encoded here; decode happens at pop time below so a detected gap can go
        // through the decoder's own loss concealment instead of silence (matches the runtime-media
        // spec's Packet Receiver -> Jitter Buffer -> Decoder order).
        NetworkAudioPacket incoming{header.sequence, header.timestampFrame, header.channels,
                                    header.frames, {}};
        incoming.payload.assign(bytes.begin() + static_cast<std::ptrdiff_t>(AudioPacketHeaderBytes),
                                bytes.begin() + static_cast<std::ptrdiff_t>(count));
        {
            std::lock_guard lock(slot->jitterMutex);
            slot->jitter.push(std::move(incoming));
        }
        packetsReceived_.fetch_add(1, std::memory_order_relaxed);
        while (true) {
            NetworkAudioPacket packet;
            JitterPopOutcome outcome{};
            std::uint32_t jitterTargetPackets{2};
            {
                std::lock_guard lock(slot->jitterMutex);
                outcome = slot->jitter.pop(packet);
                jitterTargetPackets = slot->jitter.snapshot().currentTargetPackets;
            }
            if (outcome == JitterPopOutcome::Empty)
                break;
            if (workGeneration != generation_.load(std::memory_order_acquire)) {
                staleBlocks_.fetch_add(1, std::memory_order_relaxed);
                break;
            }
            const auto samples = outcome == JitterPopOutcome::Delivered
                                     ? slot->decoder->decode(packet.payload, packet.frames)
                                     : slot->decoder->conceal(packetFrames_);
            if (samples.empty())
                continue;
            auto frames = static_cast<std::uint32_t>(samples.size() / channels_);
            std::size_t sampleOffset = 0;
            const auto measuredTarget =
                slot->timing.snapshot(playoutDelayFrames_, packetFrames_ * 12U, sampleRateHz_)
                    .targetDelayFrames;
            const auto jitterTargetFrames = jitterTargetPackets * packetFrames_;
            auto targetFrames = std::max(measuredTarget, jitterTargetFrames);
            const auto sharedPacket =
                (packet.timestampFrame & SharedAudioTimelineFlag) != 0 &&
                sharedTimeline_.load(std::memory_order_acquire);
            if (sharedPacket && outcome == JitterPopOutcome::Delivered) {
                // Establish the route's offset once, when this participant joins the shared song
                // timeline. Re-measuring it on every packet would mistake a transient media
                // decoder underrun for network latency and permanently ratchet the whole room.
                // Packet-to-packet variation is already handled by AdaptiveJitterBuffer.
                auto common = sharedTargetDelayFrames_.load(std::memory_order_relaxed);
                const auto measuredCandidate = compensatedVoiceTargetFrames(
                    packet.timestampFrame & ~SharedAudioTimelineFlag,
                    localTimelineFrame_.load(std::memory_order_acquire), targetFrames,
                    playoutDelayFrames_, maximumRoomCompensationFrames(sampleRateHz_));
                const auto candidate = sharedCompensationTargetFrames(
                    common, measuredCandidate, slot->timelineInitialized);
                auto previousCommon = common;
                while (common < candidate &&
                       !sharedTargetDelayFrames_.compare_exchange_weak(
                           common, candidate, std::memory_order_release,
                           std::memory_order_relaxed)) {
                    previousCommon = common;
                }
                if (common < candidate) {
                    const auto delta = additionalCompensationFrames(previousCommon, candidate);
                    for (auto& remote : remote_) {
                        auto& participant = *remote;
                        if (participant.active.load(std::memory_order_acquire) &&
                            participant.timelineInitialized) {
                            participant.pendingCompensationFrames.fetch_add(
                                delta, std::memory_order_release);
                        }
                    }
                }
                targetFrames = sharedTargetDelayFrames_.load(std::memory_order_acquire);
            }
            if (!slot->timelineInitialized && outcome == JitterPopOutcome::Delivered) {
                const auto remoteTimestamp = packet.timestampFrame & ~SharedAudioTimelineFlag;
                const auto localTimestamp = localTimelineFrame_.load(std::memory_order_acquire);
                const auto alignment = sharedPacket
                                           ? alignSharedAudioTimeline(
                                                 remoteTimestamp, localTimestamp, targetFrames)
                                           : alignAudioPacketTimeline(
                                                 remoteTimestamp, localTimestamp, targetFrames,
                                                 frames);
                if (alignment.skipFrames >= frames)
                    continue;
                if (alignment.silenceFrames != 0) {
                    const auto silenceFrames = std::min(alignment.silenceFrames, queueFrames_ / 2U);
                    std::vector<float> silence(static_cast<std::size_t>(silenceFrames) * channels_,
                                               0.0F);
                    (void)slot->queue.push(silence, silenceFrames);
                }
                sampleOffset = static_cast<std::size_t>(alignment.skipFrames) * channels_;
                frames -= alignment.skipFrames;
                slot->timelineInitialized = true;
            } else if (slot->timelineInitialized) {
                const auto correction =
                    stabilizeRemoteQueue(slot->queue.availableFrames(), targetFrames, frames);
                const auto expandedFrames = frames + correction.silenceFrames;
                const auto correctedFrames = expandedFrames > correction.skipFrames
                                                 ? expandedFrames - correction.skipFrames
                                                 : 1U;
                if (correctedFrames != frames) {
                    const auto retimed = retimeInterleavedLinear(
                        std::span<const float>{samples.data(), samples.size()}, channels_,
                        correctedFrames);
                    if (!slot->queue.push(retimed, correctedFrames))
                        slot->queueOverruns.fetch_add(1, std::memory_order_relaxed);
                    continue;
                }
            }
            const auto aligned = std::span<const float>{samples.data() + sampleOffset,
                                                        static_cast<std::size_t>(frames) * channels_};
            if (!slot->queue.push(aligned, frames)) {
                slot->queueOverruns.fetch_add(1, std::memory_order_relaxed);
            }
        }
    }
}

NetworkDiagnostics NetworkAudioEngine::diagnostics() const {
    std::lock_guard remoteLock(remoteMutex_);
    NetworkDiagnostics out;
    out.playoutDelayFrames = playoutDelayFrames_;
    out.sharedTargetDelayFrames =
        sharedTargetDelayFrames_.load(std::memory_order_acquire);
    out.sharedTimeline = sharedTimeline_.load(std::memory_order_acquire);
    out.timing = networkTiming_.snapshot(playoutDelayFrames_, packetFrames_ * 12U, sampleRateHz_);
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
        participant.timing =
            slot.timing.snapshot(playoutDelayFrames_, packetFrames_ * 12U, sampleRateHz_);
        if (sharedTimeline_.load(std::memory_order_acquire))
            participant.timing.targetDelayFrames = std::max(
                participant.timing.targetDelayFrames,
                sharedTargetDelayFrames_.load(std::memory_order_acquire));
        participant.timing.roundTripMs = out.timing.roundTripMs;
        if (participant.jitter.currentTargetPackets > out.jitter.currentTargetPackets)
            out.jitter = participant.jitter;
        out.participants.push_back(std::move(participant));
    }
    return out;
}
