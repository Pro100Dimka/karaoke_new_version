#include "TestHarness.hpp"
#include "media/WavDecoder.hpp"
#include "network/NetworkPacket.hpp"
#include "network/NetworkTestRunner.hpp"
#include "network/UdpSocket.hpp"
#include "recording/WavWriter.hpp"

#include <array>
#include <cmath>
#include <chrono>
#include <cstdint>
#include <sstream>
#include <vector>

namespace Tests {
namespace {
constexpr std::uint32_t SampleRateHz = 48'000;
constexpr std::uint32_t PacketFrames = 240;
constexpr std::uint32_t QueueFrames = SampleRateHz / 2U;
} // namespace

void networkClickTracksAlignAfterCodecAndImpairment() {
    const std::array scenarios{
        std::pair{NetworkImpairmentProfile{.baseLatencyMs = 20},
                  NetworkImpairmentProfile{.baseLatencyMs = 20}},
        std::pair{NetworkImpairmentProfile{.baseLatencyMs = 10, .jitterMs = 2},
                  NetworkImpairmentProfile{.baseLatencyMs = 80, .jitterMs = 2}},
        std::pair{
            NetworkImpairmentProfile{.baseLatencyMs = 25, .jitterMs = 10, .duplicateRate = 0.001},
            NetworkImpairmentProfile{
                .baseLatencyMs = 60, .jitterMs = 20, .packetLoss = 0.01, .duplicateRate = 0.001}},
        std::pair{
            NetworkImpairmentProfile{.baseLatencyMs = 5, .jitterMs = 2},
            NetworkImpairmentProfile{
                .baseLatencyMs = 300, .jitterMs = 30, .packetLoss = 0.03, .duplicateRate = 0.005}},
    };
    const auto input = tempRoot / "network-click-track.wav";
    makeTestWav(input, SampleRateHz * 6U);
    for (std::size_t index = 0; index < scenarios.size(); ++index) {
        const auto& [leftProfile, rightProfile] = scenarios[index];
        NetworkTestRequest request;
        request.inputPath = input.string();
        request.clientA = leftProfile;
        request.clientB = rightProfile;
        request.seedA += static_cast<std::uint32_t>(index);
        request.seedB += static_cast<std::uint32_t>(index);
        const auto result = runNetworkTest(request);
        expect(std::abs(result.offsetSamples) <= 48,
               "two encoded click tracks align within one millisecond after network impairment");
        expect(result.peakCorrelation >= 0.80,
               "aligned click tracks retain strong correlation after loss concealment");
    }
}

void networkImpairmentMatrixKeepsAlignmentBounded() {
    constexpr std::array latenciesMs{5U, 10U, 20U, 50U, 100U, 150U, 300U};
    constexpr std::array jittersMs{0U, 2U, 5U, 10U, 30U};
    constexpr std::array losses{0.0, 0.001, 0.01, 0.03, 0.05};
    const auto input = tempRoot / "network-full-matrix-input.wav";
    // A single tone repeats every 109 frames, so it cannot identify a unique alignment peak.
    std::vector<float> probe(SampleRateHz);
    std::uint32_t random = 12'345;
    for (auto& sample : probe) {
        random = random * 1'664'525U + 1'013'904'223U;
        sample = static_cast<float>(0.3 * (static_cast<double>(random) / UINT32_MAX * 2.0 - 1.0));
    }
    {
        WavWriter writer;
        writer.open(input.string(), SampleRateHz, 1);
        writer.write(probe);
        writer.close();
    }
    for (const auto latency : latenciesMs) {
        for (const auto jitter : jittersMs) {
            for (const auto loss : losses) {
                NetworkTestRequest request;
                request.inputPath = input.string();
                request.clientA = {.baseLatencyMs = 5};
                request.clientB = {.baseLatencyMs = latency,
                                   .jitterMs = jitter,
                                   .packetLoss = loss,
                                   .duplicateRate = 0.001,
                                   .reorderRate = 0.005};
                request.correlationWindowFrames = SampleRateHz / 2U;
                const auto report = runNetworkTest(request);
                expect(
                    report.interPeerAlignmentErrorSamples <= 96U && report.peakCorrelation >= 0.80,
                    "full Opus impairment matrix aligns media timestamps within two milliseconds: offset=" +
                        std::to_string(report.offsetSamples) + " correlation=" + std::to_string(report.peakCorrelation) +
                        " latency=" + std::to_string(latency) + " loss=" + std::to_string(loss));
                expect(report.clientB.maximumQueueFrames <= QueueFrames,
                       "full Opus impairment matrix keeps the jitter queue bounded");
            }
        }
    }
}

void networkThirtyMinuteClockDriftDoesNotAccumulate() {
    constexpr std::array driftPartsPerMillion{-100, -50, 0, 50, 100};
    for (const auto drift : driftPartsPerMillion) {
        const auto report = runVirtualClockDriftTest(
            drift, 30U * 60U, 12'345U + static_cast<std::uint32_t>(drift + 100));
        expect(report.virtualPackets == 30ULL * 60ULL * VoicePacketsPerSecond,
               "clock drift test advances a full thirty-minute packet timeline without sleeping");
        expect(report.alignmentErrorSamples <= 96U && report.peakCorrelation >= 0.99,
               "two Opus paths stay aligned within two milliseconds across thirty virtual minutes");
        expect(report.maximumQueueFrames <= PacketFrames * 2U,
               "thirty-minute drift test keeps jitter memory bounded");
        expect(std::abs(report.measuredClockDriftPpm - drift) <= 2.0,
               "network timing reports the simulated device clock drift");
    }
}

void networkRunnerWritesAlignedThreeChannelEvidence() {
    const auto input = tempRoot / "network-runner-input.wav";
    const auto output = tempRoot / "network-test-output.wav";
    makeTestWav(input, 48'000U * 3U);
    NetworkTestRequest request;
    request.inputPath = input.string();
    request.outputPath = output.string();
    request.clientA = {.baseLatencyMs = 20, .jitterMs = 3};
    request.clientB = {.baseLatencyMs = 80,
                       .jitterMs = 12,
                       .packetLoss = 0.01,
                       .duplicateRate = 0.001,
                       .reorderRate = 0.005};
    request.maximumInputSeconds = 3;
    const auto report = runNetworkTest(request);

    WavDecoder decoder;
    const auto format = decoder.open(output.string());
    expect(format.channels == 3 && format.sampleRateHz == 48'000,
           "network evidence WAV contains Client A, Client B and mixed channels");
    expect(std::abs(report.offsetSamples) <= 48 && std::abs(report.offsetMs) <= 1.0 &&
               report.peakCorrelation >= 0.80,
           "full codec and impairment paths align within one millisecond");
}

void networkTestCommandWritesMachineReadableReport() {
    const auto input = tempRoot / "network-command-input.wav";
    const auto output = tempRoot / "network-command-output.wav";
    makeTestWav(input, 48'000U);
    const std::vector<std::string> storage{"--network-test",
                                           "--input",
                                           input.string(),
                                           "--output",
                                           output.string(),
                                           "--latency-a",
                                           "20",
                                           "--jitter-a",
                                           "3",
                                           "--latency-b",
                                           "65",
                                           "--jitter-b",
                                           "12",
                                           "--loss-b",
                                           "0.01",
                                           "--seed",
                                           "12345"};
    std::vector<std::string_view> arguments(storage.size());
    for (std::size_t index = 0; index < storage.size(); ++index)
        arguments[index] = storage[index];
    std::ostringstream standardOutput;
    std::ostringstream standardError;
    expect(runNetworkTestCommand(arguments, standardOutput, standardError) == 0,
           "network test command completes successfully");
    const auto report = standardOutput.str();
    expect(standardError.str().empty() && report.find("\"offsetSamples\"") != std::string::npos &&
               report.find("\"peakCorrelation\"") != std::string::npos &&
               report.find("\"interPeerAlignmentErrorSamples\"") != std::string::npos,
           "network test command prints a machine-readable alignment report");
    WavDecoder decoder;
    expect(decoder.open(output.string()).channels == 3,
           "network test command writes the requested three-channel evidence");

    const std::array<std::string_view, 1> clientArguments{"--network-test-client"};
    standardOutput.str({});
    standardError.str({});
    expect(runNetworkTestCommand(clientArguments, standardOutput, standardError) == 1 &&
               standardError.str().find("requires") != std::string::npos,
           "network test client mode validates its process and UDP arguments");
    auto missingVoice = storage;
    missingVoice.insert(missingVoice.end(), {"--loss-b", "1"});
    arguments.clear();
    for (const auto& argument : missingVoice) arguments.push_back(argument);
    standardOutput.str({});
    standardError.str({});
    expect(runNetworkTestCommand(arguments, standardOutput, standardError) == 2,
           "a missing voice cannot pass the alignment command with zero correlation");
}

void networkTestCommandAcceptsNamedImpairmentScenario() {
    const auto input = tempRoot / "network-scenario-input.wav";
    const auto output = tempRoot / "network-scenario-output.wav";
    makeTestWav(input, 48'000U);
    const std::vector<std::string> storage{"--network-test",
                                           "--scenario",
                                           "wifi",
                                           "--input",
                                           input.string(),
                                           "--output",
                                           output.string(),
                                           "--seed",
                                           "12345"};
    std::vector<std::string_view> arguments(storage.size());
    for (std::size_t index = 0; index < storage.size(); ++index)
        arguments[index] = storage[index];
    std::ostringstream standardOutput;
    std::ostringstream standardError;
    expect(runNetworkTestCommand(arguments, standardOutput, standardError) == 0,
           "named impairment scenario is accepted by the network test command");
    expect(standardError.str().empty() && standardOutput.str().find("\"clientA\"") !=
                                               std::string::npos,
           "named impairment scenario still emits the machine-readable path report");
}

void networkLatencyJumpRestabilizesThroughFullCodecChain() {
    const auto input = tempRoot / "network-latency-jump-input.wav";
    makeTestWav(input, 48'000U * 9U);
    NetworkTestRequest request;
    request.inputPath = input.string();
    request.clientA = {.baseLatencyMs = 20,
                       .jitterMs = 10,
                       .packetLoss = 0.01,
                       .duplicateRate = 0.002,
                       .reorderRate = 0.005,
                       .latencyStages = {{3.0, 20}, {6.0, 100}, {9.0, 30}}};
    request.clientB = {.baseLatencyMs = 65,
                       .jitterMs = 20,
                       .packetLoss = 0.01,
                       .duplicateRate = 0.002,
                       .reorderRate = 0.005};
    const auto report = runNetworkTest(request);
    expect(report.interPeerAlignmentErrorSamples <= 96U && report.peakCorrelation >= 0.75,
           "20 to 100 to 30 ms latency jump restabilizes through the full codec chain");
}

void networkProcessClientUsesProtocolCadence() {
    const auto input = tempRoot / "network-cadence-input.wav";
    const auto output = tempRoot / "network-cadence-output.wav";
    makeTestWav(input, SampleRateHz);
    UdpSocket destination;
    destination.bind(0);
    for (const auto warmupSeconds : {0U, 1U}) {
        NetworkProcessClientRequest request;
        request.inputPath = input.string();
        request.outputPath = output.string();
        request.localId = "singer";
        request.remoteId = "listener";
        request.remotePort = destination.localPort();
        request.token = 123;
        request.durationSeconds = 1;
        request.warmupSeconds = warmupSeconds;
        request.startAtUnixMs = static_cast<std::uint64_t>(
            std::chrono::duration_cast<std::chrono::milliseconds>(
                std::chrono::system_clock::now().time_since_epoch()).count()) +
            100U + warmupSeconds * 1'000U;
        const auto started = std::chrono::steady_clock::now();
        std::ostringstream report;
        (void)runNetworkProcessClient(request, report);
        expect(report.str().find("\"packetsSent\":") != std::string::npos &&
                   report.str().find("\"packetsSent\":0") == std::string::npos,
               "the paced diagnostic client sends real UDP packets");
        const auto elapsed = std::chrono::steady_clock::now() - started;
        const auto expected = std::chrono::milliseconds{1'100 + warmupSeconds * 1'000};
        expect(elapsed >= expected - std::chrono::milliseconds{200} &&
                   elapsed < expected + std::chrono::milliseconds{600},
               "one second of PCM advances one wall-clock second, including warmup");
        WavDecoder decoder;
        expect(decoder.open(output.string()).totalFrames == SampleRateHz,
               "the diagnostic file contains exactly the requested performance duration");
    }
}

void networkAlignmentMeasuresBeyondItsSuccessThreshold() {
    const auto input = tempRoot / "network-broadband-alignment.wav";
    std::vector<float> source(72'000);
    for (std::size_t frame = 40'000; frame < 60'000; ++frame) {
        const auto t = static_cast<double>(frame) / SampleRateHz;
        source[frame] = static_cast<float>(0.3 * std::sin(6.283185307179586 * (200.0 * t + 1200.0 * t * t)));
    }
    {
        WavWriter writer;
        writer.open(input.string(), SampleRateHz, 1);
        writer.write(source);
        writer.close();
    }
    NetworkTestRequest request;
    request.inputPath = input.string();
    request.clientB.clockDriftPpm = 8'000;
    request.correlationWindowFrames = 480;
    const auto result = runNetworkTest(request);
    expect(result.interPeerAlignmentErrorSamples > 96 && result.peakCorrelation > 0.8,
           "a displaced recognizable voice is measured outside the accepted two milliseconds");
}
} // namespace Tests
