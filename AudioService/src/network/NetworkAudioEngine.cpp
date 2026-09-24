#include "network/NetworkAudioEngine.hpp"
#include "network/NetworkPacket.hpp"

#include <algorithm>
#include <chrono>
#include <cmath>
#include <cstring>

namespace {
constexpr std::uint32_t VoiceTransportSampleRateHz = 48'000;
constexpr std::uint32_t VoiceTransportPacketFrames = 240;
constexpr std::uint64_t RoomTargetEpochFrames = VoiceTransportSampleRateHz * 2ULL;
constexpr std::uint64_t RemoteRouteFreshMicros = 1'000'000ULL;

[[nodiscard]] std::uint64_t steadyMicros() noexcept {
    return static_cast<std::uint64_t>(std::chrono::duration_cast<std::chrono::microseconds>(
                                         std::chrono::steady_clock::now().time_since_epoch())
                                         .count());
}

[[nodiscard]] std::uint64_t scaleFramePosition(std::uint64_t frames,
                                               std::uint32_t sourceRateHz,
                                               std::uint32_t targetRateHz) noexcept {
    if (sourceRateHz == 0 || sourceRateHz == targetRateHz)
        return frames;
    return (frames * targetRateHz + sourceRateHz / 2U) / sourceRateHz;
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
    const auto restoreReceive = running_.load(std::memory_order_acquire) &&
                                receiveThread_.joinable();
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
    // Keep the local singing loop interactive. Route latency is already included by the shared
    // media-timeline alignment below, so reserving another 30 ms here double-counted part of the
    // path and made a healthy local-room relay sound like an echo.
    playoutDelayFrames_ = std::max(packetFrames * 3U, sampleRateHz * 20U / 1000U);
    sharedTimeline_.store(restoreSharedTimeline, std::memory_order_relaxed);
    sharedTargetDelayFrames_.store(playoutDelayFrames_, std::memory_order_relaxed);
    advertisedTargetDelayFrames_.store(playoutDelayFrames_, std::memory_order_relaxed);
    sharedTargetEpoch_.store(UINT64_MAX, std::memory_order_relaxed);
    sequence_.store(0, std::memory_order_relaxed);
    packetsSent_.store(0, std::memory_order_relaxed);
    packetsReceived_.store(0, std::memory_order_relaxed);
    droppedSendBlocks_.store(0, std::memory_order_relaxed);
    staleBlocks_.store(0, std::memory_order_relaxed);
    generation_.store(generation, std::memory_order_release);
    sendQueue_.prepare(queueFrames, channels_);
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
        slot.reverb.store(0.0F, std::memory_order_relaxed);
        slot.echo.store(0.0F, std::memory_order_relaxed);
        slot.delay.store(0.0F, std::memory_order_relaxed);
        slot.noiseSuppression.store(false, std::memory_order_relaxed);
        slot.octave.store(0.0F, std::memory_order_relaxed);
        slot.effects.prepare(sampleRateHz, MaxBlockFrames, channels_);
        slot.effects.setEnabled(true);
        slot.effects.reset();
        slot.level.store(0.0F, std::memory_order_relaxed);
        slot.decodeUnderruns.store(0, std::memory_order_relaxed);
        slot.queueOverruns.store(0, std::memory_order_relaxed);
        slot.alignmentErrorFrames.store(0, std::memory_order_relaxed);
        slot.queue.prepare(queueFrames, channels_);
        slot.decoder.reset();
        slot.timelineInitialized = false;
        slot.playoutPacketIndex = 0;
        slot.desiredDelayFrames = 0;
        slot.remoteAdvertisedDelayFrames = 0;
        slot.remoteTargetEpoch = UINT64_MAX;
        slot.remoteStreamEpoch = 0;
        slot.lastPacketMicros.store(0, std::memory_order_relaxed);
        slot.timing.reset();
        std::lock_guard lock(slot.jitterMutex);
        slot.jitter.configure(2, 12);
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
    sendCv_.notify_all();
}

void NetworkAudioEngine::setLocalParticipant(std::string participantId) {
    const auto key = participantKey(participantId);
    localParticipantKey_.store(key, std::memory_order_release);
    const auto now = steadyMicros();
    auto epoch = key ^ static_cast<std::uint32_t>(now) ^
                 static_cast<std::uint32_t>(now >> 32U);
    if (epoch == 0)
        epoch = 1;
    streamEpoch_.store(epoch, std::memory_order_release);
}
void NetworkAudioEngine::setSessionToken(std::uint64_t token) noexcept {
    sessionToken_.store(token, std::memory_order_release);
}

void NetworkAudioEngine::setSharedTimeline(bool enabled) {
    sharedTimeline_.store(enabled, std::memory_order_release);
    sharedTargetDelayFrames_.store(playoutDelayFrames_, std::memory_order_release);
    advertisedTargetDelayFrames_.store(playoutDelayFrames_, std::memory_order_release);
    sharedTargetEpoch_.store(UINT64_MAX, std::memory_order_relaxed);
    sendQueue_.clear();
    nextSendTimestamp_.store(0, std::memory_order_release);
    std::lock_guard remoteLock(remoteMutex_);
    for (auto& owned : remote_) {
        auto& slot = *owned;
        slot.queue.clear();
        slot.timelineInitialized = false;
        slot.playoutPacketIndex = 0;
        slot.desiredDelayFrames = 0;
        slot.remoteAdvertisedDelayFrames = 0;
        slot.remoteTargetEpoch = UINT64_MAX;
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
        slot.effects.reset();
        slot.level.store(0.0F, std::memory_order_relaxed);
        slot.decodeUnderruns.store(0, std::memory_order_relaxed);
        slot.queueOverruns.store(0, std::memory_order_relaxed);
        slot.alignmentErrorFrames.store(0, std::memory_order_relaxed);
        slot.lastPacketMicros.store(0, std::memory_order_relaxed);
        // A fresh decoder per join: reusing one across different participants (or a rejoin) would
        // carry stale Opus loss-concealment state into an unrelated stream.
        slot.decoder =
            std::make_unique<OpusVoiceDecoder>(VoiceTransportSampleRateHz, channels_);
        slot.timelineInitialized = false;
        slot.playoutPacketIndex = 0;
        slot.desiredDelayFrames = 0;
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
    slot->participantKey.store(0, std::memory_order_release);
    slot->participantId.clear();
    slot->decoder.reset();
    slot->desiredDelayFrames = 0;
    slot->remoteAdvertisedDelayFrames = 0;
    slot->remoteTargetEpoch = UINT64_MAX;
    slot->remoteStreamEpoch = 0;
    slot->lastPacketMicros.store(0, std::memory_order_relaxed);
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

bool NetworkAudioEngine::setRemoteEffect(std::string_view participantId, std::string_view effect,
                                         float value) noexcept {
    std::lock_guard remoteLock(remoteMutex_);
    auto* slot = slotForId(participantId);
    if (slot == nullptr)
        return false;
    if (effect == "reverb") {
        value = std::clamp(value, 0.0F, 1.0F);
        slot->reverb.store(value, std::memory_order_relaxed);
        return slot->effects.setParameter("reverb.mix", value);
    }
    if (effect == "echo") {
        value = std::clamp(value, 0.0F, 0.95F);
        slot->echo.store(value, std::memory_order_relaxed);
        return slot->effects.setParameter("delay.feedback", value);
    }
    if (effect == "delay") {
        value = std::clamp(value, 0.0F, 1.0F);
        slot->delay.store(value, std::memory_order_relaxed);
        return slot->effects.setParameter("delay.mix", value) &&
               slot->effects.setParameter("delay.ms", 25.0F + value * 475.0F);
    }
    if (effect == "noiseSuppression") {
        const auto enabled = value >= 0.5F;
        slot->noiseSuppression.store(enabled, std::memory_order_relaxed);
        return slot->effects.setParameter("noise.reduction", enabled ? 0.85F : 0.0F);
    }
    if (effect == "octave") {
        value = std::clamp(std::round(value), -1.0F, 1.0F);
        slot->octave.store(value, std::memory_order_relaxed);
        return slot->effects.setParameter("pitch.semitones", value * 12.0F);
    }
    return false;
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
    if (sendEnabled_.load(std::memory_order_acquire) && remoteHost_ == host &&
        remotePort_ == port)
        return;
    if (sendEnabled_.load(std::memory_order_acquire)) {
        const auto receivePort = localPort_;
        stop();
        startReceive(receivePort);
    }
    if (!encoder_)
        encoder_ =
            std::make_unique<OpusVoiceEncoder>(VoiceTransportSampleRateHz, channels_);
    socket_.connect(host, port);
    remoteHost_ = host;
    remotePort_ = port;
    sendEnabled_.store(true, std::memory_order_release);
    running_.store(true, std::memory_order_release);
    if (!sendThread_.joinable())
        sendThread_ = std::thread(&NetworkAudioEngine::sendMain, this);
}
void NetworkAudioEngine::startReceive(std::uint16_t port) {
    if (running_.load(std::memory_order_acquire) && receiveThread_.joinable() &&
        localPort_ == port)
        return;
    if (receiveThread_.joinable())
        stop();
    socket_.bind(port);
    socket_.setReceiveTimeoutMs(100);
    localPort_ = port;
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
        const auto transportTimestamp =
            scaleFramePosition(timestampFrame, sampleRateHz_, VoiceTransportSampleRateHz);
        nextSendTimestamp_.store(transportTimestamp & MediaTimelineMask,
                                 std::memory_order_release);
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
        const auto read = slot.queue.pop(
            std::span<float>{remoteScratch_.data(), transportSampleCount}, frames);
        if (read < frames) {
            const auto begin = static_cast<std::size_t>(read) * channels_;
            std::fill(remoteScratch_.begin() + static_cast<std::ptrdiff_t>(begin),
                      remoteScratch_.begin() + static_cast<std::ptrdiff_t>(transportSampleCount),
                      0.0F);
            slot.decodeUnderruns.fetch_add(1, std::memory_order_relaxed);
        }
        if (slot.muted.load(std::memory_order_relaxed))
            continue;
        slot.effects.process(std::span<float>{remoteScratch_.data(), transportSampleCount}, frames);
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
    std::vector<float> deviceSamples(
        static_cast<std::size_t>((sampleRateHz_ + 199U) / 200U) * channels_);
    std::uint64_t packetIndex = 0;
    while (running_.load(std::memory_order_acquire) &&
           sendEnabled_.load(std::memory_order_acquire)) {
        const auto wantedFrames = deviceFramesForVoicePacket(packetIndex, sampleRateHz_);
        {
            std::unique_lock lock(sendMutex_);
            sendCv_.wait(lock, [this, wantedFrames] {
                return !running_.load(std::memory_order_acquire) ||
                       !sendEnabled_.load(std::memory_order_acquire) ||
                       sendQueue_.availableFrames() >= wantedFrames;
            });
        }
        if (!running_.load(std::memory_order_acquire) ||
            !sendEnabled_.load(std::memory_order_acquire))
            break;
        const auto workGeneration = generation_.load(std::memory_order_acquire);
        const auto frames = sendQueue_.pop(deviceSamples, wantedFrames);
        if (frames == 0)
            continue;
        if (workGeneration != generation_.load(std::memory_order_acquire)) {
            staleBlocks_.fetch_add(1, std::memory_order_relaxed);
            continue;
        }
        const auto transportSamples = retimeInterleavedLinear(
            std::span<const float>{deviceSamples.data(),
                                   static_cast<std::size_t>(frames) * channels_},
            channels_, VoiceTransportPacketFrames);
        ++packetIndex;
        const auto payload = encoder_->encode(transportSamples, VoiceTransportPacketFrames);
        if (payload.empty())
            continue;
        const auto mediaTimestamp =
            nextSendTimestamp_.fetch_add(VoiceTransportPacketFrames, std::memory_order_acq_rel) &
            MediaTimelineMask;
        const auto targetEpoch = mediaTimestamp / RoomTargetEpochFrames;
        const auto targetForPacket = sharedTargetEpoch_.load(std::memory_order_acquire) == targetEpoch
                                         ? sharedTargetDelayFrames_.load(std::memory_order_acquire)
                                         : advertisedTargetDelayFrames_.load(std::memory_order_acquire);
        AudioPacketHeader header{sequence_.fetch_add(1, std::memory_order_relaxed),
                                  localParticipantKey_.load(std::memory_order_relaxed),
                                  sessionToken_.load(std::memory_order_relaxed),
                                  sharedTimeline_.load(std::memory_order_acquire)
                                      ? mediaTimestamp | SharedAudioTimelineFlag
                                      : mediaTimestamp,
                                 static_cast<std::uint16_t>(channels_),
                                 static_cast<std::uint16_t>(VoiceTransportPacketFrames),
                                  static_cast<std::uint32_t>(scaleFramePosition(
                                      targetForPacket,
                                      sampleRateHz_, VoiceTransportSampleRateHz)),
                                  streamEpoch_.load(std::memory_order_acquire)};
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
            !audioPacketBelongsToSession(
                header, sessionToken_.load(std::memory_order_acquire), channels_))
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
        if (slot->remoteStreamEpoch != header.streamEpoch) {
            slot->queue.clear();
            slot->decoder = std::make_unique<OpusVoiceDecoder>(VoiceTransportSampleRateHz,
                                                                channels_);
            slot->timelineInitialized = false;
            slot->playoutPacketIndex = 0;
            slot->desiredDelayFrames = 0;
            slot->remoteAdvertisedDelayFrames = 0;
            slot->remoteTargetEpoch = UINT64_MAX;
            slot->timing.reset();
            std::lock_guard jitterLock(slot->jitterMutex);
            slot->jitter.reset();
            slot->remoteStreamEpoch = header.streamEpoch;
        }
        slot->lastPacketMicros.store(steadyMicros(), std::memory_order_relaxed);
        const auto mediaTimestampFrame = header.timestampFrame & ~SharedAudioTimelineFlag;
        const auto isSharedTimelinePacket =
            (header.timestampFrame & SharedAudioTimelineFlag) != 0 &&
            sharedTimeline_.load(std::memory_order_acquire);
        const auto arrivalMicros = isSharedTimelinePacket
                                       ? scaleFramePosition(
                                             localTimelineFrame_.load(std::memory_order_acquire),
                                             sampleRateHz_, VoiceTransportSampleRateHz) *
                                             1'000'000ULL / VoiceTransportSampleRateHz
                                       : steadyMicros();
        slot->timing.noteArrival(mediaTimestampFrame, arrivalMicros,
                                 VoiceTransportSampleRateHz);
        slot->remoteAdvertisedDelayFrames = static_cast<std::uint32_t>(scaleFramePosition(
            header.sharedTargetDelayFrames, VoiceTransportSampleRateHz, sampleRateHz_));
        slot->remoteTargetEpoch = mediaTimestampFrame / RoomTargetEpochFrames;
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
            const auto decoded = outcome == JitterPopOutcome::Delivered
                                     ? slot->decoder->decode(packet.payload, packet.frames)
                                     : slot->decoder->conceal(VoiceTransportPacketFrames);
            if (decoded.empty())
                continue;
            auto frames = deviceFramesForVoicePacket(slot->playoutPacketIndex++, sampleRateHz_);
            auto samples = retimeInterleavedLinear(decoded, channels_, frames);
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
                // All active singers share the slowest measured route. Increases are packet-bounded
                // and decreases are released much more slowly, so a transient spike cannot create a
                // permanent latency ratchet or an abrupt jump in the voices already playing.
                const auto localTransportFrame = scaleFramePosition(
                    localTimelineFrame_.load(std::memory_order_acquire), sampleRateHz_,
                    VoiceTransportSampleRateHz);
                const auto targetTransportFrames = static_cast<std::uint32_t>(scaleFramePosition(
                    targetFrames, sampleRateHz_, VoiceTransportSampleRateHz));
                const auto minimumTransportFrames = static_cast<std::uint32_t>(scaleFramePosition(
                    playoutDelayFrames_, sampleRateHz_, VoiceTransportSampleRateHz));
                const auto measuredCandidate = compensatedVoiceTargetFrames(
                    packet.timestampFrame & ~SharedAudioTimelineFlag,
                    localTransportFrame, targetTransportFrames, minimumTransportFrames,
                    maximumInteractiveRoomDelayFrames(
                        static_cast<std::uint32_t>(scaleFramePosition(
                            queueFrames_, sampleRateHz_, VoiceTransportSampleRateHz)),
                        VoiceTransportPacketFrames, VoiceTransportSampleRateHz,
                        minimumTransportFrames));
                const auto measuredCandidateDevice = static_cast<std::uint32_t>(scaleFramePosition(
                    measuredCandidate, VoiceTransportSampleRateHz, sampleRateHz_));
                slot->desiredDelayFrames = measuredCandidateDevice;
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
                const auto maximumDelayFrames = maximumInteractiveRoomDelayFrames(
                    queueFrames_, packetFrames_, sampleRateHz_, playoutDelayFrames_);
                const auto localAdvertised = adaptSharedCompensationFrames(
                    advertisedTargetDelayFrames_.load(std::memory_order_acquire), localDesired,
                    playoutDelayFrames_, maximumDelayFrames, packetFrames_);
                advertisedTargetDelayFrames_.store(localAdvertised, std::memory_order_release);
                const auto targetEpoch = localTransportFrame / RoomTargetEpochFrames;
                auto desiredCommon = localAdvertised;
                if (sharedTargetEpoch_.load(std::memory_order_acquire) == targetEpoch) {
                    desiredCommon = std::max(
                        desiredCommon,
                        sharedTargetDelayFrames_.load(std::memory_order_acquire));
                }
                for (const auto& remote : remote_) {
                    const auto& participant = *remote;
                    if (participant.active.load(std::memory_order_acquire) &&
                        participant.remoteTargetEpoch == targetEpoch)
                        desiredCommon = std::max(desiredCommon,
                                                 participant.remoteAdvertisedDelayFrames);
                }
                // Every process receives the other process' locally measured route target in the
                // packet header. Commit that distributed maximum as one room target immediately;
                // keeping a separately smoothed value on each computer preserves their initial
                // difference forever. Queue correction below remains gradual, so lowering the
                // target does not cut a large chunk of voice in one callback.
                const auto clampedCandidate = std::clamp(desiredCommon, playoutDelayFrames_,
                                                         maximumDelayFrames);
                const auto candidate = quantizeRoomDelayFrames(
                    clampedCandidate, maximumDelayFrames, packetFrames_);
                // Do not accumulate target increases into a separate silence counter. Under
                // fluctuating jitter an increase/decrease cycle used to add silence on every rise
                // but never remove it on the matching fall, producing seconds of permanent lag.
                // The timestamp-derived queue target below owns continuous correction.
                sharedTargetDelayFrames_.store(candidate, std::memory_order_release);
                sharedTargetEpoch_.store(targetEpoch, std::memory_order_release);
                targetFrames = sharedTargetDelayFrames_.load(std::memory_order_acquire);
            }
            if (!slot->timelineInitialized && outcome == JitterPopOutcome::Delivered) {
                const auto remoteTimestamp = packet.timestampFrame & ~SharedAudioTimelineFlag;
                const auto localTimestamp = scaleFramePosition(
                    localTimelineFrame_.load(std::memory_order_acquire), sampleRateHz_,
                    VoiceTransportSampleRateHz);
                const auto transportTargetFrames = static_cast<std::uint32_t>(scaleFramePosition(
                    targetFrames, sampleRateHz_, VoiceTransportSampleRateHz));
                const auto alignment = sharedPacket
                                           ? alignSharedAudioTimeline(
                                                 remoteTimestamp, localTimestamp,
                                                 transportTargetFrames)
                                           : alignAudioPacketTimeline(
                                                 remoteTimestamp, localTimestamp, targetFrames,
                                                 frames);
                const auto deviceAlignment =
                    sharedPacket
                        ? AudioTimelineAlignment{
                              static_cast<std::uint32_t>(scaleFramePosition(
                                  alignment.silenceFrames, VoiceTransportSampleRateHz,
                                  sampleRateHz_)),
                              static_cast<std::uint32_t>(scaleFramePosition(
                                  alignment.skipFrames, VoiceTransportSampleRateHz, sampleRateHz_))}
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
                sampleOffset = static_cast<std::size_t>(deviceAlignment.skipFrames) * channels_;
                frames -= deviceAlignment.skipFrames;
                slot->timelineInitialized = true;
                slot->alignmentErrorFrames.store(0, std::memory_order_relaxed);
            } else if (slot->timelineInitialized) {
                auto queueTargetFrames = targetFrames;
                if (sharedPacket && outcome == JitterPopOutcome::Delivered) {
                    const auto localTransportFrame = scaleFramePosition(
                        localTimelineFrame_.load(std::memory_order_acquire), sampleRateHz_,
                        VoiceTransportSampleRateHz);
                    const auto commonTransportFrames = static_cast<std::uint32_t>(
                        scaleFramePosition(targetFrames, sampleRateHz_,
                                           VoiceTransportSampleRateHz));
                    const auto queueTargetTransport = sharedTimelineQueueTargetFrames(
                        packet.timestampFrame & ~SharedAudioTimelineFlag,
                        localTransportFrame, commonTransportFrames);
                    queueTargetFrames = static_cast<std::uint32_t>(scaleFramePosition(
                        queueTargetTransport, VoiceTransportSampleRateHz, sampleRateHz_));
                }
                const auto currentQueueFrames = slot->queue.availableFrames();
                slot->alignmentErrorFrames.store(
                    currentQueueFrames > queueTargetFrames
                        ? currentQueueFrames - queueTargetFrames
                        : queueTargetFrames - currentQueueFrames,
                    std::memory_order_relaxed);
                const auto correction =
                    stabilizeRemoteQueue(currentQueueFrames, queueTargetFrames, frames);
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
    out.advertisedTargetDelayFrames =
        advertisedTargetDelayFrames_.load(std::memory_order_acquire);
    out.sharedTimeline = sharedTimeline_.load(std::memory_order_acquire);
    out.transportRunning = running_.load(std::memory_order_acquire);
    out.sendEnabled = sendEnabled_.load(std::memory_order_acquire);
    out.timing = networkTiming_.snapshot(playoutDelayFrames_, packetFrames_ * 12U, sampleRateHz_);
    out.packetsSent = packetsSent_.load(std::memory_order_relaxed);
    out.packetsReceived = packetsReceived_.load(std::memory_order_relaxed);
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
        participant.noiseSuppression =
            slot.noiseSuppression.load(std::memory_order_relaxed);
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
            participant.timing.targetDelayFrames = std::max(
                participant.timing.targetDelayFrames,
                sharedTargetDelayFrames_.load(std::memory_order_acquire));
        participant.alignmentDelayFrames = sharedTimeline_.load(std::memory_order_acquire)
                                               ? sharedTargetDelayFrames_.load(
                                                     std::memory_order_acquire)
                                               : std::max(playoutDelayFrames_,
                                                          slot.desiredDelayFrames);
        participant.interPeerAlignmentErrorFrames =
            slot.alignmentErrorFrames.load(std::memory_order_relaxed);
        participant.latePackets = participant.jitter.latePackets;
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
    const auto firstRecent = std::ranges::find_if(out.participants, [](const auto& participant) {
        return participant.receivingRecently;
    });
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
