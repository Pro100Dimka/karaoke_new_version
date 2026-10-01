#include "network/NetworkAudioEngine.hpp"
#include "network/NetworkPacket.hpp"
#include "network/PcmVoiceCodec.hpp"

#include <algorithm>
#include <chrono>
#include <cmath>
#include <cstring>

namespace {
constexpr std::uint32_t VoiceTransportSampleRateHz = 48'000;
constexpr std::uint32_t VoiceTransportPacketFrames =
    VoiceTransportSampleRateHz / VoicePacketsPerSecond;
constexpr std::uint64_t RoomTargetEpochFrames = VoiceTransportSampleRateHz * 2ULL;
constexpr std::uint64_t RemoteRouteFreshMicros = 1'000'000ULL;
// 10 ms to 60 ms of reorder headroom, whatever the packet length.
constexpr std::uint32_t JitterMinimumPackets = VoicePacketsPerSecond / 100U;
constexpr std::uint32_t JitterMaximumPackets = VoicePacketsPerSecond * 6U / 100U;

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
    struct ParticipantState {
        std::string id;
        float gain;
        bool muted;
        float reverb;
        float echo;
        float delay;
        bool noiseSuppression;
        float octave;
    };
    std::vector<ParticipantState> participants;
    {
        std::lock_guard lock(remoteMutex_);
        for (const auto& owned : remote_) {
            const auto& slot = *owned;
            if (slot.active.load(std::memory_order_acquire)) {
                participants.push_back({slot.participantId,
                                        slot.gain.load(std::memory_order_relaxed),
                                        slot.muted.load(std::memory_order_relaxed),
                                        slot.reverb.load(std::memory_order_relaxed),
                                        slot.echo.load(std::memory_order_relaxed),
                                        slot.delay.load(std::memory_order_relaxed),
                                        slot.noiseSuppression.load(std::memory_order_relaxed),
                                        slot.octave.load(std::memory_order_relaxed)});
            }
        }
    }
    const auto restoreReceive =
        running_.load(std::memory_order_acquire) && receiveThread_.joinable();
    const auto restoreSend = sendEnabled_.load(std::memory_order_acquire);
    const auto restoreSharedTimeline = sharedTimeline_.load(std::memory_order_acquire);
    const auto localPort = localPort_;
    const auto remoteHost = remoteHost_;
    const auto remotePort = remotePort_;
    stop();
    sampleRateHz_ = sampleRateHz;
    renderChannels_ = std::clamp(channels, 1U, MaxAudioChannels);
    channels_ = 1;
    queueFrames_ = queueFrames;
    packetFrames_ = packetFrames;
    // Keep only two packets ready for stable low-latency routes. Network jitter is measured and
    // added by the shared room target below, so a fixed millisecond floor made every singer late
    // even on localhost and other healthy links.
    playoutDelayFrames_ = packetFrames * 2U;
    const auto fixedDelayMicros = roomPlayoutDelayMicros_.load(std::memory_order_relaxed);
    const auto fixedDelayFrames = fixedDelayMicros == 0
                                      ? 0U
                                      : static_cast<std::uint32_t>(scaleFramePosition(
                                            fixedDelayMicros, 1'000'000, sampleRateHz_));
    roomPlayoutDelayFrames_.store(fixedDelayFrames, std::memory_order_relaxed);
    sharedTimeline_.store(restoreSharedTimeline, std::memory_order_relaxed);
    sharedTargetDelayFrames_.store(fixedDelayFrames == 0 ? playoutDelayFrames_ : fixedDelayFrames,
                                   std::memory_order_relaxed);
    advertisedTargetDelayFrames_.store(playoutDelayFrames_, std::memory_order_relaxed);
    sharedTargetEpoch_.store(UINT64_MAX, std::memory_order_relaxed);
    sequence_.store(0, std::memory_order_relaxed);
    packetsSent_.store(0, std::memory_order_relaxed);
    packetsReceived_.store(0, std::memory_order_relaxed);
    relayEchoes_.store(0, std::memory_order_relaxed);
    droppedSendBlocks_.store(0, std::memory_order_relaxed);
    staleBlocks_.store(0, std::memory_order_relaxed);
    generation_.store(generation, std::memory_order_release);
    sendQueue_.prepare(queueFrames, channels_);
    sendBlocks_.resize(queueFrames);
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
        slot.reverb.store(0.0F, std::memory_order_relaxed);
        slot.echo.store(0.0F, std::memory_order_relaxed);
        slot.delay.store(0.0F, std::memory_order_relaxed);
        slot.noiseSuppression.store(false, std::memory_order_relaxed);
        slot.octave.store(0.0F, std::memory_order_relaxed);
        slot.effects.reset();
        slot.level.store(0.0F, std::memory_order_relaxed);
        slot.decodeUnderruns.store(0, std::memory_order_relaxed);
        slot.queueOverruns.store(0, std::memory_order_relaxed);
        slot.alignmentErrorFrames.store(0, std::memory_order_relaxed);
        slot.queue.prepare(queueFrames, channels_);
        slot.voice.prepare(sampleRateHz_);
        slot.decoder.reset();
        slot.pcmLossConcealer.reset();
        slot.timelineInitialized = false;
        slot.timelineExcluded = false;
        slot.recoveryPackets = 0;
        slot.playoutPacketIndex = 0;
        slot.desiredDelayFrames = 0;
        slot.followNeedFrames = 0;
        slot.lateness.reset();
        slot.remoteStreamEpoch = 0;
        slot.receivedSequences.reset();
        slot.lastPacketMicros.store(0, std::memory_order_relaxed);
        slot.timing.reset();
        std::lock_guard lock(slot.jitterMutex);
        slot.jitter.configure(JitterMinimumPackets, JitterMaximumPackets);
        slot.jitter.reset();
    }
    for (const auto& participant : participants) {
        if (addRemoteParticipant(participant.id)) {
            (void)setRemoteGain(participant.id, participant.gain);
            (void)setRemoteMute(participant.id, participant.muted);
            (void)setRemoteEffect(participant.id, "reverb", participant.reverb);
            (void)setRemoteEffect(participant.id, "echo", participant.echo);
            (void)setRemoteEffect(participant.id, "delay", participant.delay);
            (void)setRemoteEffect(participant.id, "noiseSuppression",
                                  participant.noiseSuppression ? 1.0F : 0.0F);
            (void)setRemoteEffect(participant.id, "octave", participant.octave);
        }
    }
    if (restoreReceive)
        startReceive(localPort);
    if (restoreSend)
        startSend(remoteHost, remotePort);
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
    wakeSender();
}

void NetworkAudioEngine::setLocalParticipant(std::string participantId) {
    const auto key = participantKey(participantId);
    localParticipantKey_.store(key, std::memory_order_release);
    const auto now = steadyMicros();
    auto epoch = key ^ static_cast<std::uint32_t>(now) ^ static_cast<std::uint32_t>(now >> 32U);
    if (epoch == 0)
        epoch = 1;
    streamEpoch_.store(epoch, std::memory_order_release);
}
void NetworkAudioEngine::setSessionToken(std::uint64_t token) noexcept {
    sessionToken_.store(token, std::memory_order_release);
}

void NetworkAudioEngine::setRoomClock(std::int64_t serverMicros,
                                      std::int64_t localMicros) noexcept {
    roomClockOffsetMicros_.store(serverMicros - localMicros, std::memory_order_relaxed);
    roomClockConfigured_.store(true, std::memory_order_release);
}

void NetworkAudioEngine::setRoomPlayoutDelay(float milliseconds) noexcept {
    const auto finite = std::isfinite(milliseconds) ? milliseconds : 0.0F;
    const auto clamped = std::clamp(finite, 0.0F, 160.0F);
    const auto micros = static_cast<std::uint32_t>(std::llround(clamped * 1'000.0F));
    const auto frames = sampleRateHz_ == 0 || micros == 0
                            ? 0U
                            : static_cast<std::uint32_t>(
                                  scaleFramePosition(micros, 1'000'000, sampleRateHz_));
    if (followLocked_.load(std::memory_order_relaxed))
        return;
    roomPlayoutDelayMicros_.store(micros, std::memory_order_release);
    roomPlayoutDelayFrames_.store(frames, std::memory_order_release);
    sharedTargetDelayFrames_.store(frames == 0 ? playoutDelayFrames_ : frames,
                                   std::memory_order_release);
}

std::uint64_t NetworkAudioEngine::roomTimelineFrame(MonotonicTicks at,
                                                    std::uint64_t fallback) const noexcept {
    if (!roomClockConfigured_.load(std::memory_order_acquire))
        return fallback;
    const auto offset = roomClockOffsetMicros_.load(std::memory_order_relaxed);
    const auto local = static_cast<std::uint64_t>(std::max<MonotonicTicks>(0, at) / 1000);
    const auto room = offset >= 0
                          ? local + std::min(static_cast<std::uint64_t>(offset), UINT64_MAX - local)
                          : local - std::min(local, static_cast<std::uint64_t>(-offset));
    return scaleFramePosition(room, 1'000'000, sampleRateHz_);
}

void NetworkAudioEngine::setFollowedParticipant(std::string_view participantId,
                                                std::uint32_t minimumDelayMs) noexcept {
    const auto engageFrames = sampleRateHz_ * minimumDelayMs / 1'000U;
    const auto key = participantId.empty() ? 0U : participantKey(participantId);
    // The same leader again (a restored voice session re-sends it) keeps the running follow state.
    if (key == followedKey_.load(std::memory_order_acquire) &&
        engageFrames == followEngageFrames_.load(std::memory_order_acquire))
        return;
    followEngageFrames_.store(engageFrames, std::memory_order_release);
    // A zero minimum follows unconditionally; otherwise the leader's measured delay decides.
    followEngaged_.store(engageFrames == 0, std::memory_order_release);
    followTargetDelayFrames_.store(playoutDelayFrames_, std::memory_order_release);
    followedKey_.store(key, std::memory_order_release);
}

void NetworkAudioEngine::setSharedTimeline(bool enabled) {
    sharedTimeline_.store(enabled, std::memory_order_release);
    const auto fixedDelay = roomPlayoutDelayFrames_.load(std::memory_order_acquire);
    sharedTargetDelayFrames_.store(fixedDelay == 0 ? playoutDelayFrames_ : fixedDelay,
                                   std::memory_order_release);
    advertisedTargetDelayFrames_.store(playoutDelayFrames_, std::memory_order_release);
    sharedTargetEpoch_.store(UINT64_MAX, std::memory_order_relaxed);
    std::lock_guard remoteLock(remoteMutex_);
    for (auto& owned : remote_) {
        auto& slot = *owned;
        slot.queue.clear();
        slot.timelineInitialized = false;
        slot.timelineExcluded = false;
        slot.recoveryPackets = 0;
        slot.playoutPacketIndex = 0;
        slot.desiredDelayFrames = 0;
        slot.followNeedFrames = 0;
        slot.lateness.reset();
        slot.remoteStreamEpoch = 0;
        slot.lastPacketMicros.store(0, std::memory_order_relaxed);
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
        slot.reverb.store(0.0F, std::memory_order_relaxed);
        slot.echo.store(0.0F, std::memory_order_relaxed);
        slot.delay.store(0.0F, std::memory_order_relaxed);
        slot.noiseSuppression.store(false, std::memory_order_relaxed);
        slot.octave.store(0.0F, std::memory_order_relaxed);
        slot.effects = std::make_unique<DspChain>();
        slot.effects->prepare(sampleRateHz_, MaxBlockFrames, channels_);
        slot.effects->setEnabled(true);
        slot.level.store(0.0F, std::memory_order_relaxed);
        slot.decodeUnderruns.store(0, std::memory_order_relaxed);
        slot.queueOverruns.store(0, std::memory_order_relaxed);
        slot.alignmentErrorFrames.store(0, std::memory_order_relaxed);
        slot.lateAudioCuts.store(0, std::memory_order_relaxed);
        slot.relayFirstPackets.store(0, std::memory_order_relaxed);
        slot.directFirstPackets.store(0, std::memory_order_relaxed);
        slot.lastPacketMicros.store(0, std::memory_order_relaxed);
        // A fresh decoder per join: reusing one across different participants (or a rejoin) would
        // carry stale Opus loss-concealment state into an unrelated stream.
        slot.decoder = std::make_unique<OpusVoiceDecoder>(VoiceTransportSampleRateHz, channels_);
        slot.pcmLossConcealer.reset();
        slot.timelineInitialized = false;
        slot.timelineExcluded = false;
        slot.recoveryPackets = 0;
        slot.playoutPacketIndex = 0;
        slot.desiredDelayFrames = 0;
        slot.followNeedFrames = 0;
        slot.lateness.reset();
        slot.timing.reset();
        resetStreamReports(slot);
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
    retireRemoteSlot(*slot);
    return true;
}

void NetworkAudioEngine::clearRemoteParticipants() noexcept {
    std::lock_guard remoteLock(remoteMutex_);
    for (auto& slot : remote_)
        retireRemoteSlot(*slot);
}

void NetworkAudioEngine::resetStreamReports(RemoteSlot& slot) noexcept {
    slot.voice.reset();
    slot.lastCodec = VoiceCodec::Opus;
    slot.lossWindowPackets = 0;
    slot.lossWindowStart = 0;
    slot.lossPermille.store(0, std::memory_order_relaxed);
    slot.reportedLossPermille.store(0, std::memory_order_relaxed);
    slot.reportedAtMicros.store(0, std::memory_order_relaxed);
    slot.serverIngressFrames.store(0, std::memory_order_relaxed);
    slot.serverMixWaitFrames.store(0, std::memory_order_relaxed);
}

void NetworkAudioEngine::retireRemoteSlot(RemoteSlot& slot) noexcept {
    // Render never waits. The control thread drains the old lease before reclaiming
    // DSP state or publishing this slot for another participant.
    slot.active.store(false);
    auto readers = slot.renderReaders.load();
    while (readers != 0) {
        slot.renderReaders.wait(readers);
        readers = slot.renderReaders.load();
    }
    slot.queue.clear();
    slot.participantKey.store(0, std::memory_order_release);
    slot.participantId.clear();
    slot.decoder.reset();
    slot.pcmLossConcealer.reset();
    slot.effects.reset();
    slot.desiredDelayFrames = 0;
    slot.followNeedFrames = 0;
    slot.timelineExcluded = false;
    slot.recoveryPackets = 0;
    slot.lateness.reset();
    slot.remoteStreamEpoch = 0;
    slot.lastPacketMicros.store(0, std::memory_order_relaxed);
    resetStreamReports(slot);
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

bool NetworkAudioEngine::setRemoteEffect(std::string_view participantId, std::string_view effect,
                                         float value) noexcept {
    std::lock_guard remoteLock(remoteMutex_);
    auto* slot = slotForId(participantId);
    if (slot == nullptr)
        return false;
    if (effect == "reverb") {
        value = std::clamp(value, 0.0F, 1.0F);
        slot->reverb.store(value, std::memory_order_relaxed);
        return slot->effects->setParameter("reverb.mix", value);
    }
    if (effect == "echo") {
        value = std::clamp(value, 0.0F, 0.95F);
        slot->echo.store(value, std::memory_order_relaxed);
        return slot->effects->setParameter("echo.amount", value);
    }
    if (effect == "delay") {
        value = std::clamp(value, 0.0F, 1.0F);
        slot->delay.store(value, std::memory_order_relaxed);
        return slot->effects->setParameter("delay.mix", value) &&
               slot->effects->setParameter("delay.ms", 25.0F + value * 475.0F);
    }
    if (effect == "noiseSuppression") {
        const auto enabled = value >= 0.5F;
        slot->noiseSuppression.store(enabled, std::memory_order_relaxed);
        return slot->effects->setParameter("noise.amount", enabled ? 1.0F : 0.0F);
    }
    if (effect == "octave") {
        value = std::clamp(std::round(value), -1.0F, 1.0F);
        slot->octave.store(value, std::memory_order_relaxed);
        return slot->effects->setParameter("pitch.semitones", value * 12.0F);
    }
    if (effect == "autoTune") {
        value = std::clamp(value, 0.0F, 1.0F);
        return slot->effects->setParameter("autotune.amount", value);
    }
    return false;
}

bool NetworkAudioEngine::setDirectPeer(std::string participantId, std::string host,
                                       std::uint16_t port, std::uint64_t receiveToken) {
    if (participantId.empty() || host.empty() || port == 0 || receiveToken == 0)
        return false;
    std::lock_guard lock(directPeersMutex_);
    const auto existing = std::ranges::find_if(
        directPeers_, [&](const auto& peer) { return peer.participantId == participantId; });
    const DirectPeer replacement{std::move(participantId), std::move(host), port, receiveToken};
    if (existing == directPeers_.end()) {
        if (directPeers_.size() >= MaxRemoteParticipants)
            return false;
        directPeers_.push_back(replacement);
    } else {
        *existing = replacement;
    }
    return true;
}

void NetworkAudioEngine::clearDirectPeers() noexcept {
    std::lock_guard lock(directPeersMutex_);
    directPeers_.clear();
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
    // The socket was already bound to the local port by startReceive(), which always runs first
    // (see AudioService::handleNetworkControl); connecting it here keeps that same local port for
    // the outbound path.
    if (sendEnabled_.load(std::memory_order_acquire) && remoteHost_ == host && remotePort_ == port)
        return;
    if (sendEnabled_.load(std::memory_order_acquire)) {
        const auto receivePort = localPort_;
        stop();
        startReceive(receivePort);
    }
    if (!encoder_)
        encoder_ = std::make_unique<OpusVoiceEncoder>(VoiceTransportSampleRateHz, channels_);
    socket_.connect(host, port);
    remoteHost_ = host;
    remotePort_ = port;
    sendEnabled_.store(true, std::memory_order_release);
    running_.store(true, std::memory_order_release);
    if (!sendThread_.joinable())
        sendThread_ = std::thread(&NetworkAudioEngine::sendMain, this);
}
void NetworkAudioEngine::startReceive(std::uint16_t port) {
    if (running_.load(std::memory_order_acquire) && receiveThread_.joinable() && localPort_ == port)
        return;
    if (receiveThread_.joinable())
        stop();
    socket_.bind(port);
    socket_.setReceiveTimeoutMs(100);
    localPort_ = socket_.localPort();
    running_.store(true, std::memory_order_release);
    if (!receiveThread_.joinable())
        receiveThread_ = std::thread(&NetworkAudioEngine::receiveMain, this);
}
void NetworkAudioEngine::stop() noexcept {
    running_.store(false, std::memory_order_release);
    sendEnabled_.store(false, std::memory_order_release);
    for (auto count = sendProducers_.load(); count != 0; count = sendProducers_.load())
        sendProducers_.wait(count);
    wakeSender();
    socket_.close();
    if (sendThread_.joinable())
        sendThread_.join();
    if (receiveThread_.joinable())
        receiveThread_.join();
    sendQueue_.clear();
    sendBlockWrite_.store(0, std::memory_order_relaxed);
    sendBlockRead_.store(0, std::memory_order_relaxed);
    publishedSendFrames_.store(0, std::memory_order_relaxed);
    for (auto& owned : remote_)
        owned->queue.clear();
}
void NetworkAudioEngine::pushLocal(GenerationId generation, std::span<const float> samples,
                                   std::uint32_t frames, std::uint64_t timestampFrame,
                                   float gain) noexcept {
    sendProducers_.fetch_add(1);
    struct ProducerLease {
        NetworkAudioEngine& engine;
        ~ProducerLease() {
            if (engine.sendProducers_.fetch_sub(1) == 1 && !engine.running_.load())
                engine.sendProducers_.notify_all();
        }
    } lease{*this};
    if (generation != generation_.load(std::memory_order_acquire)) {
        staleBlocks_.fetch_add(1, std::memory_order_relaxed);
        return;
    }
    if (!running_.load(std::memory_order_acquire) || !sendEnabled_.load(std::memory_order_acquire))
        return;
    const auto sourceSamples = static_cast<std::size_t>(frames) * renderChannels_;
    if (frames > MaxBlockFrames || samples.size() < sourceSamples ||
        localScratch_.size() < frames) {
        droppedSendBlocks_.fetch_add(1, std::memory_order_relaxed);
        return;
    }
    for (std::uint32_t frame = 0; frame < frames; ++frame) {
        float voice = 0.0F;
        const auto offset = static_cast<std::size_t>(frame) * renderChannels_;
        for (std::uint32_t channel = 0; channel < renderChannels_; ++channel)
            voice += samples[offset + channel];
        localScratch_[frame] = voice * gain / static_cast<float>(renderChannels_);
    }
    if (frames == 0)
        return;
    if (generation != sendTimelineGeneration_) {
        sendTimeline_.reset();
        sendTimelineGeneration_ = generation;
    }
    timestampFrame = sendTimeline_.stamp(timestampFrame, frames, sampleRateHz_);
    const auto write = sendBlockWrite_.load(std::memory_order_relaxed);
    if (write - sendBlockRead_.load(std::memory_order_acquire) >= sendBlocks_.size() ||
        !sendQueue_.push(std::span<const float>{localScratch_.data(), frames}, frames)) {
        droppedSendBlocks_.fetch_add(1, std::memory_order_relaxed);
        return;
    }
    sendBlocks_[write % sendBlocks_.size()] = {timestampFrame, frames};
    sendBlockWrite_.store(write + 1, std::memory_order_release);
    publishedSendFrames_.fetch_add(frames, std::memory_order_release);
    wakeSender();
}

std::uint32_t NetworkAudioEngine::renderRemote(GenerationId generation, std::span<float> output,
                                               std::uint32_t frames,
                                               std::uint64_t timelineFrame) noexcept {
    // The next remote sample taken from a queue is presented after this whole block, so that
    // is the position arriving packets and queue targets are measured against.
    localTimelineFrame_.store(timelineFrame + frames, std::memory_order_release);
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
        slot.renderReaders.fetch_add(1);
        struct RenderLease {
            RemoteSlot& slot;
            ~RenderLease() {
                if (slot.renderReaders.fetch_sub(1) == 1)
                    slot.renderReaders.notify_one();
            }
        } lease{slot};
        if (!slot.active.load())
            continue;
        const auto read =
            slot.queue.pop(std::span<float>{remoteScratch_.data(), transportSampleCount}, frames);
        if (read < frames) {
            const auto begin = static_cast<std::size_t>(read) * channels_;
            std::fill(remoteScratch_.begin() + static_cast<std::ptrdiff_t>(begin),
                      remoteScratch_.begin() + static_cast<std::ptrdiff_t>(transportSampleCount),
                      0.0F);
            slot.decodeUnderruns.fetch_add(1, std::memory_order_relaxed);
        }
        if (slot.muted.load(std::memory_order_relaxed))
            continue;
        slot.effects->process(std::span<float>{remoteScratch_.data(), transportSampleCount},
                              frames);
        slot.voice.note(std::span<const float>{remoteScratch_.data(), transportSampleCount},
                        channels_, frames);
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

void NetworkAudioEngine::wakeSender() noexcept {
    sendWakeSequence_.fetch_add(1, std::memory_order_release);
    sendWakeSequence_.notify_one();
}

std::optional<std::uint32_t>
NetworkAudioEngine::worstListenerLossPermille(std::uint64_t nowMicros) const noexcept {
    // A report older than this no longer describes the connection.
    constexpr std::uint64_t ReportFreshMicros = 3'000'000;
    std::optional<std::uint32_t> worst;
    for (const auto& owned : remote_) {
        const auto& slot = *owned;
        if (!slot.active.load(std::memory_order_acquire))
            continue;
        const auto reportedAt = slot.reportedAtMicros.load(std::memory_order_acquire);
        if (reportedAt == 0 || nowMicros - std::min(nowMicros, reportedAt) > ReportFreshMicros)
            return std::nullopt;
        worst =
            std::max(worst.value_or(0U), slot.reportedLossPermille.load(std::memory_order_relaxed));
    }
    return worst;
}

void NetworkAudioEngine::sendMain() noexcept {
    std::vector<float> deviceSamples(
        static_cast<std::size_t>((sampleRateHz_ + VoicePacketsPerSecond - 1U) /
                                 VoicePacketsPerSecond) *
        channels_);
    std::uint64_t packetIndex = 0;
    std::uint64_t consumedFrames = 0;
    std::uint32_t blockOffset = 0;
    std::size_t reportCursor = 0;
    codecPolicy_.reset();
    for (;;) {
        const auto sequence = sendWakeSequence_.load(std::memory_order_acquire);
        if (!running_.load(std::memory_order_acquire) ||
            !sendEnabled_.load(std::memory_order_acquire))
            break;
        const auto wantedFrames = deviceFramesForVoicePacket(packetIndex, sampleRateHz_);
        if (publishedSendFrames_.load(std::memory_order_acquire) - consumedFrames < wantedFrames) {
            sendWakeSequence_.wait(sequence, std::memory_order_acquire);
            continue;
        }
        if (!running_.load(std::memory_order_acquire) ||
            !sendEnabled_.load(std::memory_order_acquire))
            break;
        const auto workGeneration = generation_.load(std::memory_order_acquire);
        const auto frames = sendQueue_.pop(deviceSamples, wantedFrames);
        if (frames == 0)
            continue;
        auto read = sendBlockRead_.load(std::memory_order_relaxed);
        const auto nowMicros = steadyMicros();
        // The Room Server combines shared-timeline voices itself, so it must receive samples it
        // can decode without participant-specific Opus state. Non-room transport keeps the
        // adaptive codec policy.
        const auto sharedTimeline = sharedTimeline_.load(std::memory_order_acquire);
        const auto codec = sharedTimeline
                               ? VoiceCodec::Pcm16
                               : codecPolicy_.step(worstListenerLossPermille(nowMicros), nowMicros);
        sendCodec_.store(codec, std::memory_order_relaxed);
        // The decoded voice trails its input by the codec delay, so it is stamped that much
        // earlier.
        const auto codecDelayFrames = codec == VoiceCodec::Opus ? encoder_->lookaheadFrames() : 0U;
        const auto mediaTimestamp =
            (scaleFramePosition(sendBlocks_[read % sendBlocks_.size()].timestampFrame + blockOffset,
                                sampleRateHz_, VoiceTransportSampleRateHz) -
             codecDelayFrames) &
            MediaTimelineMask;
        for (auto remaining = frames; remaining != 0;) {
            const auto count =
                std::min(remaining, sendBlocks_[read % sendBlocks_.size()].frames - blockOffset);
            remaining -= count;
            blockOffset += count;
            if (blockOffset == sendBlocks_[read % sendBlocks_.size()].frames) {
                ++read;
                blockOffset = 0;
            }
        }
        sendBlockRead_.store(read, std::memory_order_release);
        consumedFrames += frames;
        if (workGeneration != generation_.load(std::memory_order_acquire)) {
            staleBlocks_.fetch_add(1, std::memory_order_relaxed);
            continue;
        }
        const auto transportSamples = retimeInterleavedLinear(
            std::span<const float>{deviceSamples.data(),
                                   static_cast<std::size_t>(frames) * channels_},
            channels_, VoiceTransportPacketFrames);
        ++packetIndex;
        const auto payload = codec == VoiceCodec::Opus
                                 ? encoder_->encode(transportSamples, VoiceTransportPacketFrames)
                                 : PcmVoiceCodec::encode(transportSamples);
        if (payload.empty())
            continue;
        // Each packet reports on the next listened-to participant in turn.
        std::uint32_t reportedKey = 0;
        std::uint32_t reportedLoss = 0;
        for (std::size_t step = 0; step < remote_.size(); ++step) {
            const auto& slot = *remote_[(reportCursor + step) % remote_.size()];
            if (!slot.active.load(std::memory_order_acquire))
                continue;
            reportedKey = slot.participantKey.load(std::memory_order_acquire);
            reportedLoss = slot.lossPermille.load(std::memory_order_relaxed);
            reportCursor = (reportCursor + step + 1U) % remote_.size();
            break;
        }
        AudioPacketHeader header{sequence_.fetch_add(1, std::memory_order_relaxed),
                                 localParticipantKey_.load(std::memory_order_relaxed),
                                 sessionToken_.load(std::memory_order_relaxed),
                                 sharedTimeline ? mediaTimestamp | SharedAudioTimelineFlag
                                                : mediaTimestamp,
                                 static_cast<std::uint16_t>(channels_),
                                 static_cast<std::uint16_t>(VoiceTransportPacketFrames),
                                 reportedKey,
                                 streamEpoch_.load(std::memory_order_acquire),
                                 codec,
                                 static_cast<std::uint16_t>(reportedLoss)};
        const auto encodedHeader = encodeAudioPacketHeader(header);
        std::vector<std::byte> packet(AudioPacketHeaderBytes + payload.size());
        std::memcpy(packet.data(), encodedHeader.data(), encodedHeader.size());
        std::memcpy(packet.data() + static_cast<std::ptrdiff_t>(AudioPacketHeaderBytes),
                    payload.data(), payload.size());
        const auto probeIndex = static_cast<std::size_t>(header.sequence) % ProbeHistorySize;
        sentProbeMicros_[probeIndex].store(steadyMicros(), std::memory_order_relaxed);
        sentProbeSequences_[probeIndex].store(header.sequence, std::memory_order_release);
        bool sent = false;
        const auto copies = sharedTimeline ? 2U : 1U;
        for (std::uint32_t copy = 0; copy < copies; ++copy)
            sent = socket_.send(packet) || sent;
        if (sent)
            packetsSent_.fetch_add(1, std::memory_order_relaxed);
        std::lock_guard peerLock(directPeersMutex_);
        for (const auto& peer : directPeers_) {
            auto directHeader = header;
            directHeader.sessionToken = peer.receiveToken;
            const auto directEncodedHeader = encodeAudioPacketHeader(directHeader);
            std::memcpy(packet.data(), directEncodedHeader.data(), directEncodedHeader.size());
            (void)socket_.sendTo(peer.host, peer.port, packet);
        }
    }
}

void NetworkAudioEngine::receiveMain() noexcept {
    std::vector<std::byte> bytes(65536);
    while (running_.load(std::memory_order_acquire)) {
        const auto workGeneration = generation_.load(std::memory_order_acquire);
        const auto count = socket_.receive(bytes);
        const auto viaRelay = socket_.lastFromDefaultPeer();
        if (count < AudioPacketHeaderBytes)
            continue;
        if (workGeneration != generation_.load(std::memory_order_acquire)) {
            staleBlocks_.fetch_add(1, std::memory_order_relaxed);
            continue;
        }
        AudioPacketHeader header{};
        if (!decodeAudioPacketHeader(std::span<const std::byte>{bytes.data(), count}, header) ||
            !audioPacketBelongsToSession(header, sessionToken_.load(std::memory_order_acquire),
                                         channels_))
            continue;
        std::lock_guard remoteLock(remoteMutex_);
        if (header.participantKey == localParticipantKey_.load(std::memory_order_acquire)) {
            relayEchoes_.fetch_add(1, std::memory_order_relaxed);
            const auto probeIndex = static_cast<std::size_t>(header.sequence) % ProbeHistorySize;
            if (sentProbeSequences_[probeIndex].load(std::memory_order_acquire) ==
                header.sequence) {
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
        if (slot->remoteStreamEpoch != header.streamEpoch) {
            slot->queue.clear();
            slot->decoder =
                std::make_unique<OpusVoiceDecoder>(VoiceTransportSampleRateHz, channels_);
            slot->pcmLossConcealer.reset();
            slot->timelineInitialized = false;
            slot->timelineExcluded = false;
            slot->recoveryPackets = 0;
            slot->playoutPacketIndex = 0;
            slot->desiredDelayFrames = 0;
            slot->followNeedFrames = 0;
            slot->lateness.reset();
            slot->receivedSequences.reset();
            slot->timing.reset();
            slot->lossWindowPackets = 0; // the jitter counters below restart from zero
            slot->lossWindowStart = 0;
            std::lock_guard jitterLock(slot->jitterMutex);
            slot->jitter.reset();
            slot->remoteStreamEpoch = header.streamEpoch;
        }
        const auto serverMix = slot->participantId == "__room_server_mix__";
        if (serverMix) {
            const auto stage = decodeServerMixStageReport(
                header.reportedParticipantKey |
                (static_cast<std::uint32_t>(header.reportedLossPermille) << 24U));
            slot->serverIngressFrames.store(stage.ingressFrames, std::memory_order_relaxed);
            slot->serverMixWaitFrames.store(stage.collectionFrames, std::memory_order_relaxed);
        } else if (header.reportedParticipantKey ==
            (localParticipantKey_.load(std::memory_order_acquire) & ReportKeyMask)) {
            slot->reportedLossPermille.store(header.reportedLossPermille,
                                             std::memory_order_relaxed);
            slot->reportedAtMicros.store(steadyMicros(), std::memory_order_release);
        }
        // Direct P2P and relay fallback intentionally carry the same sequence. Whichever arrives
        // first wins; the later copy must not look like jitter/packet loss and inflate room delay.
        if (slot->receivedSequences.isDuplicate(header.sequence))
            continue;
        (viaRelay ? slot->relayFirstPackets : slot->directFirstPackets)
            .fetch_add(1, std::memory_order_relaxed);
        slot->lastPacketMicros.store(steadyMicros(), std::memory_order_relaxed);
        const auto mediaTimestampFrame = header.timestampFrame & ~SharedAudioTimelineFlag;
        const auto isSharedTimelinePacket =
            (header.timestampFrame & SharedAudioTimelineFlag) != 0 &&
            sharedTimeline_.load(std::memory_order_acquire);
        const auto arrivalMicros =
            isSharedTimelinePacket
                ? scaleFramePosition(localTimelineFrame_.load(std::memory_order_acquire),
                                     sampleRateHz_, 1'000'000)
                : steadyMicros();
        slot->timing.noteArrival(mediaTimestampFrame, arrivalMicros, VoiceTransportSampleRateHz);
        if (isSharedTimelinePacket) {
            const auto arrivalTransportFrame =
                scaleFramePosition(localTimelineFrame_.load(std::memory_order_acquire),
                                   sampleRateHz_, VoiceTransportSampleRateHz);
            slot->lateness.note(
                signedMediaTimelineDistance(mediaTimestampFrame, arrivalTransportFrame));
        }
        // Payload stays encoded here; decode happens at pop time below so a detected gap can go
        // through the decoder's own loss concealment instead of silence (matches the runtime-media
        // spec's Packet Receiver -> Jitter Buffer -> Decoder order).
        NetworkAudioPacket incoming{
            header.sequence, header.timestampFrame, header.channels, header.frames, {},
            header.codec};
        incoming.payload.assign(bytes.begin() + static_cast<std::ptrdiff_t>(AudioPacketHeaderBytes),
                                bytes.begin() + static_cast<std::ptrdiff_t>(count));
        {
            std::lock_guard lock(slot->jitterMutex);
            slot->jitter.push(std::move(incoming));
            // One window per second of packets: the share this sender's stream lost or had late.
            if (++slot->lossWindowPackets >= VoicePacketsPerSecond) {
                const auto snapshot = slot->jitter.snapshot();
                const auto missed = snapshot.lostPackets + snapshot.latePackets;
                const auto windowMissed = missed - std::min(missed, slot->lossWindowStart);
                slot->lossPermille.store(
                    static_cast<std::uint32_t>(std::min<std::uint64_t>(
                        1'000U, windowMissed * 1'000U / (slot->lossWindowPackets + windowMissed))),
                    std::memory_order_relaxed);
                slot->lossWindowPackets = 0;
                slot->lossWindowStart = missed;
            }
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
            if (outcome == JitterPopOutcome::Delivered)
                slot->lastCodec = packet.codec;
            const auto pcm = slot->lastCodec == VoiceCodec::Pcm16;
            // PCM keeps no history to conceal a gap from: a lost PCM packet is silence.
            auto decoded =
                outcome == JitterPopOutcome::Delivered
                    ? (pcm ? PcmVoiceCodec::decode(packet.payload,
                                                   static_cast<std::size_t>(packet.frames) *
                                                       channels_)
                           : slot->decoder->decode(packet.payload, packet.frames))
                    : (pcm ? slot->pcmLossConcealer.conceal(VoiceTransportPacketFrames, channels_)
                           : slot->decoder->conceal(VoiceTransportPacketFrames));
            if (decoded.empty())
                continue;
            if (pcm) {
                if (outcome == JitterPopOutcome::Delivered)
                    slot->pcmLossConcealer.smoothRecovery(decoded, channels_);
                slot->pcmLossConcealer.remember(decoded, channels_);
            }
            auto frames = deviceFramesForVoicePacket(slot->playoutPacketIndex++, sampleRateHz_);
            auto samples = retimeInterleavedLinear(decoded, channels_, frames);
            std::size_t sampleOffset = 0;
            const auto measuredTarget =
                slot->timing.snapshot(playoutDelayFrames_, packetFrames_ * 12U, sampleRateHz_)
                    .targetDelayFrames;
            const auto jitterTargetFrames = jitterTargetPackets * packetFrames_;
            auto targetFrames = std::max(measuredTarget, jitterTargetFrames);
            const auto sharedPacket = (packet.timestampFrame & SharedAudioTimelineFlag) != 0 &&
                                      sharedTimeline_.load(std::memory_order_acquire);
            if (sharedPacket && slot->timelineExcluded) {
                const auto fixedTarget = roomPlayoutDelayFrames_.load(std::memory_order_acquire);
                const auto latestTransport =
                    static_cast<std::uint64_t>(std::max<std::int64_t>(
                        0, slot->lateness.latestFrames()));
                const auto latestNeed = roomPlayoutTargetFrames(
                    static_cast<std::uint32_t>(scaleFramePosition(
                        latestTransport, VoiceTransportSampleRateHz, sampleRateHz_)),
                    static_cast<std::uint32_t>(
                        scaleFramePosition(RoomPlayoutGuardMicros, 1'000'000, sampleRateHz_)),
                    playoutDelayFrames_, fixedTarget);
                constexpr std::uint32_t RecoveryPackets = VoicePacketsPerSecond / 2U;
                if (outcome == JitterPopOutcome::Delivered && fixedTarget != 0 &&
                    latestNeed < fixedTarget) {
                    ++slot->recoveryPackets;
                } else {
                    slot->recoveryPackets = 0;
                }
                if (slot->recoveryPackets < RecoveryPackets)
                    continue;
                slot->timelineExcluded = false;
                slot->recoveryPackets = 0;
                slot->lateness.reset();
                slot->queue.clear();
                slot->timelineInitialized = false;
            }
            if (sharedPacket && outcome == JitterPopOutcome::Delivered) {
                // All active singers share the slowest measured route. Increases are packet-bounded
                // and decreases are released much more slowly, so a transient spike cannot create a
                // permanent latency ratchet or an abrupt jump in the voices already playing.
                const auto localTransportFrame =
                    scaleFramePosition(localTimelineFrame_.load(std::memory_order_acquire),
                                       sampleRateHz_, VoiceTransportSampleRateHz);
                const auto maximumDelayFrames = maximumInteractiveRoomDelayFrames(
                    queueFrames_, packetFrames_, sampleRateHz_, playoutDelayFrames_);
                // The measured arrival lateness already contains the singer's capture path, the
                // network route actually used (direct or relay) and this listener's output path.
                const auto needFrames = [&](std::uint32_t latenessFrames) {
                    return roomPlayoutTargetFrames(
                        static_cast<std::uint32_t>(scaleFramePosition(
                            latenessFrames, VoiceTransportSampleRateHz, sampleRateHz_)),
                        static_cast<std::uint32_t>(
                            scaleFramePosition(RoomPlayoutGuardMicros, 1'000'000, sampleRateHz_)),
                        playoutDelayFrames_, maximumDelayFrames);
                };
                slot->desiredDelayFrames = needFrames(slot->lateness.targetFrames());
                slot->followNeedFrames = needFrames(slot->lateness.followFrames());
                auto localDesired = playoutDelayFrames_;
                const auto routeFreshAtMicros = steadyMicros();
                for (const auto& remote : remote_) {
                    const auto& participant = *remote;
                    const auto lastPacketMicros =
                        participant.lastPacketMicros.load(std::memory_order_relaxed);
                    if (participant.active.load(std::memory_order_acquire) &&
                        lastPacketMicros != 0 && routeFreshAtMicros >= lastPacketMicros &&
                        routeFreshAtMicros - lastPacketMicros <= RemoteRouteFreshMicros)
                        localDesired = std::max(localDesired, participant.desiredDelayFrames);
                }
                const auto localAdvertised = adaptSharedCompensationFrames(
                    advertisedTargetDelayFrames_.load(std::memory_order_acquire), localDesired,
                    playoutDelayFrames_, maximumDelayFrames, packetFrames_);
                advertisedTargetDelayFrames_.store(localAdvertised, std::memory_order_release);
                const auto fixedRoomTarget = roomPlayoutDelayFrames_.load(std::memory_order_acquire);
                if (fixedRoomTarget != 0) {
                    targetFrames = fixedRoomTarget;
                    sharedTargetDelayFrames_.store(fixedRoomTarget, std::memory_order_release);
                } else {
                    const auto targetEpoch = localTransportFrame / RoomTargetEpochFrames;
                    auto desiredCommon = localAdvertised;
                    if (sharedTargetEpoch_.load(std::memory_order_acquire) == targetEpoch) {
                        desiredCommon = std::max(
                            desiredCommon, sharedTargetDelayFrames_.load(std::memory_order_acquire));
                    }
                    // Before the room server publishes a target, measure the slowest fresh inbound
                    // route. The renderer reports this candidate so the server can choose one
                    // deadline for every participant before playback starts.
                    const auto candidate =
                        std::clamp(desiredCommon, playoutDelayFrames_, maximumDelayFrames);
                    sharedTargetDelayFrames_.store(candidate, std::memory_order_release);
                    sharedTargetEpoch_.store(targetEpoch, std::memory_order_release);
                    targetFrames = candidate;
                }
                if (fixedRoomTarget == 0 &&
                    slot->participantKey.load(std::memory_order_relaxed) ==
                    followedKey_.load(std::memory_order_acquire)) {
                    // The leader's voice keeps its own delay: the song is shifted by exactly it.
                    // A song underway keeps its shift and mode; late leader packets are cut
                    // instead.
                    if (followLocked_.load(std::memory_order_relaxed)) {
                        targetFrames = followTargetDelayFrames_.load(std::memory_order_acquire);
                    } else {
                        targetFrames = adaptSharedCompensationFrames(
                            followTargetDelayFrames_.load(std::memory_order_acquire),
                            slot->followNeedFrames, playoutDelayFrames_, maximumDelayFrames,
                            packetFrames_);
                        // Two seconds above the limit before a follower shifts its song.
                        constexpr std::uint32_t FollowSustainPackets = 2U * VoicePacketsPerSecond;
                        const auto engageFrames =
                            followEngageFrames_.load(std::memory_order_acquire);
                        const auto decision = stepRoomFollow(
                            {followEngaged_.load(std::memory_order_acquire), followPacketsAbove_},
                            targetFrames, engageFrames,
                            engageFrames == 0 ? 0U : FollowSustainPackets);
                        followPacketsAbove_ = decision.packetsAbove;
                        followEngaged_.store(decision.engaged, std::memory_order_release);
                    }
                    followTargetDelayFrames_.store(targetFrames, std::memory_order_release);
                }
            }
            // Full synchrony is the invariant: a sample which cannot meet the bounded room
            // deadline is never moved to a later beat. Clearing the stale queue also lets the
            // stream rejoin immediately when a later packet again fits the current timeline.
            const auto followed = slot->participantKey.load(std::memory_order_relaxed) ==
                                  followedKey_.load(std::memory_order_acquire);
            const auto beyondCeiling =
                sharedPacket &&
                (followed ? slot->followNeedFrames : slot->desiredDelayFrames) >=
                    maximumInteractiveRoomDelayFrames(queueFrames_, packetFrames_, sampleRateHz_,
                                                      playoutDelayFrames_);
            if (beyondCeiling) {
                slot->lateAudioCuts.fetch_add(1, std::memory_order_relaxed);
                slot->queue.clear();
                slot->timelineInitialized = false;
                slot->timelineExcluded = true;
                slot->recoveryPackets = 0;
                continue;
            }
            if (!slot->timelineInitialized && outcome == JitterPopOutcome::Delivered) {
                const auto remoteTimestamp = packet.timestampFrame & ~SharedAudioTimelineFlag;
                const auto localTimestamp =
                    scaleFramePosition(localTimelineFrame_.load(std::memory_order_acquire),
                                       sampleRateHz_, VoiceTransportSampleRateHz);
                const auto transportTargetFrames = static_cast<std::uint32_t>(
                    scaleFramePosition(targetFrames, sampleRateHz_, VoiceTransportSampleRateHz));
                const auto alignment =
                    sharedPacket ? alignSharedAudioTimeline(remoteTimestamp, localTimestamp,
                                                            transportTargetFrames)
                                 : alignAudioPacketTimeline(remoteTimestamp, localTimestamp,
                                                            targetFrames, frames);
                const auto deviceAlignment =
                    sharedPacket
                        ? AudioTimelineAlignment{static_cast<std::uint32_t>(scaleFramePosition(
                                                     alignment.silenceFrames,
                                                     VoiceTransportSampleRateHz, sampleRateHz_)),
                                                 static_cast<std::uint32_t>(scaleFramePosition(
                                                     alignment.skipFrames,
                                                     VoiceTransportSampleRateHz, sampleRateHz_))}
                        : alignment;
                if (deviceAlignment.skipFrames >= frames)
                    continue;
                if (deviceAlignment.silenceFrames != 0) {
                    const auto silenceFrames =
                        std::min(deviceAlignment.silenceFrames, queueFrames_ / 2U);
                    std::vector<float> silence(static_cast<std::size_t>(silenceFrames) * channels_,
                                               0.0F);
                    (void)slot->queue.push(silence, silenceFrames);
                }
                const auto skipFrames = deviceAlignment.skipFrames;
                sampleOffset = static_cast<std::size_t>(skipFrames) * channels_;
                frames -= skipFrames;
                slot->timelineInitialized = true;
                slot->alignmentErrorFrames.store(0, std::memory_order_relaxed);
            } else if (slot->timelineInitialized) {
                const auto currentQueueFrames = slot->queue.availableFrames();
                std::int64_t dueInFrames = targetFrames;
                const auto onRoomTimeline = sharedPacket;
                if (onRoomTimeline && outcome == JitterPopOutcome::Delivered) {
                    const auto localTransportFrame =
                        scaleFramePosition(localTimelineFrame_.load(std::memory_order_acquire),
                                           sampleRateHz_, VoiceTransportSampleRateHz);
                    const auto playoutTransportFrame =
                        addMediaTimelineFrames(packet.timestampFrame & ~SharedAudioTimelineFlag,
                                               scaleFramePosition(targetFrames, sampleRateHz_,
                                                                  VoiceTransportSampleRateHz));
                    const auto dueTransport =
                        signedMediaTimelineDistance(localTransportFrame, playoutTransportFrame);
                    const auto dueMagnitude = static_cast<std::int64_t>(
                        scaleFramePosition(static_cast<std::uint64_t>(std::llabs(dueTransport)),
                                           VoiceTransportSampleRateHz, sampleRateHz_));
                    dueInFrames = dueTransport < 0 ? -dueMagnitude : dueMagnitude;
                }
                const auto queueTargetFrames =
                    static_cast<std::uint32_t>(std::max<std::int64_t>(0, dueInFrames));
                slot->alignmentErrorFrames.store(static_cast<std::int32_t>(currentQueueFrames) -
                                                     static_cast<std::int32_t>(queueTargetFrames),
                                                 std::memory_order_relaxed);
                const auto lateFrames =
                    onRoomTimeline
                        ? lateAudioSkipFrames(currentQueueFrames, dueInFrames, packetFrames_)
                        : 0U;
                if (lateFrames != 0) {
                    // Beyond the target: the late part of the voice is cut at its playout time.
                    slot->lateAudioCuts.fetch_add(1, std::memory_order_relaxed);
                    if (lateFrames >= frames)
                        continue;
                    sampleOffset = static_cast<std::size_t>(lateFrames) * channels_;
                    frames -= lateFrames;
                } else {
                    const auto correction =
                        onRoomTimeline
                            ? stabilizeSharedTimelineQueue(currentQueueFrames, queueTargetFrames,
                                                           frames)
                            : stabilizeRemoteQueue(currentQueueFrames, queueTargetFrames, frames);
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
            }
            const auto aligned = std::span<const float>{
                samples.data() + sampleOffset, static_cast<std::size_t>(frames) * channels_};
            if (!slot->queue.push(aligned, frames)) {
                slot->queueOverruns.fetch_add(1, std::memory_order_relaxed);
            }
        }
    }
}

float NetworkAudioEngine::quietestVoiceRms() const noexcept {
    float quietest = 0.0F;
    for (const auto& owned : remote_) {
        const auto& slot = *owned;
        const auto level = slot.voice.quietRms() * slot.gain.load(std::memory_order_relaxed);
        if (slot.active.load(std::memory_order_acquire) && level > 0.0F)
            quietest = quietest == 0.0F ? level : std::min(quietest, level);
    }
    return quietest;
}

NetworkDiagnostics NetworkAudioEngine::diagnostics() const {
    std::lock_guard remoteLock(remoteMutex_);
    NetworkDiagnostics out;
    out.playoutDelayFrames = playoutDelayFrames_;
    out.sharedTargetDelayFrames = sharedTargetDelayFrames_.load(std::memory_order_acquire);
    out.advertisedTargetDelayFrames = advertisedTargetDelayFrames_.load(std::memory_order_acquire);
    out.roomPlayoutDelayFrames = roomPlayoutDelayFrames_.load(std::memory_order_acquire);
    out.sharedTimeline = sharedTimeline_.load(std::memory_order_acquire);
    out.transportRunning = running_.load(std::memory_order_acquire);
    out.sendEnabled = sendEnabled_.load(std::memory_order_acquire);
    {
        std::lock_guard directLock(directPeersMutex_);
        out.directPeerCount = static_cast<std::uint32_t>(directPeers_.size());
    }
    out.timing = networkTiming_.snapshot(playoutDelayFrames_, packetFrames_ * 12U, sampleRateHz_);
    out.packetsSent = packetsSent_.load(std::memory_order_relaxed);
    out.packetsReceived = packetsReceived_.load(std::memory_order_relaxed);
    out.relayEchoes = relayEchoes_.load(std::memory_order_relaxed);
    out.sendCodec = sendCodec_.load(std::memory_order_relaxed);
    const auto diagnosticsNowMicros = steadyMicros();
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
        participant.reverb = slot.reverb.load(std::memory_order_relaxed);
        participant.echo = slot.echo.load(std::memory_order_relaxed);
        participant.delay = slot.delay.load(std::memory_order_relaxed);
        participant.noiseSuppression = slot.noiseSuppression.load(std::memory_order_relaxed);
        participant.octave = slot.octave.load(std::memory_order_relaxed);
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
            participant.timing.targetDelayFrames =
                std::max(participant.timing.targetDelayFrames,
                         sharedTargetDelayFrames_.load(std::memory_order_acquire));
        participant.alignmentDelayFrames =
            sharedTimeline_.load(std::memory_order_acquire)
                ? sharedTargetDelayFrames_.load(std::memory_order_acquire)
                : std::max(playoutDelayFrames_, slot.desiredDelayFrames);
        participant.queueAlignmentErrorFrames =
            slot.alignmentErrorFrames.load(std::memory_order_relaxed);
        participant.interPeerAlignmentErrorFrames =
            static_cast<std::uint32_t>(std::abs(participant.queueAlignmentErrorFrames));
        participant.latePackets = participant.jitter.latePackets;
        participant.lossPermille = slot.lossPermille.load(std::memory_order_relaxed);
        participant.reportedLossPermille =
            slot.reportedLossPermille.load(std::memory_order_relaxed);
        participant.lateAudioCuts = slot.lateAudioCuts.load(std::memory_order_relaxed);
        participant.timelineExcluded = slot.timelineExcluded;
        participant.voiceRms = slot.voice.rms() * slot.gain.load(std::memory_order_relaxed);
        participant.relayFirstPackets = slot.relayFirstPackets.load(std::memory_order_relaxed);
        participant.directFirstPackets = slot.directFirstPackets.load(std::memory_order_relaxed);
        participant.latenessTargetFrames = static_cast<std::uint32_t>(scaleFramePosition(
            slot.lateness.targetFrames(), VoiceTransportSampleRateHz, sampleRateHz_));
        participant.latenessLatestFrames = slot.lateness.latestFrames();
        const auto ingressTransport = slot.serverIngressFrames.load(std::memory_order_relaxed);
        const auto mixWaitTransport = slot.serverMixWaitFrames.load(std::memory_order_relaxed);
        participant.serverIngressFrames = static_cast<std::uint32_t>(scaleFramePosition(
            ingressTransport, VoiceTransportSampleRateHz, sampleRateHz_));
        participant.serverMixWaitFrames = static_cast<std::uint32_t>(scaleFramePosition(
            mixWaitTransport, VoiceTransportSampleRateHz, sampleRateHz_));
        const auto returnTransport = std::max<std::int64_t>(
            0, participant.latenessLatestFrames - ingressTransport - mixWaitTransport);
        participant.returnPathFrames = static_cast<std::uint32_t>(scaleFramePosition(
            static_cast<std::uint64_t>(returnTransport), VoiceTransportSampleRateHz,
            sampleRateHz_));
        const auto lastPacketMicros = slot.lastPacketMicros.load(std::memory_order_relaxed);
        participant.lastPacketAgeMs =
            lastPacketMicros == 0 || diagnosticsNowMicros <= lastPacketMicros
                ? 0
                : (diagnosticsNowMicros - lastPacketMicros) / 1'000U;
        participant.receivingRecently = lastPacketMicros != 0 &&
                                        diagnosticsNowMicros >= lastPacketMicros &&
                                        diagnosticsNowMicros - lastPacketMicros <= 2'000'000U;
        participant.timing.roundTripMs = out.timing.roundTripMs;
        if (participant.jitter.currentTargetPackets > out.jitter.currentTargetPackets)
            out.jitter = participant.jitter;
        out.participants.push_back(std::move(participant));
    }
    const auto firstRecent = std::ranges::find_if(
        out.participants, [](const auto& participant) { return participant.receivingRecently; });
    if (firstRecent != out.participants.end()) {
        auto minimumError = firstRecent->interPeerAlignmentErrorFrames;
        auto maximumError = minimumError;
        for (const auto& participant : out.participants) {
            if (!participant.receivingRecently)
                continue;
            minimumError = std::min(minimumError, participant.interPeerAlignmentErrorFrames);
            maximumError = std::max(maximumError, participant.interPeerAlignmentErrorFrames);
        }
        const auto spread = maximumError - minimumError;
        for (auto& participant : out.participants) {
            participant.interPeerAlignmentErrorFrames = participant.receivingRecently ? spread : 0U;
        }
    }
    return out;
}
