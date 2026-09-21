#pragma once

#include "common/Types.hpp"
#include "network/AdaptiveJitterBuffer.hpp"
#include "network/Pcm16Codec.hpp"
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
    float level{0.0F};
    std::uint32_t queueFillFrames{0};
    std::uint64_t decodeUnderruns{0};
    std::uint64_t queueOverruns{0};
    JitterBufferSnapshot jitter{};
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
    JitterBufferSnapshot jitter{};
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
    [[nodiscard]] bool addRemoteParticipant(std::string participantId);
    [[nodiscard]] bool removeRemoteParticipant(std::string_view participantId) noexcept;
    [[nodiscard]] bool setRemoteGain(std::string_view participantId, float gain) noexcept;
    [[nodiscard]] bool setRemoteMute(std::string_view participantId, bool muted) noexcept;
    void startSend(const std::string& host, std::uint16_t port);
    void startReceive(std::uint16_t port);
    void stop() noexcept;
    void pushLocal(GenerationId generation, std::span<const float> samples,
                   std::uint32_t frames) noexcept;
    [[nodiscard]] std::uint32_t renderRemote(GenerationId generation, std::span<float> output,
                                             std::uint32_t frames) noexcept;
    [[nodiscard]] NetworkDiagnostics diagnostics() const;

  private:
    struct RemoteSlot {
        std::string participantId;
        std::atomic<std::uint32_t> participantKey{0};
        std::atomic<bool> active{false};
        std::atomic<float> gain{1.0F};
        std::atomic<bool> muted{false};
        std::atomic<float> level{0.0F};
        std::atomic<std::uint64_t> decodeUnderruns{0};
        std::atomic<std::uint64_t> queueOverruns{0};
        PcmRingBuffer queue;
        mutable RealtimeMutex jitterMutex;
        AdaptiveJitterBuffer jitter;
    };

    [[nodiscard]] static std::uint32_t participantKey(std::string_view id) noexcept;
    [[nodiscard]] RemoteSlot* slotForKey(std::uint32_t key) noexcept;
    [[nodiscard]] RemoteSlot* slotForId(std::string_view id) noexcept;
    [[nodiscard]] const RemoteSlot* slotForId(std::string_view id) const noexcept;
    void sendMain() noexcept;
    void receiveMain() noexcept;

    PcmRingBuffer sendQueue_;
    UdpSocket sendSocket_;
    UdpSocket receiveSocket_;
    Pcm16Codec codec_;
    std::array<std::unique_ptr<RemoteSlot>, MaxRemoteParticipants> remote_{};
    std::vector<float> remoteScratch_;
    std::thread sendThread_;
    std::thread receiveThread_;
    std::condition_variable_any sendCv_;
    RealtimeMutex sendMutex_;
    std::atomic<bool> running_{false};
    std::atomic<bool> sendEnabled_{false};
    std::uint32_t sampleRateHz_{48000};
    std::uint32_t channels_{1};
    std::uint32_t queueFrames_{24000};
    std::uint32_t packetFrames_{240};
    std::atomic<std::uint32_t> sequence_{0};
    std::atomic<std::uint32_t> localParticipantKey_{1};
    std::atomic<std::uint64_t> packetsSent_{0};
    std::atomic<std::uint64_t> packetsReceived_{0};
    std::atomic<std::uint64_t> droppedSendBlocks_{0};
    std::atomic<std::uint64_t> staleBlocks_{0};
    std::atomic<GenerationId> generation_{GenerationId{0}};
};
