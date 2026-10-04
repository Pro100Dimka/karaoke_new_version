#pragma once

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

struct RelayEndpoint {
    std::string host;
    std::uint16_t port{0};
    bool operator==(const RelayEndpoint&) const = default;
};

struct RelayDatagram {
    RelayEndpoint target;
    std::vector<std::byte> bytes;
};

struct RelayRecipientMetrics {
    std::uint64_t packets{0};
    double latestGapMs{0.0};
    double maximumGapMs{0.0};
    std::uint64_t stalls{0};
    double lastSendMonotonicMs{0.0};
    std::uint64_t pipelinePosition{0};
    std::uint32_t pipelineGeneration{0};
};

/** Native real-time room mixer. Control-plane mutations happen before/around packet processing;
 * the service wrapper serializes them with receive/flush calls. */
class NativeVoiceRelay {
  public:
    static std::uint32_t participantKey(std::string_view participant) noexcept;

    void expect(std::string room, std::string participant, std::uint64_t token);
    void forget(std::string_view participant);
    void setEligibleParticipants(std::string_view room,
                                 std::span<const std::string_view> participants);
    void setRecipientSourceGain(std::string_view room, std::string_view recipient,
                                std::string_view source, float gain);
    void setRoomPlayoutDelay(std::string_view room, double milliseconds);
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
        double deadlineMonotonic{std::numeric_limits<double>::infinity()};
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
        double playoutDelaySeconds{0.0};
    };

    [[nodiscard]] std::vector<RelayDatagram> finish(std::string_view roomId,
                                                     const Position& position,
                                                     Pending& pending,
                                                     double sentAt);
    [[nodiscard]] static std::set<std::uint32_t> expected(const Room& room);
    static void resetTimeline(Room& room, bool newGeneration);
    static void updateHealth(Room& room, const Pending& pending, double monotonicSeconds);
    static void advanceRecovery(Room& room, std::uint32_t participant,
                                std::uint64_t mediaStart, std::uint16_t frames,
                                double wallSeconds);

    std::unordered_map<std::uint32_t, Participant> participants_;
    std::unordered_map<std::uint64_t, std::uint32_t> tokenKeys_;
    std::unordered_map<std::string, Room> rooms_;
};
