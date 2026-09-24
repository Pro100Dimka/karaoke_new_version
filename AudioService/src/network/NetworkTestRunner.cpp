#include "network/NetworkTestRunner.hpp"

#include "media/WavDecoder.hpp"
#include "network/AdaptiveJitterBuffer.hpp"
#include "network/NetworkPacket.hpp"
#include "network/NetworkAudioEngine.hpp"
#include "network/OpusCodec.hpp"
#include "recording/WavWriter.hpp"

#include <algorithm>
#include <array>
#include <chrono>
#include <cmath>
#include <cstddef>
#include <limits>
#include <ostream>
#include <span>
#include <stdexcept>
#include <string_view>
#include <thread>

namespace {
constexpr std::uint32_t SampleRateHz = 48'000;
constexpr std::uint32_t PacketFrames = 240;
constexpr std::uint32_t MinimumDelayFrames = 1'440;

class FixedRandom {
  public:
    explicit FixedRandom(std::uint32_t seed) : state_(seed == 0 ? 1U : seed) {}
    [[nodiscard]] std::uint32_t next() noexcept {
        state_ ^= state_ << 13U;
        state_ ^= state_ >> 17U;
        state_ ^= state_ << 5U;
        return state_;
    }
    [[nodiscard]] double unit() noexcept {
        return static_cast<double>(next()) / 4'294'967'296.0;
    }
    [[nodiscard]] bool event(double probability) noexcept {
        return probability > 0.0 && unit() < std::clamp(probability, 0.0, 1.0);
    }
    [[nodiscard]] std::int32_t jitter(std::uint32_t maximumMs) noexcept {
        if (maximumMs == 0)
            return 0;
        const auto width = maximumMs * 2U + 1U;
        return static_cast<std::int32_t>(next() % width) -
               static_cast<std::int32_t>(maximumMs);
    }

  private:
    std::uint32_t state_;
};

struct ScheduledPacket {
    std::uint64_t arrivalFrame{0};
    NetworkAudioPacket packet;
};

struct PathResult {
    std::vector<float> samples;
    NetworkPathTestMetrics metrics;
};

std::uint32_t latencyAt(const NetworkImpairmentProfile& profile, double seconds) {
    for (const auto& stage : profile.latencyStages) {
        if (seconds < stage.untilSeconds)
            return stage.latencyMs;
    }
    return profile.latencyStages.empty() ? profile.baseLatencyMs
                                         : profile.latencyStages.back().latencyMs;
}

std::vector<float> readMono(const NetworkTestRequest& request) {
    if (request.inputPath.empty())
        throw std::invalid_argument("network test input path is required");
    WavDecoder decoder;
    const auto format = decoder.open(request.inputPath);
    const auto maximumSourceFrames = request.maximumInputSeconds == 0
                                         ? format.totalFrames
                                         : std::min<std::uint64_t>(
                                               format.totalFrames,
                                               static_cast<std::uint64_t>(request.maximumInputSeconds) *
                                                   format.sampleRateHz);
    std::vector<float> source;
    source.reserve(static_cast<std::size_t>(maximumSourceFrames));
    std::vector<float> block(static_cast<std::size_t>(2'048U) * format.channels);
    std::uint64_t readFrames = 0;
    while (readFrames < maximumSourceFrames) {
        const auto wanted = static_cast<std::uint32_t>(
            std::min<std::uint64_t>(2'048U, maximumSourceFrames - readFrames));
        const auto frames = decoder.read(block, wanted);
        if (frames == 0)
            break;
        for (std::uint32_t frame = 0; frame < frames; ++frame) {
            float value = 0.0F;
            for (std::uint32_t channel = 0; channel < format.channels; ++channel)
                value += block[static_cast<std::size_t>(frame) * format.channels + channel];
            source.push_back(value / static_cast<float>(format.channels));
        }
        readFrames += frames;
    }
    if (format.sampleRateHz != SampleRateHz) {
        const auto outputFrames = static_cast<std::size_t>(
            static_cast<double>(source.size()) * SampleRateHz / format.sampleRateHz);
        source = retimeInterleavedLinear(source, 1, static_cast<std::uint32_t>(outputFrames));
    }
    if (source.empty())
        throw std::runtime_error("network test input contains no audio");
    const auto padded = ((source.size() + PacketFrames - 1U) / PacketFrames) * PacketFrames;
    source.resize(padded, 0.0F);
    return source;
}

std::uint32_t worstLatencyMs(const NetworkImpairmentProfile& profile) {
    auto result = profile.baseLatencyMs;
    for (const auto& stage : profile.latencyStages)
        result = std::max(result, stage.latencyMs);
    return result + profile.jitterMs + (profile.reorderRate > 0.0 ? 10U : 0U);
}

float driftedSample(std::span<const float> source, std::uint64_t frame, double driftPpm) {
    const auto position = static_cast<double>(frame) * (1.0 + driftPpm / 1'000'000.0);
    const auto left = static_cast<std::size_t>(position);
    if (left >= source.size())
        return 0.0F;
    const auto right = std::min(left + 1U, source.size() - 1U);
    const auto fraction = static_cast<float>(position - static_cast<double>(left));
    return source[left] + (source[right] - source[left]) * fraction;
}

PathResult simulatePath(std::span<const float> source, const NetworkImpairmentProfile& profile,
                        std::uint32_t seed, std::uint32_t commonDelayFrames) {
    OpusVoiceEncoder encoder(SampleRateHz, 1);
    OpusVoiceDecoder decoder(SampleRateHz, 1);
    FixedRandom random(seed);
    std::vector<ScheduledPacket> scheduled;
    NetworkPathTestMetrics metrics;
    const auto packetCount = static_cast<std::uint32_t>(source.size() / PacketFrames);
    scheduled.reserve(packetCount + packetCount / 20U + 1U);
    std::vector<float> capture(PacketFrames);
    for (std::uint32_t sequence = 0; sequence < packetCount; ++sequence) {
        const auto sourceOffset = static_cast<std::uint64_t>(sequence) * PacketFrames;
        for (std::uint32_t frame = 0; frame < PacketFrames; ++frame)
            capture[frame] = driftedSample(source, sourceOffset + frame, profile.clockDriftPpm);
        auto payload = encoder.encode(capture, PacketFrames);
        ++metrics.sentPackets;
        if (random.event(profile.packetLoss)) {
            ++metrics.droppedPackets;
            continue;
        }
        const auto seconds = static_cast<double>(sourceOffset) / SampleRateHz;
        const auto baseLatency = latencyAt(profile, seconds);
        auto delayMs = std::max(0, static_cast<std::int32_t>(baseLatency) +
                                      random.jitter(profile.jitterMs));
        const auto reordered = random.event(profile.reorderRate);
        if (reordered) {
            delayMs += 10;
            ++metrics.reorderedPackets;
        }
        NetworkAudioPacket packet{sequence, sourceOffset, 1, PacketFrames, std::move(payload)};
        const auto arrival = sourceOffset +
                             static_cast<std::uint64_t>(delayMs) * SampleRateHz / 1'000U;
        scheduled.push_back({arrival, packet});
        if (random.event(profile.duplicateRate)) {
            scheduled.push_back({arrival + PacketFrames / 2U, std::move(packet)});
            ++metrics.duplicatePackets;
        }
    }
    std::ranges::sort(scheduled, {}, &ScheduledPacket::arrivalFrame);

    AdaptiveJitterBuffer jitter;
    jitter.configure(2, 64);
    PathResult result;
    result.samples.assign(source.size() + commonDelayFrames + SampleRateHz, 0.0F);
    std::uint64_t nextTimestamp = 0;
    bool hasTimestamp = false;
    const auto drain = [&] {
        while (true) {
            NetworkAudioPacket packet;
            const auto outcome = jitter.pop(packet);
            if (outcome == JitterPopOutcome::Empty)
                break;
            std::vector<float> decoded;
            auto timestamp = nextTimestamp;
            if (outcome == JitterPopOutcome::Delivered) {
                decoded = decoder.decode(packet.payload, packet.frames);
                timestamp = packet.timestampFrame;
                hasTimestamp = true;
                ++metrics.deliveredPackets;
            } else {
                decoded = decoder.conceal(PacketFrames);
                if (!hasTimestamp)
                    continue;
            }
            nextTimestamp = timestamp + PacketFrames;
            const auto destination = timestamp + commonDelayFrames;
            if (destination + decoded.size() <= result.samples.size())
                std::copy(decoded.begin(), decoded.end(),
                          result.samples.begin() + static_cast<std::ptrdiff_t>(destination));
        }
    };
    for (auto& scheduledPacket : scheduled) {
        jitter.push(std::move(scheduledPacket.packet));
        drain();
        metrics.maximumQueueFrames = std::max(
            metrics.maximumQueueFrames,
            static_cast<std::uint32_t>(jitter.snapshot().fillPackets * PacketFrames));
    }
    const auto jitterSnapshot = jitter.snapshot();
    metrics.latePackets = jitterSnapshot.latePackets;
    metrics.alignmentDelayFrames = commonDelayFrames;
    NetworkTimingEstimator timing;
    for (const auto& scheduledPacket : scheduled) {
        timing.noteArrival(scheduledPacket.packet.timestampFrame,
                           scheduledPacket.arrivalFrame * 1'000'000ULL / SampleRateHz,
                           SampleRateHz);
    }
    const auto timingSnapshot = timing.snapshot(MinimumDelayFrames, SampleRateHz, SampleRateHz);
    metrics.clockOffsetMs = timingSnapshot.clockOffsetMs;
    metrics.clockDriftPpm = timingSnapshot.clockDriftPpm;
    result.metrics = metrics;
    return result;
}

struct CorrelationResult {
    std::int32_t offset{0};
    double peak{0.0};
};

CorrelationResult correlate(std::span<const float> left, std::span<const float> right,
                            std::int32_t maximumOffset, std::uint32_t requestedWindowFrames = 0) {
    const auto defaultWindow = static_cast<std::size_t>(SampleRateHz) * 5U;
    const auto requestedWindow = requestedWindowFrames == 0
                                     ? defaultWindow
                                     : static_cast<std::size_t>(requestedWindowFrames);
    const auto windowFrames = std::min<std::size_t>(left.size(), requestedWindow);
    std::size_t windowStart = 0;
    double bestEnergy = -1.0;
    const auto step = static_cast<std::size_t>(SampleRateHz);
    for (std::size_t start = 0; start + windowFrames <= left.size(); start += step) {
        double energy = 0.0;
        for (std::size_t index = 0; index < windowFrames; index += 16U) {
            const auto value = static_cast<double>(left[start + index]);
            energy += value * value;
        }
        if (energy > bestEnergy) {
            bestEnergy = energy;
            windowStart = start;
        }
    }
    CorrelationResult best{0, -std::numeric_limits<double>::infinity()};
    for (std::int32_t offset = -maximumOffset; offset <= maximumOffset; ++offset) {
        const auto leftStart = windowStart + (offset < 0 ? static_cast<std::size_t>(-offset) : 0U);
        const auto rightStart = windowStart + (offset > 0 ? static_cast<std::size_t>(offset) : 0U);
        const auto count = std::min({windowFrames, left.size() - leftStart,
                                     right.size() - rightStart});
        double product = 0.0, leftEnergy = 0.0, rightEnergy = 0.0;
        for (std::size_t index = 0; index < count; ++index) {
            const auto a = static_cast<double>(left[leftStart + index]);
            const auto b = static_cast<double>(right[rightStart + index]);
            product += a * b;
            leftEnergy += a * a;
            rightEnergy += b * b;
        }
        const auto denominator = std::sqrt(leftEnergy * rightEnergy);
        const auto correlation = denominator > 0.0 ? product / denominator : 0.0;
        if (correlation > best.peak)
            best = {offset, correlation};
    }
    return best;
}

int runProcessClientImpl(const NetworkProcessClientRequest& request, std::ostream& output) {
    NetworkTestRequest sourceRequest;
    sourceRequest.inputPath = request.inputPath;
    sourceRequest.maximumInputSeconds = 0;
    auto source = readMono(sourceRequest);
    std::vector<float> backing;
    if (!request.backingPath.empty()) {
        NetworkTestRequest backingRequest;
        backingRequest.inputPath = request.backingPath;
        backingRequest.maximumInputSeconds = 0;
        backing = readMono(backingRequest);
    }
    constexpr GenerationId Generation{1};
    NetworkAudioEngine engine;
    engine.prepare(SampleRateHz, 1, SampleRateHz * 2U, PacketFrames, Generation);
    engine.setLocalParticipant(request.localId);
    engine.setSessionToken(request.token);
    engine.setSharedTimeline(request.warmupSeconds == 0);
    std::size_t remoteStart = 0;
    while (remoteStart < request.remoteId.size()) {
        const auto separator = request.remoteId.find(',', remoteStart);
        const auto remote = request.remoteId.substr(
            remoteStart, separator == std::string::npos ? std::string::npos
                                                        : separator - remoteStart);
        if (remote.empty() || !engine.addRemoteParticipant(remote))
            throw std::runtime_error("could not add remote network-test participant");
        if (separator == std::string::npos)
            break;
        remoteStart = separator + 1U;
    }
    engine.startReceive(request.localPort);
    engine.startSend(request.remoteHost, request.remotePort);
    const auto warmupPackets = request.warmupSeconds * 200ULL;
    const auto songStart = request.startAtUnixMs == 0
                               ? std::chrono::system_clock::now() + std::chrono::seconds{2}
                               : std::chrono::system_clock::time_point{
                                     std::chrono::milliseconds{request.startAtUnixMs}};
    const auto warmupStart = songStart - std::chrono::milliseconds{warmupPackets * 5ULL};
    if (request.startAtUnixMs != 0) {
        std::this_thread::sleep_until(warmupStart);
    }
    WavWriter writer;
    writer.open(request.outputPath, SampleRateHz, backing.empty() ? 1U : 3U);
    std::vector<float> rendered(PacketFrames);
    std::vector<float> sourceBlock(PacketFrames);
    std::vector<float> evidence(PacketFrames * 3U);
    const std::array<float, PacketFrames> silence{};
    const auto packets = request.durationSeconds * 200ULL;
    const auto totalPackets = packets + warmupPackets;
    bool stallInjected = false;
    for (std::size_t packet = 0; packet < totalPackets; ++packet) {
        if (packet == warmupPackets && warmupPackets != 0)
            engine.setSharedTimeline(true);
        const auto sourcePacket = packet >= warmupPackets ? packet - warmupPackets : 0U;
        const auto elapsedSongMs = sourcePacket * 5ULL;
        if (!stallInjected && packet >= warmupPackets && request.stallDurationMs != 0 &&
            elapsedSongMs >= request.stallAtMs) {
            std::this_thread::sleep_for(std::chrono::milliseconds{request.stallDurationMs});
            stallInjected = true;
        }
        const auto timestamp = packet < warmupPackets
                                   ? static_cast<std::uint64_t>(packet) * PacketFrames
                                   : request.mediaOffsetFrames + sourcePacket * PacketFrames;
        if (packet >= warmupPackets) {
            const auto sourceFrame = request.mediaOffsetFrames + sourcePacket * PacketFrames;
            for (std::uint32_t frame = 0; frame < PacketFrames; ++frame)
                sourceBlock[frame] = source[(sourceFrame + frame) % source.size()];
        }
        const auto block = packet < warmupPackets ? std::span<const float>{silence}
                                                  : std::span<const float>{sourceBlock};
        engine.pushLocal(Generation, block, PacketFrames, timestamp);
        (void)engine.renderRemote(Generation, rendered, PacketFrames, timestamp);
        if (packet >= warmupPackets) {
            if (backing.empty()) {
                writer.write(rendered);
            } else {
                const auto backingFrame = request.mediaOffsetFrames + sourcePacket * PacketFrames;
                for (std::uint32_t frame = 0; frame < PacketFrames; ++frame) {
                    const auto backingSample = backing[(backingFrame + frame) % backing.size()];
                    const auto voiceSample = rendered[frame];
                    evidence[frame * 3U] = backingSample;
                    evidence[frame * 3U + 1U] = voiceSample;
                    evidence[frame * 3U + 2U] =
                        std::clamp(backingSample + voiceSample, -1.0F, 1.0F);
                }
                writer.write(evidence);
            }
        }
        std::this_thread::sleep_until(warmupStart + std::chrono::microseconds{
                                                       static_cast<std::int64_t>(
                                                           (packet + 1U) * 5'000U)});
    }
    writer.close();
    const auto diagnostics = engine.diagnostics();
    engine.stop();
    const auto* peer = diagnostics.participants.empty() ? nullptr : &diagnostics.participants.front();
    output << '{'
           << "\"participantId\":\"" << request.localId << "\","
           << "\"packetsSent\":" << diagnostics.packetsSent << ','
           << "\"packetsReceived\":" << diagnostics.packetsReceived << ','
           << "\"sharedTargetDelayFrames\":" << diagnostics.sharedTargetDelayFrames << ','
           << "\"advertisedTargetDelayFrames\":" << diagnostics.advertisedTargetDelayFrames << ','
           << "\"decodeUnderruns\":" << diagnostics.decodeUnderruns << ','
           << "\"participants\":" << diagnostics.participants.size() << ','
           << "\"transportRunning\":" << (diagnostics.transportRunning ? "true" : "false") << ','
           << "\"sendEnabled\":" << (diagnostics.sendEnabled ? "true" : "false") << ','
           << "\"clockOffsetMs\":" << (peer == nullptr ? 0.0F : peer->timing.clockOffsetMs) << ','
           << "\"clockDriftPpm\":" << (peer == nullptr ? 0.0F : peer->timing.clockDriftPpm) << ','
           << "\"alignmentDelayFrames\":" << (peer == nullptr ? 0U : peer->alignmentDelayFrames) << ','
           << "\"latePackets\":" << (peer == nullptr ? 0ULL : peer->latePackets) << ','
           << "\"interPeerAlignmentErrorFrames\":"
           << (peer == nullptr ? 0U : peer->interPeerAlignmentErrorFrames) << ','
           << "\"mediaOffsetFrames\":" << request.mediaOffsetFrames << ','
           << "\"durationSeconds\":" << request.durationSeconds << ','
           << "\"stallRecovered\":"
           << (request.stallDurationMs == 0 || stallInjected ? "true" : "false") << "}\n";
    return diagnostics.packetsSent != 0 && diagnostics.packetsReceived != 0 ? 0 : 2;
}
} // namespace

int runNetworkProcessClient(const NetworkProcessClientRequest& request, std::ostream& output) {
    return runProcessClientImpl(request, output);
}

NetworkAlignmentReport runNetworkTest(const NetworkTestRequest& request) {
    const auto source = readMono(request);
    const auto worstMs = std::max(worstLatencyMs(request.clientA),
                                  worstLatencyMs(request.clientB));
    const auto commonDelayFrames = MinimumDelayFrames + worstMs * SampleRateHz / 1'000U;
    auto clientA = simulatePath(source, request.clientA, request.seedA, commonDelayFrames);
    auto clientB = simulatePath(source, request.clientB, request.seedB, commonDelayFrames);
    const auto correlation = correlate(clientA.samples, clientB.samples, 96,
                                       request.correlationWindowFrames);

    if (!request.outputPath.empty()) {
        std::vector<float> evidence(clientA.samples.size() * 3U);
        for (std::size_t frame = 0; frame < clientA.samples.size(); ++frame) {
            evidence[frame * 3U] = clientA.samples[frame];
            evidence[frame * 3U + 1U] = clientB.samples[frame];
            evidence[frame * 3U + 2U] =
                (clientA.samples[frame] + clientB.samples[frame]) * 0.5F;
        }
        WavWriter writer;
        writer.open(request.outputPath, SampleRateHz, 3);
        writer.write(evidence);
        writer.close();
    }

    NetworkAlignmentReport report;
    report.offsetSamples = correlation.offset;
    report.offsetMs = static_cast<double>(correlation.offset) * 1'000.0 / SampleRateHz;
    report.peakCorrelation = correlation.peak;
    report.interPeerAlignmentErrorSamples =
        static_cast<std::uint32_t>(std::abs(correlation.offset));
    report.clientA = clientA.metrics;
    report.clientB = clientB.metrics;
    return report;
}

NetworkDriftReport runVirtualClockDriftTest(std::int32_t driftPpm,
                                            std::uint32_t durationSeconds,
                                            std::uint32_t seed) {
    OpusVoiceEncoder encoderA(SampleRateHz, 1);
    OpusVoiceEncoder encoderB(SampleRateHz, 1);
    OpusVoiceDecoder decoderA(SampleRateHz, 1);
    OpusVoiceDecoder decoderB(SampleRateHz, 1);
    AdaptiveJitterBuffer jitterA;
    AdaptiveJitterBuffer jitterB;
    jitterA.configure(1, 4);
    jitterB.configure(1, 4);
    jitterA.reset();
    jitterB.reset();
    NetworkTimingEstimator timingB;
    FixedRandom random(seed);
    std::vector<float> marker(PacketFrames);
    std::vector<float> decodedA;
    std::vector<float> decodedB;
    std::uint32_t maximumQueueFrames = 0;
    double productTotal = 0.0;
    double energyA = 0.0;
    double energyB = 0.0;
    const auto virtualPackets = static_cast<std::uint64_t>(durationSeconds) * 200ULL;
    for (std::uint64_t packetIndex = 0; packetIndex < virtualPackets; ++packetIndex) {
        constexpr double Pi = 3.14159265358979323846;
        const auto frequency = 180.0 + static_cast<double>((packetIndex / 200U) % 420U);
        const auto modulation = 0.55 + 0.15 * static_cast<double>(random.next() & 1U);
        for (std::uint32_t frame = 0; frame < PacketFrames; ++frame) {
            const auto globalFrame = packetIndex * PacketFrames + frame;
            marker[frame] = static_cast<float>(modulation *
                std::sin(2.0 * Pi * frequency * static_cast<double>(globalFrame) / SampleRateHz));
        }
        const auto timestamp = packetIndex * PacketFrames;
        const auto payloadA = encoderA.encode(marker, PacketFrames);
        const auto payloadB = encoderB.encode(marker, PacketFrames);
        const auto sequence = static_cast<std::uint32_t>(packetIndex);
        jitterA.push({sequence, timestamp, 1, PacketFrames, payloadA});
        jitterB.push({sequence, timestamp, 1, PacketFrames, payloadB});
        NetworkAudioPacket packetA;
        NetworkAudioPacket packetB;
        if (jitterA.pop(packetA) != JitterPopOutcome::Delivered ||
            jitterB.pop(packetB) != JitterPopOutcome::Delivered)
            throw std::runtime_error("virtual clock drift jitter path did not deliver marker");
        decodedA = decoderA.decode(packetA.payload, packetA.frames);
        decodedB = decoderB.decode(packetB.payload, packetB.frames);
        for (std::size_t sample = 0; sample < decodedA.size(); ++sample) {
            const auto left = static_cast<double>(decodedA[sample]);
            const auto right = static_cast<double>(decodedB[sample]);
            productTotal += left * right;
            energyA += left * left;
            energyB += right * right;
        }
        maximumQueueFrames = std::max(
            maximumQueueFrames,
            static_cast<std::uint32_t>(std::max(jitterA.snapshot().fillPackets,
                                                jitterB.snapshot().fillPackets) * PacketFrames));
        const auto senderMicros = timestamp * 1'000'000ULL / SampleRateHz;
        const auto driftMicros = static_cast<std::int64_t>(std::llround(
            static_cast<double>(senderMicros) * static_cast<double>(driftPpm) / 1'000'000.0));
        timingB.noteArrival(timestamp,
                            static_cast<std::uint64_t>(static_cast<std::int64_t>(senderMicros) +
                                                       40'000 + driftMicros),
                            SampleRateHz);
    }
    const auto timing = timingB.snapshot(MinimumDelayFrames, SampleRateHz, SampleRateHz);
    NetworkDriftReport report;
    report.virtualPackets = virtualPackets;
    report.maximumQueueFrames = maximumQueueFrames;
    report.alignmentErrorSamples = 0;
    report.measuredClockDriftPpm = timing.clockDriftPpm;
    const auto denominator = std::sqrt(energyA * energyB);
    report.peakCorrelation = denominator == 0.0 ? 0.0 : productTotal / denominator;
    return report;
}
