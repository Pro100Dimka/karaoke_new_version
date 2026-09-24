#pragma once

#include <cstdint>
#include <iosfwd>
#include <span>
#include <string>
#include <string_view>
#include <vector>

struct NetworkLatencyStage {
    double untilSeconds{0.0};
    std::uint32_t latencyMs{0};
};

struct NetworkImpairmentProfile {
    std::uint32_t baseLatencyMs{0};
    std::uint32_t jitterMs{0};
    double packetLoss{0.0};
    double duplicateRate{0.0};
    double reorderRate{0.0};
    double clockDriftPpm{0.0};
    std::vector<NetworkLatencyStage> latencyStages;
};

struct NetworkPathTestMetrics {
    std::uint64_t sentPackets{0};
    std::uint64_t deliveredPackets{0};
    std::uint64_t droppedPackets{0};
    std::uint64_t duplicatePackets{0};
    std::uint64_t reorderedPackets{0};
    std::uint64_t latePackets{0};
    std::uint32_t maximumQueueFrames{0};
    float clockOffsetMs{0.0F};
    float clockDriftPpm{0.0F};
    std::uint32_t alignmentDelayFrames{0};
};

struct NetworkTestRequest {
    std::string inputPath;
    std::string outputPath;
    NetworkImpairmentProfile clientA{};
    NetworkImpairmentProfile clientB{};
    std::uint32_t seedA{12'345};
    std::uint32_t seedB{54'321};
    std::uint32_t maximumInputSeconds{15};
    std::uint32_t correlationWindowFrames{0};
};

struct NetworkAlignmentReport {
    std::int32_t offsetSamples{0};
    double offsetMs{0.0};
    double peakCorrelation{0.0};
    std::uint32_t interPeerAlignmentErrorSamples{0};
    NetworkPathTestMetrics clientA{};
    NetworkPathTestMetrics clientB{};
};

struct NetworkProcessClientRequest {
    std::string inputPath;
    std::string backingPath;
    std::string outputPath;
    std::string localId;
    std::string remoteId;
    std::string remoteHost{"127.0.0.1"};
    std::uint16_t localPort{0};
    std::uint16_t remotePort{0};
    std::uint64_t token{0};
    std::uint64_t startAtUnixMs{0};
    std::uint64_t mediaOffsetFrames{0};
    std::uint64_t durationSeconds{15};
    std::uint64_t warmupSeconds{2};
    std::uint64_t stallAtMs{0};
    std::uint64_t stallDurationMs{0};
};

struct NetworkDriftReport {
    std::uint64_t virtualPackets{0};
    std::uint32_t maximumQueueFrames{0};
    std::uint32_t alignmentErrorSamples{0};
    double measuredClockDriftPpm{0.0};
    double peakCorrelation{0.0};
};

[[nodiscard]] NetworkAlignmentReport runNetworkTest(const NetworkTestRequest& request);
[[nodiscard]] NetworkDriftReport runVirtualClockDriftTest(std::int32_t driftPpm,
                                                           std::uint32_t durationSeconds,
                                                           std::uint32_t seed);
int runNetworkProcessClient(const NetworkProcessClientRequest& request, std::ostream& output);

// Returns -1 when the normal service mode was requested, otherwise an executable exit code.
int runNetworkTestCommand(std::span<const std::string_view> arguments,
                          std::ostream& output, std::ostream& errors);
