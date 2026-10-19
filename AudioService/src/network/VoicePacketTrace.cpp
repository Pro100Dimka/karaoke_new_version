#include "network/VoicePacketTrace.hpp"
#include "realtime/RealtimeInstrumentation.hpp"

#include <array>
#include <cmath>
#include <filesystem>
#include <fstream>
#include <iomanip>
#include <limits>
#include <stdexcept>
#include <string_view>
#include <type_traits>

namespace {
using Trace = VoicePacketTrace;
static_assert(std::is_trivially_copyable_v<Trace::SenderEvent> &&
              std::is_trivially_copyable_v<Trace::ReceiveEvent> &&
              std::is_trivially_copyable_v<Trace::RenderEvent>);
constexpr std::uint64_t FnvOffset = 14'695'981'039'346'656'037ULL;
constexpr std::uint64_t FnvPrime = 1'099'511'628'211ULL;

void appendHash(std::uint64_t& hash, std::span<const std::byte> bytes) noexcept {
    for (const auto byte : bytes) {
        hash ^= static_cast<std::uint8_t>(byte);
        hash *= FnvPrime;
    }
}

template <typename Enum, std::size_t Size>
std::string_view enumName(Enum value, const std::array<std::string_view, Size>& names) noexcept {
    const auto index = static_cast<std::size_t>(value);
    return index < names.size() ? names[index] : "UNKNOWN";
}

std::string_view reasonName(Trace::ReceiveReason reason) noexcept {
    static constexpr std::array<std::string_view, 20> names{
        "RECEIVED", "WRONG_SESSION", "SELF_ECHO", "DUPLICATE", "UNKNOWN_PARTICIPANT",
        "OLD_GENERATION", "EPOCH_RESET", "REORDER_ACCEPTED", "REORDER_LATE",
        "REORDER_DUPLICATE", "REORDER_OVERFLOW", "REORDER_REBASE", "DECODE_EMPTY",
        "INITIAL_SKIP", "EXCLUDED_WAIT", "BEYOND_CEILING", "QUEUE_LATE", "RETIMED",
        "QUEUED", "QUEUE_FULL"};
    static_assert(names.size() == static_cast<std::size_t>(Trace::ReceiveReason::Count));
    return enumName(reason, names);
}

void writePacket(std::ostream& out, const Trace::PacketIdentity& packet) {
    static constexpr std::array<std::string_view, 2> codecs{"OPUS", "PCM16"};
    out << packet.generation << ',' << packet.participantKey << ',' << packet.streamEpoch << ','
        << packet.sequence << ',' << enumName(packet.codec, codecs);
}

void writeQueue(std::ostream& out, const Trace::QueueSpan& queue) {
    out << queue.epoch << ',' << queue.startFrame << ',' << queue.frames;
}

void writePcm(std::ostream& out, const Trace::PcmMetrics& pcm) {
    out << pcm.hash << ',' << pcm.energy << ',' << pcm.peak << ',' << pcm.zeroFrames;
}

std::ofstream openCsv(const std::string& path, std::string_view header) {
    std::ofstream out(std::filesystem::path{std::u8string{path.begin(), path.end()}},
                      std::ios::out | std::ios::trunc);
    if (!out)
        throw std::runtime_error("Cannot create packet trace: " + path);
    out << std::setprecision(std::numeric_limits<double>::max_digits10) << header << '\n';
    return out;
}

void finishCsv(std::ofstream& out) {
    out.flush();
    if (!out)
        throw std::runtime_error("Packet trace export failed");
    out.close();
    if (!out)
        throw std::runtime_error("Packet trace close failed");
}
} // namespace

void VoicePacketTrace::prepare() { prepare(Capacities{}); }

void VoicePacketTrace::prepare(Capacities capacities) {
    requireStopped();
    if (capacities.sender > SenderCapacity || capacities.receive > ReceiveCapacity ||
        capacities.render > RenderCapacity)
        throw std::invalid_argument("Packet trace capacity exceeds the diagnostic bound");
    // Allocate all replacement storage before changing any previously captured evidence.
    std::vector<SenderEvent> sender(capacities.sender);
    std::vector<ReceiveEvent> receive(capacities.receive);
    std::vector<RenderEvent> render(capacities.render);
    sender_.events = std::move(sender);
    receive_.events = std::move(receive);
    render_.events = std::move(render);
    sender_.count.store(0);
    receive_.count.store(0);
    render_.count.store(0);
    sender_.overflow.store(0);
    receive_.overflow.store(0);
    render_.overflow.store(0);
    prepared_ = true;
    captured_ = false;
}

void VoicePacketTrace::start() {
    requireStopped();
    if (!prepared_)
        throw std::logic_error("Packet trace must be prepared before capture");
    sender_.count.store(0, std::memory_order_relaxed);
    receive_.count.store(0, std::memory_order_relaxed);
    render_.count.store(0, std::memory_order_relaxed);
    sender_.overflow.store(0, std::memory_order_relaxed);
    receive_.overflow.store(0, std::memory_order_relaxed);
    render_.overflow.store(0, std::memory_order_relaxed);
    captured_ = true;
    lifecycleEpoch_.fetch_add(1);
}

void VoicePacketTrace::stop() noexcept {
    // Only the serial control thread can change lifecycleEpoch_. A callback that read the old
    // epoch before this transition rechecks it under a lease and cannot touch rearmed storage.
    if (active())
        lifecycleEpoch_.fetch_add(1);
    for (auto count = producers_.load(); count != 0; count = producers_.load()) {
        RealtimeInstrumentation::reportBlockingCall();
        producers_.wait(count);
    }
}

bool VoicePacketTrace::active() const noexcept {
    return (lifecycleEpoch_.load() & 1U) != 0;
}

std::uint64_t VoicePacketTrace::captureToken() const noexcept {
    const auto epoch = lifecycleEpoch_.load();
    return (epoch & 1U) != 0 ? epoch : 0U;
}

VoicePacketTrace::Status VoicePacketTrace::status() const noexcept {
    const auto epoch = lifecycleEpoch_.load();
    return {captured_ ? (epoch + 1U) / 2U : 0U,
            sender_.count.load(std::memory_order_acquire),
            receive_.count.load(std::memory_order_acquire),
            render_.count.load(std::memory_order_acquire),
            sender_.overflow.load(std::memory_order_relaxed),
            receive_.overflow.load(std::memory_order_relaxed),
            render_.overflow.load(std::memory_order_relaxed), prepared_, (epoch & 1U) != 0};
}

template <typename Event>
bool VoicePacketTrace::append(Lane<Event>& lane, const Event& event,
                              std::uint64_t captureToken) noexcept {
    const auto epoch = captureToken != 0 ? captureToken : lifecycleEpoch_.load();
    if ((epoch & 1U) == 0)
        return false;
    producers_.fetch_add(1);
    bool accepted = false;
    if (lifecycleEpoch_.load() == epoch) {
        const auto index = lane.count.load(std::memory_order_relaxed);
        if (index < lane.events.size()) {
            lane.events[static_cast<std::size_t>(index)] = event;
            lane.count.store(index + 1U, std::memory_order_release);
            accepted = true;
        } else {
            lane.overflow.fetch_add(1, std::memory_order_relaxed);
        }
    }
    if (producers_.fetch_sub(1) == 1 && !active())
        producers_.notify_all();
    return accepted;
}

bool VoicePacketTrace::appendSender(const SenderEvent& event, std::uint64_t captureToken) noexcept {
    return append(sender_, event, captureToken);
}
bool VoicePacketTrace::appendReceive(const ReceiveEvent& event, std::uint64_t captureToken) noexcept {
    return append(receive_, event, captureToken);
}
bool VoicePacketTrace::appendRender(const RenderEvent& event, std::uint64_t captureToken) noexcept {
    return append(render_, event, captureToken);
}

void VoicePacketTrace::requireStopped() const {
    if (active())
        throw std::logic_error("Packet trace capture must be stopped");
}

std::span<const VoicePacketTrace::SenderEvent> VoicePacketTrace::senderEvents() const {
    requireStopped();
    return std::span{sender_.events}.first(static_cast<std::size_t>(sender_.count.load()));
}
std::span<const VoicePacketTrace::ReceiveEvent> VoicePacketTrace::receiveEvents() const {
    requireStopped();
    return std::span{receive_.events}.first(static_cast<std::size_t>(receive_.count.load()));
}
std::span<const VoicePacketTrace::RenderEvent> VoicePacketTrace::renderEvents() const {
    requireStopped();
    return std::span{render_.events}.first(static_cast<std::size_t>(render_.count.load()));
}

void VoicePacketTrace::exportCsv(const std::string& pathPrefix) const {
    requireStopped();
    if (!captured_ || pathPrefix.empty())
        throw std::logic_error("No stopped packet trace or export path");
    RealtimeInstrumentation::reportDiskIo();
    {
        auto out = openCsv(pathPrefix + ".sender.csv",
            "generation,participantKey,streamEpoch,sequence,codec,captureFirstFrame,"
            "captureEndFrame,effectiveFrame,payloadHash,encodeStartMicros,encodeEndMicros,"
            "sendStartMicros,sendEndMicros,directEndpoint,pcmHash,pcmEnergy,pcmPeak,"
            "pcmZeroFrames,frames,sourceFrames,captureClockValid,endsBeforeGap,relaySent,directSent");
        for (const auto& event : senderEvents()) {
            writePacket(out, event.packet);
            out << ',' << event.captureFirstFrame << ',' << event.captureEndFrame << ','
                << event.effectiveFrame << ',' << event.payloadHash << ','
                << event.encodeStartMicros << ',' << event.encodeEndMicros << ','
                << event.sendStartMicros << ',' << event.sendEndMicros << ','
                << event.directEndpoint << ',';
            writePcm(out, event.pcm);
            out << ',' << event.frames << ',' << event.sourceFrames << ','
                << event.captureClockValid << ',' << event.endsBeforeGap << ','
                << event.relaySent << ',' << event.directSent << '\n';
        }
        finishCsv(out);
    }
    {
        static constexpr std::array<std::string_view, 3> stages{"SOCKET", "REORDER", "DECISION"};
        static constexpr std::array<std::string_view, 4> kinds{"NONE", "REAL", "PCM_LOSS", "OPUS_PLC"};
        static_assert(stages.size() == static_cast<std::size_t>(ReceiveStage::Count));
        static_assert(kinds.size() == static_cast<std::size_t>(DecodedKind::Count));
        auto out = openCsv(pathPrefix + ".receive.csv",
            "generation,participantKey,streamEpoch,sequence,codec,stage,reason,decodedKind,"
            "socketMicros,processingMicros,decisionMicros,socketRoomFrame,effectiveFrame,"
            "sourceEndpoint,wireHash,payloadHash,horizonFrame,queueEpoch,queueStartFrame,"
            "queueFrames,pcmHash,pcmEnergy,pcmPeak,pcmZeroFrames,dueInFrames,targetDelayFrames,"
            "packetFrames,decodedFrames,sourceOffsetFrames,correctedFrames,lateSkipFrames,"
            "queueFillFrames,viaRelay,queueAccepted");
        for (const auto& event : receiveEvents()) {
            writePacket(out, event.packet);
            out << ',' << enumName(event.stage, stages) << ',' << reasonName(event.reason) << ','
                << enumName(event.decodedKind, kinds) << ',' << event.socketMicros << ','
                << event.processingMicros << ',' << event.decisionMicros << ','
                << event.socketRoomFrame << ',' << event.effectiveFrame << ','
                << event.sourceEndpoint << ',' << event.wireHash << ',' << event.payloadHash << ','
                << event.horizonFrame << ',';
            writeQueue(out, event.queue);
            out << ',';
            writePcm(out, event.pcm);
            out << ',' << event.dueInFrames << ',' << event.targetDelayFrames << ','
                << event.packetFrames << ',' << event.decodedFrames << ','
                << event.sourceOffsetFrames << ',' << event.correctedFrames << ','
                << event.lateSkipFrames << ',' << event.queueFillFrames << ','
                << event.viaRelay << ',' << event.queueAccepted << '\n';
        }
        finishCsv(out);
    }
    {
        auto out = openCsv(pathPrefix + ".render.csv",
            "generation,participantKey,queueEpoch,queueStartFrame,queueFrames,outputTimelineFrame,"
            "beforeHash,beforeEnergy,beforePeak,beforeZeroFrames,afterHash,afterEnergy,afterPeak,"
            "afterZeroFrames,frames,tagZeroFrames,tagOneFrames,starvationFrames,missingBeforeFrames,"
            "missingAfterFrames,recoveryFrames,gain,muted,reset");
        for (const auto& event : renderEvents()) {
            out << event.generation << ',' << event.participantKey << ',';
            writeQueue(out, event.queue);
            out << ',' << event.outputTimelineFrame << ',';
            writePcm(out, event.before);
            out << ',';
            writePcm(out, event.after);
            out << ',' << event.frames << ',' << event.tagZeroFrames << ','
                << event.tagOneFrames << ',' << event.starvationFrames << ','
                << event.missingBeforeFrames << ',' << event.missingAfterFrames << ','
                << event.recoveryFrames << ',' << event.gain << ',' << event.muted << ','
                << event.reset << '\n';
        }
        finishCsv(out);
    }
    {
        const auto captured = status();
        auto out = openCsv(pathPrefix + ".status.csv",
            "captureEpoch,prepared,active,complete,senderEvents,receiveEvents,renderEvents,"
            "senderOverflow,receiveOverflow,renderOverflow,senderCapacity,receiveCapacity,"
            "renderCapacity,senderEventBytes,receiveEventBytes,renderEventBytes");
        out << captured.captureEpoch << ',' << captured.prepared << ',' << captured.active << ','
            << captured.complete() << ',' << captured.senderEvents << ',' << captured.receiveEvents
            << ',' << captured.renderEvents << ',' << captured.senderOverflow << ','
            << captured.receiveOverflow << ',' << captured.renderOverflow << ','
            << sender_.events.size() << ',' << receive_.events.size() << ','
            << render_.events.size() << ',' << sizeof(SenderEvent) << ',' << sizeof(ReceiveEvent)
            << ',' << sizeof(RenderEvent) << '\n';
        finishCsv(out);
    }
}

std::uint64_t VoicePacketTrace::hashBytes(std::span<const std::byte> bytes) noexcept {
    // FNV-1a is a deterministic content join, not an authentication primitive.
    auto hash = FnvOffset;
    appendHash(hash, bytes);
    return hash;
}

VoicePacketTrace::PcmMetrics VoicePacketTrace::measurePcm(std::span<const float> samples,
                                                       std::uint32_t channels, float gain) noexcept {
    PcmMetrics metrics;
    metrics.hash = FnvOffset;
    for (const auto source : samples) {
        const auto sample = source * gain;
        appendHash(metrics.hash, std::as_bytes(std::span{&sample, 1U}));
        metrics.energy += static_cast<double>(sample) * sample;
        metrics.peak = std::max(metrics.peak, std::abs(sample));
    }
    if (channels != 0) {
        for (std::size_t frame = 0; frame + channels <= samples.size(); frame += channels) {
            bool zero = true;
            for (std::uint32_t channel = 0; channel < channels; ++channel)
                zero = zero && samples[frame + channel] * gain == 0.0F;
            if (zero)
                ++metrics.zeroFrames;
        }
    }
    return metrics;
}
