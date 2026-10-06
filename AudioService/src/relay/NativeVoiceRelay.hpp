#pragma once

#include <array>
#include <cstddef>
#include <cstdint>
#include <map>
#include <limits>
#include <set>
#include <span>
#include <string>
#include <string_view>
#include <unordered_map>
#include <vector>

#include "network/RoomAudioContract.hpp"

struct RelayEndpoint {
    std::string host;
    std::uint16_t port{0};
    bool operator==(const RelayEndpoint&) const = default;
};

struct RelayDatagram {
    RelayEndpoint target;
    std::vector<std::byte> bytes;
};

/**
 * How early a participant's packets reach the relay before their position closes (deadline slack),
 * kept as a fixed histogram so the voice thread neither allocates nor formats anything.
 */
struct RelayDeadlineSlack {
    static constexpr double BinMilliseconds = 0.5;
    static constexpr std::size_t BinCount = 256; // -64 ms .. +64 ms, the ends saturate
    std::array<std::uint32_t, BinCount> bins{};
    std::uint64_t packets{0};
    std::uint64_t negativePackets{0};
    double minimumMs{std::numeric_limits<double>::infinity()};

    void note(double slackMs) noexcept;
    /** The slack `permille`/1000 of the packets stayed below (lower bin edge), or 0 when empty. */
    [[nodiscard]] double quantileMs(std::uint32_t permille) const noexcept;
};

struct RelayRecipientMetrics {
    std::uint64_t packets{0};
    double latestGapMs{0.0};
    double maximumGapMs{0.0};
    std::uint64_t stalls{0};
    double lastSendMonotonicMs{0.0};
    std::uint64_t pipelinePosition{0};
    std::uint32_t pipelineGeneration{0};
    std::uint64_t completePositions{0};
    std::uint64_t partialPositions{0};
    std::uint64_t missingContributions{0};
    std::uint64_t ingressNonzeroPackets{0};
    std::int32_t ingressPeak{0};
    std::uint64_t recipientNonzeroPackets{0};
    std::int32_t recipientPeak{0};
    RelayDeadlineSlack ingressSlack{}; // this participant as a singer
};

/** Native real-time room mixer. Control-plane mutations happen before/around packet processing;
 * the service wrapper serializes them with receive/flush calls. */
class NativeVoiceRelay {
  public:
    explicit NativeVoiceRelay(
        double collectionWindowMilliseconds = room_audio_contract::CollectionBudgetMilliseconds);
    static std::uint32_t participantKey(std::string_view participant) noexcept;

    void expect(std::string room, std::string participant, std::uint64_t token);
    void forget(std::string_view participant);
    void setEligibleParticipants(std::string_view room,
                                 std::span<const std::string_view> participants);
    void setRecipientSourceGain(std::string_view room, std::string_view recipient,
                                std::string_view source, float gain);
    /**
     * The room's fixed deadline and the return reserve the room timing policy chose: each position
     * closes that long before its deadline so the mix still reaches the slowest live listener.
     */
    void setRoomPlayoutDelay(
        std::string_view room, double milliseconds,
        double returnReserveMilliseconds = room_audio_contract::FallbackReturnReserveMilliseconds);
    void setGeneration(std::string_view room, std::uint32_t generation);

    [[nodiscard]] std::vector<RelayDatagram> receive(std::span<const std::byte> bytes,
                                                      RelayEndpoint source,
                                                      double monotonicSeconds,
                                                      double wallSeconds);
    [[nodiscard]] std::vector<RelayDatagram> flush(double monotonicSeconds,
                                                    double wallSeconds);
    [[nodiscard]] RelayRecipientMetrics recipientMetrics(
        std::string_view room, std::string_view participant) const;
    [[nodiscard]] std::map<std::string, float> participantLevels(
        std::string_view room, double monotonicSeconds) const;
    [[nodiscard]] std::size_t excludedParticipants(std::string_view room) const;

  private:
    struct Participant {
        std::string room;
        std::string id;
        std::uint32_t key{0};
        std::uint64_t token{0};
        RelayEndpoint endpoint;
        bool hasEndpoint{false};
        bool active{false};
        double lastProbeEcho{0.0};
        float level{0.0F};
        double lastLevelMonotonic{0.0};
    };
    struct Position {
        std::uint64_t timestamp{0};
        std::uint16_t frames{0};
        bool operator<(const Position& other) const noexcept {
            return timestamp < other.timestamp ||
                   (timestamp == other.timestamp && frames < other.frames);
        }
    };
    struct Pending {
        std::map<std::uint32_t, std::vector<std::int16_t>> inputs;
        // How late each input reached the relay after its position (transport frames).
        std::map<std::uint32_t, std::uint32_t> ingressFrames;
        std::set<std::uint32_t> sentRecipients;
        double deadlineMonotonic{std::numeric_limits<double>::infinity()};
        double partialDeadlineMonotonic{std::numeric_limits<double>::infinity()};
        double readyMonotonic{std::numeric_limits<double>::infinity()};
    };
    struct Room {
        std::set<std::uint32_t> members;
        std::set<std::uint32_t> eligible;
        std::map<Position, Pending> pending;
        std::set<Position> mixed;
        std::map<std::pair<std::uint32_t, std::uint32_t>, float> gains;
        std::unordered_map<std::uint32_t, std::uint32_t> sequences;
        std::unordered_map<std::uint32_t, RelayRecipientMetrics> recipientMetrics;
        std::set<std::uint32_t> started;
        std::set<std::uint32_t> excluded;
        std::unordered_map<std::uint32_t, std::uint32_t> consecutiveMisses;
        std::unordered_map<std::uint32_t, double> missStartedMonotonic;
        std::unordered_map<std::uint32_t, std::uint32_t> recoveryPackets;
        std::unordered_map<std::uint32_t, std::uint64_t> recoveryNextFrame;
        std::uint32_t generation{1};
        std::uint64_t latestInputEnd{0};
        std::uint64_t nextTimelinePosition{0};
        double nextSendMonotonic{0.0};
        double nextEmptyCloseMonotonic{0.0};
        double playoutDelaySeconds{0.0};
        double returnReserveSeconds{room_audio_contract::FallbackReturnReserveMilliseconds / 1'000.0};
        std::uint64_t completePositions{0};
        std::uint64_t partialPositions{0};
        std::unordered_map<std::uint32_t, std::uint64_t> missingContributions;
    };

    [[nodiscard]] std::vector<RelayDatagram> finish(std::string_view roomId,
                                                     const Position& position,
                                                     Pending& pending,
                                                     double sentAt,
                                                     double sentWall,
                                                     bool force);
    [[nodiscard]] static double collectionAllowance(const Room& room) noexcept;
    [[nodiscard]] bool hasReadyRecipient(const Room& room, const Pending& pending) const;
    [[nodiscard]] bool positionFinished(const Room& room, const Pending& pending) const;
    static void finalizePosition(Room& room, const Pending& pending, double monotonicSeconds);
    [[nodiscard]] static std::set<std::uint32_t> expected(const Room& room);
    static void resetTimeline(Room& room, bool newGeneration);
    static void markMixed(Room& room, const Position& position);
    static void updateHealth(Room& room, const Pending& pending, double monotonicSeconds);
    static void advanceRecovery(Room& room, std::uint32_t participant,
                                std::uint64_t mediaStart, std::uint16_t frames,
                                double wallSeconds);

    std::unordered_map<std::uint32_t, Participant> participants_;
    std::unordered_map<std::uint64_t, std::uint32_t> tokenKeys_;
    std::unordered_map<std::string, Room> rooms_;
    double collectionWindowSeconds_{room_audio_contract::CollectionBudgetMilliseconds / 1'000.0};
};
