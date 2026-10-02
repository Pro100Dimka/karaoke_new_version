#include "network/NetworkTestRunner.hpp"

#include <array>
#include <ostream>
#include <ranges>
#include <stdexcept>

namespace {
constexpr std::uint32_t DerivedSeedMask = 0x9e3779b9U;

std::string_view valueAfter(std::span<const std::string_view> arguments, std::size_t& index) {
    if (index + 1U >= arguments.size())
        throw std::invalid_argument("missing value after " + std::string(arguments[index]));
    return arguments[++index];
}

template <typename Option>
const Option* findOption(std::span<const Option> options, std::string_view name) {
    const auto match =
        std::ranges::find_if(options, [name](const auto& option) { return option.name == name; });
    return match == options.end() ? nullptr : &*match;
}

int runClientCommand(std::span<const std::string_view> arguments, std::ostream& output) {
    struct StringOption {
        std::string_view name;
        std::string NetworkProcessClientRequest::* field;
    };
    struct PortOption {
        std::string_view name;
        std::uint16_t NetworkProcessClientRequest::* field;
    };
    struct IntegerOption {
        std::string_view name;
        std::uint64_t NetworkProcessClientRequest::* field;
        int base;
    };
    constexpr std::array stringOptions{
        StringOption{"--input", &NetworkProcessClientRequest::inputPath},
        StringOption{"--backing", &NetworkProcessClientRequest::backingPath},
        StringOption{"--output", &NetworkProcessClientRequest::outputPath},
        StringOption{"--local-id", &NetworkProcessClientRequest::localId},
        StringOption{"--remote-id", &NetworkProcessClientRequest::remoteId},
        StringOption{"--host", &NetworkProcessClientRequest::remoteHost},
    };
    constexpr std::array portOptions{
        PortOption{"--local-port", &NetworkProcessClientRequest::localPort},
        PortOption{"--remote-port", &NetworkProcessClientRequest::remotePort},
    };
    constexpr std::array integerOptions{
        IntegerOption{"--token", &NetworkProcessClientRequest::token, 16},
        IntegerOption{"--start-at-ms", &NetworkProcessClientRequest::startAtUnixMs, 10},
        IntegerOption{"--room-server-unix-ms", &NetworkProcessClientRequest::roomServerUnixMs, 10},
        IntegerOption{"--media-offset-frames", &NetworkProcessClientRequest::mediaOffsetFrames, 10},
        IntegerOption{"--duration-seconds", &NetworkProcessClientRequest::durationSeconds, 10},
        IntegerOption{"--warmup-seconds", &NetworkProcessClientRequest::warmupSeconds, 10},
        IntegerOption{"--stall-at-ms", &NetworkProcessClientRequest::stallAtMs, 10},
        IntegerOption{"--stall-duration-ms", &NetworkProcessClientRequest::stallDurationMs, 10},
        IntegerOption{"--room-playout-delay-ms", &NetworkProcessClientRequest::roomPlayoutDelayMs, 10},
    };

    NetworkProcessClientRequest request;
    for (std::size_t index = 1; index < arguments.size(); ++index) {
        const auto name = arguments[index];
        const auto value = valueAfter(arguments, index);
        if (const auto* stringOption = findOption<StringOption>(stringOptions, name))
            request.*(stringOption->field) = value;
        else if (const auto* portOption = findOption<PortOption>(portOptions, name))
            request.*(portOption->field) =
                static_cast<std::uint16_t>(std::stoul(std::string(value)));
        else if (const auto* integerOption = findOption<IntegerOption>(integerOptions, name))
            request.*(integerOption->field) =
                std::stoull(std::string(value), nullptr, integerOption->base);
        else
            throw std::invalid_argument("unknown network-test-client option: " + std::string(name));
    }
    if (request.inputPath.empty() || request.outputPath.empty() || request.localId.empty() ||
        request.remoteId.empty() || request.remotePort == 0 || request.token == 0)
        throw std::invalid_argument(
            "--network-test-client requires --input, --output, --local-id, --remote-id, "
            "--remote-port and --token");
    return runNetworkProcessClient(request, output);
}

NetworkTestRequest parseOfflineRequest(std::span<const std::string_view> arguments) {
    struct StringOption {
        std::string_view name;
        std::string NetworkTestRequest::* field;
    };
    struct ProfileFramesOption {
        std::string_view name;
        NetworkImpairmentProfile NetworkTestRequest::* profile;
        std::uint32_t NetworkImpairmentProfile::* field;
    };
    struct ProfileRatioOption {
        std::string_view name;
        NetworkImpairmentProfile NetworkTestRequest::* profile;
        double NetworkImpairmentProfile::* field;
    };
    constexpr std::array stringOptions{
        StringOption{"--input", &NetworkTestRequest::inputPath},
        StringOption{"--output", &NetworkTestRequest::outputPath},
    };
    constexpr std::array frameOptions{
        ProfileFramesOption{"--latency-a", &NetworkTestRequest::clientA,
                            &NetworkImpairmentProfile::baseLatencyMs},
        ProfileFramesOption{"--latency-b", &NetworkTestRequest::clientB,
                            &NetworkImpairmentProfile::baseLatencyMs},
        ProfileFramesOption{"--jitter-a", &NetworkTestRequest::clientA,
                            &NetworkImpairmentProfile::jitterMs},
        ProfileFramesOption{"--jitter-b", &NetworkTestRequest::clientB,
                            &NetworkImpairmentProfile::jitterMs},
    };
    constexpr std::array ratioOptions{
        ProfileRatioOption{"--loss-a", &NetworkTestRequest::clientA,
                           &NetworkImpairmentProfile::packetLoss},
        ProfileRatioOption{"--loss-b", &NetworkTestRequest::clientB,
                           &NetworkImpairmentProfile::packetLoss},
        ProfileRatioOption{"--duplicate-a", &NetworkTestRequest::clientA,
                           &NetworkImpairmentProfile::duplicateRate},
        ProfileRatioOption{"--duplicate-b", &NetworkTestRequest::clientB,
                           &NetworkImpairmentProfile::duplicateRate},
        ProfileRatioOption{"--reorder-a", &NetworkTestRequest::clientA,
                           &NetworkImpairmentProfile::reorderRate},
        ProfileRatioOption{"--reorder-b", &NetworkTestRequest::clientB,
                           &NetworkImpairmentProfile::reorderRate},
        ProfileRatioOption{"--drift-a", &NetworkTestRequest::clientA,
                           &NetworkImpairmentProfile::clockDriftPpm},
        ProfileRatioOption{"--drift-b", &NetworkTestRequest::clientB,
                           &NetworkImpairmentProfile::clockDriftPpm},
    };

    NetworkTestRequest request;
    const auto scenarios = std::array{
        std::pair{"normal", std::pair{NetworkImpairmentProfile{.baseLatencyMs = 25,
                                                                .jitterMs = 1},
                                       NetworkImpairmentProfile{.baseLatencyMs = 30,
                                                                .jitterMs = 2}}},
        std::pair{"wifi", std::pair{NetworkImpairmentProfile{.baseLatencyMs = 35,
                                                              .jitterMs = 8,
                                                              .packetLoss = 0.002},
                                     NetworkImpairmentProfile{.baseLatencyMs = 45,
                                                              .jitterMs = 12,
                                                              .packetLoss = 0.005}}},
        std::pair{"bad-wifi", std::pair{NetworkImpairmentProfile{.baseLatencyMs = 50,
                                                                  .jitterMs = 15,
                                                                  .packetLoss = 0.01,
                                                                  .reorderRate = 0.01},
                                         NetworkImpairmentProfile{.baseLatencyMs = 80,
                                                                  .jitterMs = 25,
                                                                  .packetLoss = 0.02,
                                                                  .reorderRate = 0.01}}},
        std::pair{"asymmetric", std::pair{NetworkImpairmentProfile{.baseLatencyMs = 10,
                                                                    .jitterMs = 2},
                                           NetworkImpairmentProfile{.baseLatencyMs = 35,
                                                                    .jitterMs = 5}}},
        std::pair{"spikes", std::pair{NetworkImpairmentProfile{
                                           .baseLatencyMs = 25,
                                           .jitterMs = 3,
                                           .latencyStages = {{2.0, 25}, {3.0, 90}, {5.0, 30},
                                                             {6.0, 120}, {8.0, 40}}},
                                       NetworkImpairmentProfile{.baseLatencyMs = 35,
                                                                .jitterMs = 5,
                                                                .latencyStages = {{2.0, 35},
                                                                                  {3.0, 100},
                                                                                  {5.0, 45},
                                                                                  {6.0, 130},
                                                                                  {8.0, 50}}}}},
    };
    const auto applyScenario = [&request, &scenarios](std::string_view name) {
        const auto match = std::ranges::find_if(
            scenarios, [name](const auto& scenario) { return scenario.first == name; });
        if (match == scenarios.end())
            throw std::invalid_argument("unknown network-test scenario: " + std::string(name));
        request.clientA = match->second.first;
        request.clientB = match->second.second;
    };
    applyScenario("normal");
    for (std::size_t index = 1; index < arguments.size(); ++index) {
        const auto name = arguments[index];
        const auto value = valueAfter(arguments, index);
        if (const auto* stringOption = findOption<StringOption>(stringOptions, name)) {
            request.*(stringOption->field) = value;
        } else if (const auto* frameOption = findOption<ProfileFramesOption>(frameOptions, name)) {
            (request.*(frameOption->profile)).*(frameOption->field) =
                static_cast<std::uint32_t>(std::stoul(std::string(value)));
        } else if (const auto* ratioOption = findOption<ProfileRatioOption>(ratioOptions, name)) {
            (request.*(ratioOption->profile)).*(ratioOption->field) = std::stod(std::string(value));
        } else if (name == "--seconds") {
            request.maximumInputSeconds =
                static_cast<std::uint32_t>(std::stoul(std::string(value)));
        } else if (name == "--seed") {
            request.seedA = static_cast<std::uint32_t>(std::stoul(std::string(value)));
            request.seedB = request.seedA ^ DerivedSeedMask;
        } else if (name == "--scenario") {
            applyScenario(value);
        } else {
            throw std::invalid_argument("unknown network-test option: " + std::string(name));
        }
    }
    if (request.inputPath.empty() || request.outputPath.empty())
        throw std::invalid_argument("--network-test requires --input and --output");
    return request;
}

void writePathReport(std::ostream& output, std::string_view name,
                     const NetworkPathTestMetrics& metrics) {
    output << '"' << name << "\":{"
           << "\"sentPackets\":" << metrics.sentPackets << ','
           << "\"deliveredPackets\":" << metrics.deliveredPackets << ','
           << "\"droppedPackets\":" << metrics.droppedPackets << ','
           << "\"duplicatePackets\":" << metrics.duplicatePackets << ','
           << "\"reorderedPackets\":" << metrics.reorderedPackets << ','
           << "\"latePackets\":" << metrics.latePackets << ','
           << "\"clockOffsetMs\":" << metrics.clockOffsetMs << ','
           << "\"clockDriftPpm\":" << metrics.clockDriftPpm << ','
           << "\"alignmentDelayFrames\":" << metrics.alignmentDelayFrames << '}';
}

int runOfflineCommand(std::span<const std::string_view> arguments, std::ostream& output) {
    const auto report = runNetworkTest(parseOfflineRequest(arguments));
    output << '{' << "\"offsetSamples\":" << report.offsetSamples << ','
           << "\"offsetMs\":" << report.offsetMs << ','
           << "\"peakCorrelation\":" << report.peakCorrelation << ','
           << "\"interPeerAlignmentErrorSamples\":" << report.interPeerAlignmentErrorSamples << ',';
    writePathReport(output, "clientA", report.clientA);
    output << ',';
    writePathReport(output, "clientB", report.clientB);
    output << "}\n";
    return report.interPeerAlignmentErrorSamples <= 96U ? 0 : 2;
}
} // namespace

int runNetworkTestCommand(std::span<const std::string_view> arguments, std::ostream& output,
                          std::ostream& errors) {
    if (arguments.empty())
        return -1;
    const auto mode = arguments.front();
    if (mode != "--network-test" && mode != "--network-test-client")
        return -1;
    try {
        return mode == "--network-test-client" ? runClientCommand(arguments, output)
                                               : runOfflineCommand(arguments, output);
    } catch (const std::exception& exception) {
        errors << (mode == "--network-test-client" ? "network-test-client failed: "
                                                   : "network-test failed: ")
               << exception.what() << '\n';
        return 1;
    }
}
