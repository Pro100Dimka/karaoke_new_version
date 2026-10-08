#pragma once

#include "common/Types.hpp"
#include "dsp/DspChain.hpp"
#include "network/AdaptiveJitterBuffer.hpp"
#include "network/NetworkPacket.hpp"
#include "network/OpusCodec.hpp"
#include "network/PcmVoiceCodec.hpp"
#include "network/UdpSocket.hpp"
#include "realtime/PcmRingBuffer.hpp"
#include "realtime/RealtimeInstrumentation.hpp"
#include "realtime/VoiceLoudness.hpp"

#include <array>
#include <atomic>
#include <cstdint>
#include <memory>
#include <mutex>
#include <optional>
#include <span>
#include <string>
#include <string_view>
#include <thread>
#include <vector>

constexpr std::size_t MaxRemoteParticipants = 16;

struct RoomPacketDecisionTrace {
    GenerationId generation{0};
    std::uint32_t streamEpoch{0};
    std::uint32_t sequence{0};
    std::uint64_t musicalFrame{0}; // transport frames on the room clock
    std::uint32_t serverIngressFrames{0};
    std::uint32_t serverCollectionFrames{0};
    std::uint64_t serverSendTimelineFrame{0};
    std::uint64_t targetPresentationFrame{0};
    std::uint64_t socketReceiveMicros{0}; // receiver steady clock, not server clock
    std::uint64_t processingMicros{0};
    std::uint64_t decisionMicros{0};
    std::uint64_t receiveTimelineFrame{0}; // same room-clock domain as musicalFrame
    std::uint64_t decisionTimelineFrame{0};
    std::int64_t receiveSlackFrames{0};
    std::int64_t decisionSlackFrames{0};
    std::uint32_t targetDelayFrames{0}; // device-rate frames
    std::int64_t dueInFrames{0};
    std::uint32_t queueFillFrames{0};
    std::uint32_t lateSkipFrames{0};
    bool nonzero{false};
    bool delivered{false};
    const char* decision{"UNKNOWN"};
};

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
    std::int32_t queueAlignmentErrorFrames{
        0}; // receive queue fill minus its room target, last packet
    // Arrival lateness against this receiver's presentation timeline (device frames).
    std::uint32_t latenessTargetFrames{0};
    std::uint64_t lateAudioCuts{0}; // packets partly or wholly cut for arriving beyond the target
    std::uint32_t maximumConsecutiveLateAudioCuts{0};
    std::uint64_t firstLateAudioCutFrame{0};
    std::uint64_t lastLateAudioCutFrame{0};
    bool timelineExcluded{false};   // silent until the route meets the shared deadline again
    float voiceRms{0.0F};           // K-weighted, as heard
    std::uint64_t relayFirstPackets{0};
    std::uint64_t directFirstPackets{0};
    std::int64_t latenessLatestFrames{0};
    std::uint32_t serverIngressFrames{0};
    std::uint32_t serverMixWaitFrames{0};
    std::uint32_t returnPathFrames{0};
    // Return route distribution over the last 30 s (device frames): the 99th percentile is this
    // listener's return requirement for the room timing policy.
    std::uint32_t returnRequirementFrames{0};
    std::uint32_t returnP95Frames{0};
    std::uint32_t returnP50Frames{0};
    std::uint32_t returnSamples{0};
    // How late the voices this listener hears reached the relay (99th percentile, device frames):
    // the time the relay must keep each position open for them.
    std::uint32_t arrivalRequirementFrames{0};
    std::uint32_t arrivalSamples{0};
    ReturnPathStageSnapshot returnStages{};
    std::uint64_t latePackets{0};
    std::uint32_t lossPermille{0};         // this participant's stream lost here
    std::uint32_t reportedLossPermille{0}; // our stream lost at this participant
    std::uint64_t lastPacketAgeMs{0};
    bool receivingRecently{false};
    std::vector<RoomPacketDecisionTrace> packetTrace;
    std::uint64_t decodedNonzeroPackets{0};
    float decodedPeak{0.0F};
    std::uint64_t queuedNonzeroPackets{0};
    float queuedPeak{0.0F};
    std::uint64_t renderedNonzeroBlocks{0};
    float renderedPeak{0.0F};
};

struct NetworkDiagnostics {
    std::uint64_t packetsSent{0};
    std::uint64_t sendGapLatestMicros{0};
    std::uint64_t sendGapMaximumMicros{0};
    std::uint64_t sendGapMaximumAtMicros{0};
    std::uint64_t sendGapMaximumTimelineFrame{0};
    GenerationId sendGapMaximumGeneration{0};
    std::uint32_t sendGapMaximumStreamEpoch{0};
    std::uint64_t lastSendMonotonicMicros{0};
    std::uint64_t lastSendTimelineFrame{0};
    GenerationId lastSendGeneration{0};
    std::uint32_t lastSendStreamEpoch{0};
    std::uint64_t packetsReceived{0};
    std::uint64_t relayEchoes{0}; // own packets the relay returned: the uplink delivery rate
    VoiceCodec sendCodec{VoiceCodec::Opus};
    std::uint64_t droppedSendBlocks{0};
    std::uint64_t decodeUnderruns{0};
    std::uint64_t receiveQueueOverruns{0};
    std::uint64_t staleBlocks{0};
    std::uint32_t sendQueueFillFrames{0};
    std::uint32_t receiveQueueFillFrames{0};
    std::uint32_t playoutDelayFrames{0};
    std::uint32_t sharedTargetDelayFrames{0};
    std::uint32_t advertisedTargetDelayFrames{0};
    std::uint32_t roomPlayoutDelayFrames{0};
    bool sharedTimeline{false};
    bool transportRunning{false};
    bool sendEnabled{false};
    std::uint32_t directPeerCount{0};
    JitterBufferSnapshot jitter{};
    NetworkTimingSnapshot timing{};
    float roundTripP50Ms{0.0F};
    float roundTripP95Ms{0.0F};
    float roundTripP99Ms{0.0F};
    std::vector<RemoteParticipantDiagnostics> participants;
    std::uint64_t normalizedSendNonzeroBlocks{0};
    float normalizedSendPeak{0.0F};
    GenerationId generation{0};
    std::uint32_t streamEpoch{0};
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
    void setRoomClock(std::int64_t serverMicros, std::int64_t localMicros) noexcept;
    [[nodiscard]] bool hasRoomClock() const noexcept {
        return roomClockConfigured_.load(std::memory_order_acquire);
    }
    [[nodiscard]] std::uint64_t roomTimelineFrame(MonotonicTicks at,
                                                  std::uint64_t fallback) const noexcept;
    void setSharedTimeline(bool enabled);
    [[nodiscard]] bool sharedTimelineEnabled() const noexcept {
        return sharedTimeline_.load(std::memory_order_acquire);
    }
    [[nodiscard]] std::uint32_t sharedTargetDelayFrames() const noexcept {
        return sharedTargetDelayFrames_.load(std::memory_order_acquire);
    }
    /** How far the rendered room mix trails the musical position stored in a performance file. */
    [[nodiscard]] std::uint32_t remoteRecordingDelayFrames() const noexcept {
        return sharedTimelineEnabled() ? sharedTargetDelayFrames() : 0U;
    }
    /** Fixed server-owned room deadline. Every listener and the backing track use this delay. */
    void setRoomPlayoutDelay(float milliseconds) noexcept;
    void setDiagnosticRequestedDelay(float milliseconds) noexcept;
    void resetDiagnosticLateAudioCutSeries() noexcept;
    [[nodiscard]] std::uint32_t roomPlayoutDelayFrames() const noexcept {
        return sharedTimelineEnabled()
                   ? roomPlayoutDelayFrames_.load(std::memory_order_acquire)
                   : 0U;
    }
    /**
     * Follow one singer (the room leader): that voice plays at its own measured delay, which the
     * song is shifted by, so this singer hears the leader on the beat. Empty id stops following.
     * Only the leader's route counts, so followers never add each other's shifts up. Following
     * engages only while the leader's delay exceeds `minimumDelayMs`; below it the room stays
     * symmetric, where everyone hears everyone that little bit late.
     */
    /** While a song is underway the follow shift and mode stay as they are (render thread). */
    void setFollowLocked(bool locked) noexcept {
        followLocked_.store(locked, std::memory_order_relaxed);
    }
    void setFollowedParticipant(std::string_view participantId,
                                std::uint32_t minimumDelayMs = DefaultRoomFollowMinimumMs) noexcept;
    /** Playout delay of the followed singer's voice; 0 when not following. */
    [[nodiscard]] std::uint32_t followTargetDelayFrames() const noexcept {
        return followedKey_.load(std::memory_order_acquire) != 0 && sharedTimelineEnabled() &&
                       followEngaged_.load(std::memory_order_acquire)
                   ? followTargetDelayFrames_.load(std::memory_order_acquire)
                   : 0U;
    }
    [[nodiscard]] bool addRemoteParticipant(std::string participantId);
    [[nodiscard]] bool removeRemoteParticipant(std::string_view participantId) noexcept;
    void clearRemoteParticipants() noexcept;
    [[nodiscard]] bool setRemoteGain(std::string_view participantId, float gain) noexcept;
    [[nodiscard]] bool setRemoteMute(std::string_view participantId, bool muted) noexcept;
    [[nodiscard]] bool setRemoteEffect(std::string_view participantId, std::string_view effect,
                                       float value) noexcept;
    [[nodiscard]] bool setDirectPeer(std::string participantId, std::string host,
                                     std::uint16_t port, std::uint64_t receiveToken);
    void clearDirectPeers() noexcept;
    [[nodiscard]] std::uint16_t localPort() const noexcept {
        return localPort_;
    }
    void startSend(const std::string& host, std::uint16_t port);
    void startReceive(std::uint16_t port);
    void stop() noexcept;
    void pushLocal(GenerationId generation, std::span<const float> samples, std::uint32_t frames,
                   std::uint64_t timestampFrame = 0, float gain = 1.0F) noexcept;
    [[nodiscard]] std::uint32_t renderRemote(GenerationId generation, std::span<float> output,
                                             std::uint32_t frames,
                                             std::uint64_t timelineFrame = 0) noexcept;
    [[nodiscard]] NetworkDiagnostics diagnostics() const;
    /** K-weighted quiet-phrase level of the quietest remote voice as heard (participant volume
     *  applied); 0 if none yet. */

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
        std::atomic<std::int32_t> alignmentErrorFrames{0};
        std::atomic<std::uint64_t> lateAudioCuts{0};
        std::atomic<std::uint32_t> consecutiveLateAudioCuts{0};
        std::atomic<std::uint32_t> maximumConsecutiveLateAudioCuts{0};
        std::atomic<std::uint64_t> firstLateAudioCutFrame{0};
        std::atomic<std::uint64_t> lastLateAudioCutFrame{0};
        VoiceLoudness voice; // how loud this participant sounds while singing (render thread notes)
        // Which route delivered each packet first: the relay, or directly from the peer.
        std::atomic<std::uint64_t> relayFirstPackets{0};
        std::atomic<std::uint64_t> directFirstPackets{0};
        PcmRingBuffer queue;
        mutable RealtimeMutex jitterMutex;
        AdaptiveJitterBuffer jitter;
        NetworkTimingEstimator timing;
        // Opus decoders carry state across frames for loss concealment, so each participant owns
        // one; sharing a single decoder across participants would corrupt everyone's audio. Only
        // touched from receiveMain(), never from the realtime render callback.
        std::unique_ptr<OpusVoiceDecoder> decoder;
        PcmLossConcealer pcmLossConcealer;
        bool timelineInitialized{false};
        bool timelineExcluded{false};
        std::uint32_t recoveryPackets{0};
        std::uint64_t playoutPacketIndex{0};
        std::uint32_t desiredDelayFrames{0};
        std::uint32_t followNeedFrames{0}; // the steadier level a follower shifts its song by
        VoiceLatenessTracker lateness;     // receive thread; read by diagnostics under remoteMutex_
        // The server mix's return route alone (see returnRouteLatenessFrames) and how late the
        // latest voice it carries reached the relay (its singers' arrival); same thread rules.
        VoiceLatenessTracker returnRoute;
        VoiceLatenessTracker arrivalRoute;
        std::uint32_t remoteStreamEpoch{0};
        RecentAudioSequenceWindow receivedSequences;
        std::atomic<std::uint64_t> lastPacketMicros{0};
        std::array<RoomPacketDecisionTrace, 96> packetTrace{};
        std::array<bool, 20> recentPacketCuts{};
        std::uint32_t packetTraceNext{0};
        std::uint32_t packetTraceCount{0};
        std::uint32_t recentPacketNext{0};
        std::uint32_t recentCutCount{0};
        std::uint32_t packetTracePostCut{0};
        bool packetTraceFrozen{false};
        // Codec of the last delivered packet: a PCM gap is concealed with silence (receive thread).
        VoiceCodec lastCodec{VoiceCodec::Opus};
        // Loss of this participant's stream at this receiver, per thousand, over the last window
        // of packets; reported back to it in our own packets (receive thread writes).
        std::uint32_t lossWindowPackets{0};
        std::uint64_t lossWindowStart{0};
        std::atomic<std::uint32_t> lossPermille{0};
        // What this participant reports about our stream, and when (receive thread writes).
        std::atomic<std::uint32_t> reportedLossPermille{0};
        std::atomic<std::uint64_t> reportedAtMicros{0};
        std::atomic<std::uint32_t> serverIngressFrames{0};
        std::atomic<std::uint32_t> serverMixWaitFrames{0};
        ReturnPathStageTrace returnStages;
        std::atomic<std::uint64_t> decodedNonzeroPackets{0};
        std::atomic<float> decodedPeak{0.0F};
        std::atomic<std::uint64_t> queuedNonzeroPackets{0};
        std::atomic<float> queuedPeak{0.0F};
        std::atomic<std::uint64_t> renderedNonzeroBlocks{0};
        std::atomic<float> renderedPeak{0.0F};
    };

    struct DirectPeer {
        std::string participantId;
        std::string host;
        std::uint16_t port{0};
        std::uint64_t receiveToken{0};
    };

    [[nodiscard]] static std::uint32_t participantKey(std::string_view id) noexcept;
    static void noteLateAudioCut(RemoteSlot& slot, std::uint64_t cutFrame) noexcept;
    static void noteOnTimeAudioPacket(RemoteSlot& slot) noexcept;
    static void retireRemoteSlot(RemoteSlot& slot) noexcept;
    static void resetStreamReports(RemoteSlot& slot) noexcept;
    [[nodiscard]] RemoteSlot* slotForKey(std::uint32_t key) noexcept;
    [[nodiscard]] RemoteSlot* slotForId(std::string_view id) noexcept;
    [[nodiscard]] const RemoteSlot* slotForId(std::string_view id) const noexcept;
    void sendMain() noexcept;
    void applyRequestedRoomPlayoutDelay() noexcept;
    /** Worst loss the listeners report about our stream; nullopt while one has not reported. */
    [[nodiscard]] std::optional<std::uint32_t>
    worstListenerLossPermille(std::uint64_t nowMicros) const noexcept;
    void wakeSender() noexcept;
    void receiveMain() noexcept;
    void notePacketDecision(RemoteSlot& slot, RoomPacketDecisionTrace event) noexcept;

    PcmRingBuffer sendQueue_;
    struct SendBlock {
        std::uint64_t timestampFrame{0};
        std::uint32_t frames{0};
    };
    std::vector<SendBlock> sendBlocks_;
    std::atomic<std::uint64_t> sendBlockWrite_{0};
    std::atomic<std::uint64_t> sendBlockRead_{0};
    std::atomic<std::uint64_t> publishedSendFrames_{0};
    std::atomic<std::uint32_t> sendProducers_{0};
    // One socket for both directions: startReceive() binds it to the local port, startSend() then
    // connects that same bound socket to the peer, so the outbound packet that opens a NAT/firewall
    // mapping and the peer's replies both use that one local port. Two separate sockets (a bound
    // one and a separately-connected one) would make the reply arrive on a port nothing ever sent
    // from, which most home routers drop.
    UdpSocket socket_;
    // Nulled by prepare()'s stop() and (re)built there once sampleRateHz_/channels_ are known; only
    // touched from setup and sendMain(), never from the realtime render callback.
    std::unique_ptr<OpusVoiceEncoder> encoder_;
    VoiceCodecPolicy codecPolicy_; // send thread
    std::atomic<VoiceCodec> sendCodec_{VoiceCodec::Opus};
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
    std::atomic<std::uint64_t> sendWakeSequence_{0};
    std::atomic<bool> running_{false};
    std::atomic<bool> sendEnabled_{false};
    bool packetTraceEnabled_{false};
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
    // Room-timeline presentation frame of the next remote sample a render will take.
    std::atomic<std::uint64_t> localTimelineFrame_{0};
    // Render thread only: the continuous timeline outgoing voice blocks are stamped on.
    VoiceTimelineSmoother sendTimeline_;
    GenerationId sendTimelineGeneration_{0};
    std::atomic<bool> sharedTimeline_{false};
    std::atomic<bool> roomClockConfigured_{false};
    std::atomic<std::int64_t> roomClockOffsetMicros_{0};
    std::atomic<std::uint32_t> sharedTargetDelayFrames_{0};
    std::atomic<std::uint32_t> roomPlayoutDelayMicros_{0};
    std::atomic<std::uint32_t> requestedRoomPlayoutDelayMicros_{0};
    std::atomic<std::uint32_t> roomPlayoutDelayFrames_{0};
    std::atomic<std::uint32_t> followedKey_{0};
    std::atomic<std::uint32_t> followTargetDelayFrames_{0};
    std::atomic<std::uint32_t> followEngageFrames_{0};
    std::atomic<bool> followEngaged_{false};
    std::atomic<bool> followLocked_{false};
    std::uint32_t followPacketsAbove_{0}; // receive thread
    // Receive-thread-owned round: within one short media-time epoch the target only rises, so
    // one old latency spike cannot become a permanent delay.
    std::atomic<std::uint64_t> sharedTargetEpoch_{UINT64_MAX};
    // This receiver's measured worst inbound route, adapted towards its need.
    std::atomic<std::uint32_t> advertisedTargetDelayFrames_{0};
    std::atomic<std::uint32_t> diagnosticRequestedDelayMicros_{0};
    std::atomic<std::uint64_t> packetsSent_{0};
    std::atomic<std::uint64_t> sendGapLatestMicros_{0};
    std::atomic<std::uint64_t> sendGapMaximumMicros_{0};
    std::atomic<std::uint64_t> sendGapMaximumAtMicros_{0};
    std::atomic<std::uint64_t> sendGapMaximumTimelineFrame_{0};
    std::atomic<GenerationId> sendGapMaximumGeneration_{GenerationId{0}};
    std::atomic<std::uint32_t> sendGapMaximumStreamEpoch_{0};
    std::atomic<std::uint64_t> lastSendMonotonicMicros_{0};
    std::atomic<std::uint64_t> lastSendTimelineFrame_{0};
    std::atomic<GenerationId> lastSendGeneration_{GenerationId{0}};
    std::atomic<std::uint32_t> lastSendStreamEpoch_{0};
    std::atomic<std::uint64_t> packetsReceived_{0};
    std::atomic<std::uint64_t> relayEchoes_{0};
    std::atomic<std::uint64_t> droppedSendBlocks_{0};
    std::atomic<std::uint64_t> staleBlocks_{0};
    std::atomic<std::uint64_t> normalizedSendNonzeroBlocks_{0};
    std::atomic<float> normalizedSendPeak_{0.0F};
    static constexpr std::size_t ProbeHistorySize = 2048;
    std::array<std::atomic<std::uint32_t>, ProbeHistorySize> sentProbeSequences_{};
    std::array<std::atomic<std::uint64_t>, ProbeHistorySize> sentProbeMicros_{};
    NetworkTimingEstimator networkTiming_;
    RoundTripWindow roundTrips_;
    std::atomic<GenerationId> generation_{GenerationId{0}};
};
