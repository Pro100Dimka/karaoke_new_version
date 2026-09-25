#pragma once

#include "common/Types.hpp"
#include "dsp/DspChain.hpp"
#include "network/AdaptiveJitterBuffer.hpp"
#include "network/NetworkPacket.hpp"
#include "network/OpusCodec.hpp"
#include "network/UdpSocket.hpp"
#include "realtime/PcmRingBuffer.hpp"
#include "realtime/RealtimeInstrumentation.hpp"

#include <array>
#include <atomic>
#include <condition_variable>
#include <cstdint>
#include <memory>
#include <mutex>
#include <span>
#include <string>
#include <string_view>
#include <thread>
#include <vector>

constexpr std::size_t MaxRemoteParticipants = 16;

struct RemoteParticipantDiagnostics {
    std::string participantId;
    float gain{1.0F};
    bool muted{false};
    float reverb{0.0F};
    float echo{0.0F};
    float delay{0.0F};
    bool noiseSuppression{false};
    float octave{0.0F};
    float level{0.0F};
    std::uint32_t queueFillFrames{0};
    std::uint64_t decodeUnderruns{0};
    std::uint64_t queueOverruns{0};
    JitterBufferSnapshot jitter{};
    NetworkTimingSnapshot timing{};
    std::uint32_t alignmentDelayFrames{0};
    std::uint32_t interPeerAlignmentErrorFrames{0};
    std::uint64_t latePackets{0};
    std::uint64_t lastPacketAgeMs{0};
    bool receivingRecently{false};
};

struct NetworkDiagnostics {
    std::uint64_t packetsSent{0};
    std::uint64_t packetsReceived{0};
    std::uint64_t droppedSendBlocks{0};
    std::uint64_t decodeUnderruns{0};
    std::uint64_t receiveQueueOverruns{0};
    std::uint64_t staleBlocks{0};
    std::uint32_t sendQueueFillFrames{0};
    std::uint32_t receiveQueueFillFrames{0};
    std::uint32_t playoutDelayFrames{0};
    std::uint32_t sharedTargetDelayFrames{0};
    std::uint32_t advertisedTargetDelayFrames{0};
    bool sharedTimeline{false};
    bool transportRunning{false};
    bool sendEnabled{false};
    std::uint32_t directPeerCount{0};
    JitterBufferSnapshot jitter{};
    NetworkTimingSnapshot timing{};
    std::vector<RemoteParticipantDiagnostics> participants;
};

class NetworkAudioEngine {
  public:
    NetworkAudioEngine();
    ~NetworkAudioEngine();

    void prepare(std::uint32_t sampleRateHz, std::uint32_t channels, std::uint32_t queueFrames,
                 std::uint32_t packetFrames, GenerationId generation);
    void setGeneration(GenerationId generation) noexcept;
    void setLocalParticipant(std::string participantId);
    void setSessionToken(std::uint64_t token) noexcept;
    void setSharedTimeline(bool enabled);
    [[nodiscard]] bool sharedTimelineEnabled() const noexcept {
        return sharedTimeline_.load(std::memory_order_acquire);
    }
    [[nodiscard]] std::uint32_t sharedTargetDelayFrames() const noexcept {
        return sharedTargetDelayFrames_.load(std::memory_order_acquire);
    }
    [[nodiscard]] bool addRemoteParticipant(std::string participantId);
    [[nodiscard]] bool removeRemoteParticipant(std::string_view participantId) noexcept;
    [[nodiscard]] bool setRemoteGain(std::string_view participantId, float gain) noexcept;
    [[nodiscard]] bool setRemoteMute(std::string_view participantId, bool muted) noexcept;
    [[nodiscard]] bool setRemoteEffect(std::string_view participantId, std::string_view effect,
                                       float value) noexcept;
    [[nodiscard]] bool setDirectPeer(std::string participantId, std::string host,
                                     std::uint16_t port, std::uint64_t receiveToken);
    void clearDirectPeers() noexcept;
    [[nodiscard]] std::uint16_t localPort() const noexcept { return localPort_; }
    void startSend(const std::string& host, std::uint16_t port);
    void startReceive(std::uint16_t port);
    void stop() noexcept;
    void pushLocal(GenerationId generation, std::span<const float> samples,
                   std::uint32_t frames, std::uint64_t timestampFrame = 0,
                   float gain = 1.0F) noexcept;
    [[nodiscard]] std::uint32_t renderRemote(GenerationId generation, std::span<float> output,
                                             std::uint32_t frames,
                                             std::uint64_t timelineFrame = 0) noexcept;
    [[nodiscard]] NetworkDiagnostics diagnostics() const;

  private:
    friend struct NetworkTestAccess;
    struct RemoteSlot {
        std::string participantId;
        std::atomic<std::uint32_t> participantKey{0};
        std::atomic<bool> active{false};
        std::atomic<std::uint32_t> renderReaders{0};
        std::atomic<float> gain{1.0F};
        std::atomic<bool> muted{false};
        std::atomic<float> reverb{0.0F};
        std::atomic<float> echo{0.0F};
        std::atomic<float> delay{0.0F};
        std::atomic<bool> noiseSuppression{false};
        std::atomic<float> octave{0.0F};
        std::atomic<float> level{0.0F};
        std::unique_ptr<DspChain> effects;
        std::atomic<std::uint64_t> decodeUnderruns{0};
        std::atomic<std::uint64_t> queueOverruns{0};
        std::atomic<std::uint32_t> alignmentErrorFrames{0};
        PcmRingBuffer queue;
        mutable RealtimeMutex jitterMutex;
        AdaptiveJitterBuffer jitter;
        NetworkTimingEstimator timing;
        // Opus decoders carry state across frames for loss concealment, so each participant owns one;
        // sharing a single decoder across participants would corrupt everyone's audio. Only touched
        // from receiveMain(), never from the realtime render callback.
        std::unique_ptr<OpusVoiceDecoder> decoder;
        bool timelineInitialized{false};
        std::uint64_t playoutPacketIndex{0};
        std::uint32_t desiredDelayFrames{0};
        std::uint32_t remoteAdvertisedDelayFrames{0};
        std::uint64_t remoteTargetEpoch{UINT64_MAX};
        std::uint32_t remoteStreamEpoch{0};
        RecentAudioSequenceWindow receivedSequences;
        std::atomic<std::uint64_t> lastPacketMicros{0};
    };

    struct DirectPeer {
        std::string participantId;
        std::string host;
        std::uint16_t port{0};
        std::uint64_t receiveToken{0};
    };

    [[nodiscard]] static std::uint32_t participantKey(std::string_view id) noexcept;
    [[nodiscard]] RemoteSlot* slotForKey(std::uint32_t key) noexcept;
    [[nodiscard]] RemoteSlot* slotForId(std::string_view id) noexcept;
    [[nodiscard]] const RemoteSlot* slotForId(std::string_view id) const noexcept;
    void sendMain() noexcept;
    void receiveMain() noexcept;

    PcmRingBuffer sendQueue_;
    // One socket for both directions: startReceive() binds it to the local port, startSend() then connects that
    // same bound socket to the peer, so the outbound packet that opens a NAT/firewall mapping and the peer's
    // replies both use that one local port. Two separate sockets (a bound one and a separately-connected one)
    // would make the reply arrive on a port nothing ever sent from, which most home routers drop.
    UdpSocket socket_;
    // Nulled by prepare()'s stop() and (re)built there once sampleRateHz_/channels_ are known; only
    // touched from setup and sendMain(), never from the realtime render callback.
    std::unique_ptr<OpusVoiceEncoder> encoder_;
    std::array<std::unique_ptr<RemoteSlot>, MaxRemoteParticipants> remote_{};
    mutable std::mutex remoteMutex_;
    mutable std::mutex directPeersMutex_;
    std::vector<DirectPeer> directPeers_;
    std::vector<float> remoteScratch_;
    // Device/render layouts may expose up to eight channels, while a room participant is one
    // centred voice. These preallocated samples fold the device layout to mono without allocating
    // in the realtime capture callback.
    std::vector<float> localScratch_;
    std::thread sendThread_;
    std::thread receiveThread_;
    std::condition_variable_any sendCv_;
    RealtimeMutex sendMutex_;
    std::atomic<bool> running_{false};
    std::atomic<bool> sendEnabled_{false};
    std::string remoteHost_;
    std::uint16_t localPort_{0};
    std::uint16_t remotePort_{0};
    std::uint32_t sampleRateHz_{0};
    std::uint32_t channels_{1}; // Opus transport channels (room voice is always mono).
    std::uint32_t renderChannels_{0};
    std::uint32_t queueFrames_{0};
    std::uint32_t packetFrames_{0};
    std::uint32_t playoutDelayFrames_{0};
    std::atomic<std::uint32_t> sequence_{0};
    std::atomic<std::uint32_t> localParticipantKey_{1};
    std::atomic<std::uint32_t> streamEpoch_{1};
    std::atomic<std::uint64_t> sessionToken_{0};
    std::atomic<std::uint64_t> nextSendTimestamp_{0};
    std::atomic<std::uint64_t> localTimelineFrame_{0};
    std::atomic<bool> sharedTimeline_{false};
    std::atomic<std::uint32_t> sharedTargetDelayFrames_{0};
    // Receive-thread-owned consensus round. A short media-time epoch lets a propagated room
    // maximum cross asymmetric routes without turning one old latency spike into a permanent
    // session-wide delay.
    std::atomic<std::uint64_t> sharedTargetEpoch_{UINT64_MAX};
    // This receiver's measured worst inbound route. The epoch-bounded shared target above is what
    // travels on the wire, so an asymmetric relay can propagate the room maximum to every client.
    std::atomic<std::uint32_t> advertisedTargetDelayFrames_{0};
    std::atomic<std::uint64_t> packetsSent_{0};
    std::atomic<std::uint64_t> packetsReceived_{0};
    std::atomic<std::uint64_t> droppedSendBlocks_{0};
    std::atomic<std::uint64_t> staleBlocks_{0};
    static constexpr std::size_t ProbeHistorySize = 2048;
    std::array<std::atomic<std::uint32_t>, ProbeHistorySize> sentProbeSequences_{};
    std::array<std::atomic<std::uint64_t>, ProbeHistorySize> sentProbeMicros_{};
    NetworkTimingEstimator networkTiming_;
    std::atomic<GenerationId> generation_{GenerationId{0}};
};
