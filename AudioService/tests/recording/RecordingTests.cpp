#include "TestHarness.hpp"
#include "app/AudioService.hpp"
#include "backend/fake/FakeAudioBackend.hpp"
#include "media/WavDecoder.hpp"
#include "network/PcmVoiceCodec.hpp"
#include "realtime/DiagnosticVocalPilot.hpp"
#include "realtime/RealtimeInstrumentation.hpp"
#include "recording/PerformanceAligner.hpp"
#include "recording/RecordingEngine.hpp"

#include <algorithm>
#include <cfenv>
#include <chrono>
#include <filesystem>
#include <limits>
#include <ranges>
#include <thread>
#include <vector>

// Fault injection exercises disk/RIFF failures without filling the machine's disk.
struct RecordingTestAccess {
    static std::span<const float> diagnosticCapture(const RealtimeEngine& engine) {
        return engine.diagnosticCaptureInput_;
    }
    static void holdPerformanceReader(RealtimeEngine& engine) {
        engine.performanceReaders_.fetch_add(1);
    }
    static bool performanceSuspended(const RealtimeEngine& engine) {
        return engine.performanceSuspended_.load();
    }
    static void releasePerformanceReader(RealtimeEngine& engine) {
        engine.performanceReaders_.fetch_sub(1);
        engine.performanceReaders_.notify_all();
    }
    static bool fileOpen(const RecordingEngine& recording) {
        return recording.writer_.open();
    }
    static bool timelineOpen(const RecordingEngine& recording) {
        return recording.timelineWriter_.is_open();
    }
    static bool backingOpen(const RecordingEngine& recording) {
        return recording.backingWriter_.open();
    }
    static void failOutput(WavWriter& writer) {
        writer.file_.setstate(std::ios::badbit);
    }
    static void failOutput(RecordingEngine& recording) {
        failOutput(recording.writer_);
    }
    static void nearRiffLimit(WavWriter& writer) {
        writer.dataBytes_ = 0xFFFFFFFFULL - 37U;
    }
};

namespace Tests {
void masterCompanionSharesOverrunsAndLifecycle() {
    RecordingEngine recording;
    const auto path = tempRoot / "paired-overrun.wav";
    recording.prepare("paired", path.string(), 48'000, 1, RecordingTap::MasterMix, 4, true);
    recording.start(SessionFrame{0}, 0);
    const std::vector<float> oversizedMaster(8, 0.9F), oversizedBacking(8, 0.8F);
    const std::array<float, 4> master{0.5F, 0.4F, 0.3F, 0.2F};
    const std::array<float, 4> backing{0.2F, 0.1F, 0.0F, -0.1F};
    recording.push(GenerationId{0}, RecordingTap::MasterMix, SessionFrame{0}, oversizedMaster, 8,
                    {48'000, 0, 0, true}, oversizedBacking);
    recording.push(GenerationId{0}, RecordingTap::MasterMix, SessionFrame{8}, master, 4,
                    {48'008, 0, 0, true}, backing);
    const auto result = recording.stop(SessionFrame{12});
    expect(result.finalized && result.durationFrames == 12 && result.overrunCount == 1 &&
               result.gaps.size() == 1 && result.gaps.front().frameCount == 8,
           "one rejected pair creates one known shared timeline gap");
    for (const auto& [file, expected] : {
             std::pair{path.string(), std::span<const float>{master}},
             std::pair{path.string() + ".backing.wav", std::span<const float>{backing}}}) {
        WavDecoder decoder;
        const auto format = decoder.open(file);
        std::vector<float> actual(12, -1.0F);
        expect(format.totalFrames == 12 && decoder.read(actual, 12) == 12 &&
                   std::ranges::all_of(std::span{actual}.first(8), [](float value) { return value == 0.0F; }),
               "both WAVs insert identical overrun silence at the same sample offsets");
        for (std::size_t frame = 0; frame < expected.size(); ++frame)
            expect(std::abs(actual[8 + frame] - expected[frame]) < 0.00005F,
                   "the next accepted master/backing pair stays sample-aligned after the gap");
    }
    expect(!RecordingTestAccess::backingOpen(recording), "successful finalization closes the companion");
    recording.prepare("failure", (tempRoot / "paired-failure.wav").string(), 48'000, 1,
                       RecordingTap::MasterMix, 4, true);
    recording.fail("controlled paired failure");
    expect(!RecordingTestAccess::backingOpen(recording), "failure abandons both WAV writers");
    recording.prepare("legacy", (tempRoot / "paired-legacy.wav").string(), 48'000, 1,
                       RecordingTap::MasterMix, 4);
    expect(!recording.backingEnabled() && !RecordingTestAccess::backingOpen(recording),
           "an ordinary master caller keeps its previous single-WAV behavior");
}

void recordingTimelineClosesWithLifecycle() {
    RecordingEngine recording;
    const auto first = tempRoot / "timeline-prepared.wav";
    recording.prepare("first", first.string(), 48'000, 1, RecordingTap::MasterMix, 480);
    expect(RecordingTestAccess::timelineOpen(recording), "master creates its timeline sidecar");
    recording.prepare("raw", (tempRoot / "timeline-raw.wav").string(), 48'000, 1,
                       RecordingTap::RawInput, 480);
    expect(!RecordingTestAccess::timelineOpen(recording),
           "re-preparing a legacy tap closes the earlier diagnostic timeline");
    recording.prepare("failure", (tempRoot / "timeline-failure.wav").string(), 48'000, 1,
                       RecordingTap::MasterMix, 480);
    recording.fail("controlled failure");
    expect(!RecordingTestAccess::timelineOpen(recording), "failure closes the timeline writer");
    recording.prepare("retry", (tempRoot / "timeline-retry.wav").string(), 48'000, 1,
                       RecordingTap::MasterMix, 480);
    expect(RecordingTestAccess::timelineOpen(recording), "a failed recording can prepare a new sidecar");
    recording.start(SessionFrame{0}, 0);
    const std::array<float, 2> pcm{0.1F, 0.2F};
    recording.push(GenerationId{0}, RecordingTap::MasterMix, SessionFrame{0}, pcm, 2,
                    {48'000, 0, 0, true});
    expect(recording.stop(SessionFrame{2}).finalized && !RecordingTestAccess::timelineOpen(recording),
           "normal finalization closes the sidecar too");
}

void networkReferenceRetainsTheCaptureSpanAcrossBlocks() {
    RecordingEngine recording;
    NetworkAudioEngine network{&recording};
    constexpr auto generation = GenerationId{1};
    recording.setGeneration(generation);
    const auto path = tempRoot / "network-cross-block.wav";
    recording.prepare("span", path.string(), 48'000, 1, RecordingTap::NetworkInput, 480);
    recording.start(SessionFrame{0}, 0);
    network.prepare(48'000, 1, 480, 120, generation);
    network.setSharedTimeline(true);
    UdpSocket receiver;
    receiver.bind(0);
    receiver.setReceiveTimeoutMs(250);
    network.startSend("127.0.0.1", receiver.localPort());
    const std::array<float, 60> pcm{};
    // The source device's next timestamp moves two frames, below the sender's reanchor threshold.
    network.pushLocal(generation, pcm, 60, 48'000, 1.0F, 96'000, true);
    network.pushLocal(generation, pcm, 60, 48'060, 1.0F, 96'062, true);
    std::array<std::byte, 2048> bytes{};
    expect(receiver.receive(bytes) > AudioPacketHeaderBytes, "one packet spans two source blocks");
    network.stop();
    expect(recording.stop(SessionFrame{120}).finalized, "the spanning reference finalizes");
    std::ifstream timeline(path.string() + ".timeline.csv");
    std::string row;
    std::getline(timeline, row);
    std::getline(timeline, row);
    expect(row == "0,48000,120,48000,1,96000,96122,48000",
           "capture end comes from the last consumed physical block, not first plus sample count");
}

void masterRecordingTimelineUsesActualPresentation() {
    AudioService service{std::make_unique<FakeAudioBackend>()};
    service.start();
    service.session().prepare({});
    service.session().start();
    service.network().setRoomClock(2'000'000, 1'000'000);
    const auto path = tempRoot / "master-presentation.wav";
    expect(service.handleLine("1|PrepareRecording|id=master|path=" + path.string() +
                              "|tap=master").status == ControlStatus::Ok &&
               service.handleLine("1|StartRecording").status == ControlStatus::Ok,
           "master recording prepares through existing commands");
    std::vector<float> output(128U * 2U);
    const auto presentation = MonotonicTicks{1'100'000'000};
    BackendAudioBuffer render{nullptr, output.data(), 128, 2};
    render.presentationTicks = presentation;
    service.realtime().onRender(service.session().generationId(), render);
    expect(service.handleLine("1|StopRecording").status == ControlStatus::Ok,
           "master recording finalizes");
    std::ifstream timeline(path.string() + ".timeline.csv");
    std::string row;
    std::getline(timeline, row);
    expect(row == "wavOffsetFrames,timelineFrame,frames,sampleRateHz,roomClockValid,"
                  "captureTimelineFrame,captureEndTimelineFrame,timelineSampleRateHz",
           "master metadata declares room timeline and WAV units separately");
    std::getline(timeline, row);
    expect(row == "0,100800,128,48000,1,0,0,48000",
           "WAV frame zero is anchored to actual output presentation, not recording command time");
}

void networkReferenceRecordsTheActualPreCodecMicrophone() {
    for (const auto inputRate : {44'100U, 48'000U}) {
        FakeBackendSettings settings;
        settings.runtime.inputSampleRateHz = inputRate;
        settings.runtime.inputChannels = 2;
        settings.runtime.outputChannels = 6;
        settings.capabilities.outputChannels = 6;
        AudioService service{std::make_unique<FakeAudioBackend>(settings)};
        service.start();
        service.session().prepare({});
        service.session().start();
        service.network().setRoomClock(1'000'000, 1'000'000);
        service.network().setSharedTimeline(true);
        service.realtime().setAcousticLatency(12'000'000);
        service.realtime().setMonitoring(false);
        service.realtime().setMixerGains(MixerGains{.microphone = 0.5F});
        service.realtime().setDspEnabled(true);
        expect(service.realtime().setDspParameter("highpass.cutoffHz", 300.0F),
               "the reference includes the actual capture DSP");
        UdpSocket receiver;
        receiver.bind(0);
        receiver.setReceiveTimeoutMs(250);
        service.network().startSend("127.0.0.1", receiver.localPort());
        const auto path = tempRoot / ("network-mic-" + std::to_string(inputRate) + ".wav");
        expect(service.handleLine("1|PrepareRecording|id=mic|path=" + path.string() +
                                  "|tap=network").status == ControlStatus::Ok &&
                   service.handleLine("1|StartRecording").status == ControlStatus::Ok,
               "the existing recorder can select the diagnostic pre-codec tap");
        const auto frames = inputRate / 100U;
        std::vector<float> input(frames * 2U), expected(frames * 6U);
        for (std::uint32_t frame = 0; frame < frames; ++frame) {
            input[frame * 2U] = 0.001F;
            input[frame * 2U + 1U] = 0.2F + 0.1F * std::sin(frame * 0.1F);
            std::fill_n(expected.begin() + frame * 6U, 6U, input[frame * 2U + 1U]);
        }
        DspChain expectedDsp;
        expectedDsp.prepare(inputRate, frames, 6);
        expectedDsp.setEnabled(true);
        expect(expectedDsp.setParameter("highpass.cutoffHz", 300.0F), "reference DSP configured");
        expectedDsp.process(expected, frames);
        BackendAudioBuffer capture{input.data(), nullptr, frames, 2};
        capture.captureTicks = 1'000'000'000;
        RealtimeInstrumentation::reset();
        service.realtime().onCapture(service.session().generationId(), capture);
        const auto violations = RealtimeInstrumentation::snapshot();
        expect(violations.allocations == 0 && violations.blockingCalls == 0 &&
                   violations.diskIoCalls == 0 && violations.networkIoCalls == 0,
               "recording adds no realtime file, socket, lock or allocation operations");
        std::array<std::byte, 2048> bytes{};
        std::vector<float> transmitted;
        std::vector<std::uint64_t> stamps;
        std::optional<std::uint32_t> previous;
        std::uint32_t consumed = 0;
        while (stamps.size() < 4U) {
            const auto size = receiver.receive(bytes);
            AudioPacketHeader header{};
            expect(size > AudioPacketHeaderBytes && decodeAudioPacketHeader(bytes, header),
                   "the physical capture path produces a packet without rendering");
            if (size <= AudioPacketHeaderBytes)
                break;
            if (previous == header.sequence)
                continue;
            const auto decoded = PcmVoiceCodec::decode(
                std::span<const std::byte>{bytes.data() + AudioPacketHeaderBytes,
                                          size - AudioPacketHeaderBytes}, 120);
            const auto count = deviceFramesForVoicePacket(stamps.size(), inputRate);
            std::vector<float> mono(count);
            for (std::uint32_t frame = 0; frame < count; ++frame)
                mono[frame] = expected[(consumed + frame) * 6U] * 0.5F;
            const auto normalized = retimeInterleavedLinear(mono, 1, 120);
            for (std::size_t frame = 0; frame < decoded.size(); ++frame)
                expect(std::abs(decoded[frame] - normalized[frame]) < 0.00004F,
                       "the sent source selects input channel 1, applies DSP and microphone gain");
            consumed += count;
            stamps.push_back(header.timestampFrame & MediaTimelineMask);
            transmitted.insert(transmitted.end(), decoded.begin(), decoded.end());
            previous = header.sequence;
        }
        expect(service.handleLine("1|StopRecording").status == ControlStatus::Ok,
               "the network reference finalizes through existing recording control");
        WavDecoder decoder;
        const auto format = decoder.open(path.string());
        expect(format.sampleRateHz == VoiceProtocolSampleRateHz && format.channels == 1 &&
                   format.totalFrames == transmitted.size(),
               "pre-codec reference is mono transport-rate PCM, independent of device rates/channels");
        if (format.channels == 1 && format.totalFrames == transmitted.size()) {
            std::vector<float> recorded(transmitted.size());
            decoder.read(recorded, static_cast<std::uint32_t>(recorded.size()));
            for (std::size_t frame = 0; frame < recorded.size(); ++frame)
                expect(std::abs(recorded[frame] - transmitted[frame]) < 0.00004F,
                       "reference PCM matches the exact network source before quantization");
        }
        std::ifstream timeline(path.string() + ".timeline.csv");
        std::string row;
        std::getline(timeline, row);
        expect(row == "wavOffsetFrames,timelineFrame,frames,sampleRateHz,roomClockValid,"
                      "captureTimelineFrame,captureEndTimelineFrame,timelineSampleRateHz",
               "the sidecar declares unambiguous room-timeline units");
        consumed = 0;
        for (std::size_t index = 0; index < stamps.size(); ++index) {
            std::getline(timeline, row);
            const auto captureFirst = 48'000U + scaleFramePosition(consumed, inputRate, 48'000);
            consumed += deviceFramesForVoicePacket(index, inputRate);
            const auto captureEnd = 48'000U + scaleFramePosition(consumed, inputRate, 48'000);
            expect(row == std::to_string(index * 120U) + "," + std::to_string(stamps[index]) +
                              ",120,48000,1," + std::to_string(captureFirst) + "," +
                              std::to_string(captureEnd) + ",48000",
                   "every saved reference packet maps exactly to the timestamp actually sent");
        }
        service.session().stop();
    }
}

namespace {
struct DiagnosticRoomEnvironment {
    std::string previous;
    DiagnosticRoomEnvironment() {
        char* value = nullptr;
        std::size_t length = 0;
        if (_dupenv_s(&value, &length, "AD_VOICE_ROOM_E2E") == 0 && value != nullptr)
            previous = value;
        std::free(value);
        _putenv_s("AD_VOICE_ROOM_E2E", "1");
    }
    ~DiagnosticRoomEnvironment() {
        _putenv_s("AD_VOICE_ROOM_E2E", previous.c_str());
    }
};

void makeDiagnosticPcm24(const std::filesystem::path& path, std::uint32_t seconds) {
    // Reuse the WAV writer's standard header, then supply exact 24-bit stereo PCM.
    WavWriter writer;
    writer.open(path.string(), 8'000, 2);
    writer.close();
    std::fstream file(path, std::ios::binary | std::ios::in | std::ios::out);
    const auto writeAt = [&file](std::streamoff offset, auto value) {
        file.seekp(offset);
        file.write(reinterpret_cast<const char*>(&value), sizeof(value));
    };
    const std::uint32_t bytes = seconds * 8'000U * 6U;
    writeAt(4, bytes + 36U);
    writeAt(28, 8'000U * 6U);
    writeAt(32, std::uint16_t{6});
    writeAt(34, std::uint16_t{24});
    writeAt(40, bytes);
    std::array<char, 48'000> second{};
    for (std::size_t frame = 0; frame < second.size() / 6U; ++frame) {
        second[frame * 6U + 2U] = 0x20; // left = .25
        second[frame * 6U + 5U] = 0x40; // right = .5
    }
    for (std::uint32_t index = 0; index < seconds; ++index)
        file.write(second.data(), second.size());
}
} // namespace

void diagnosticFileInputUsesTheExistingCaptureAndServerClock() {
    const DiagnosticRoomEnvironment environment;
    const auto path = tempRoot / "diagnostic-vocal.wav";
    WavWriter writer;
    writer.open(path.string(), 44'100, 2);
    std::vector<float> source(441U * 2U);
    for (std::size_t frame = 0; frame < source.size() / 2U; ++frame)
        source[frame * 2U] = source[frame * 2U + 1U] = 0.1F + frame * 0.0002F;
    writer.write(source);
    writer.close();
    for (const auto inputRate : {44'100U, 48'000U}) {
        FakeBackendSettings settings;
        settings.runtime.inputSampleRateHz = inputRate;
        auto backend = std::make_unique<FakeAudioBackend>(settings);
        AudioService service{std::move(backend)};
        service.start();
        service.session().prepare(RequestedConfiguration{});
        expect(service.handleLine("1|SetDiagnosticRoomInput|enabled=true|gain=0.5|"
                                  "musicalStartUnixMs=1000000|filePath=" +
                                  path.string())
                       .status == ControlStatus::Ok,
               "a diagnostic WAV loads before capture starts");
        service.session().start();
        // Two different device clocks map to the same authoritative capture time.
        const auto localStart = inputRate == 44'100U ? 1'000'000'000LL : 2'000'000'000LL;
        service.network().setRoomClock(1'000'000'000LL, localStart / 1'000);
        std::vector<float> input(128, 0.9F);
        const auto capture = [&](std::int64_t offsetNs) {
            BackendAudioBuffer buffer{input.data(), nullptr, 128, 1};
            buffer.captureTicks = localStart + offsetNs;
            service.realtime().onCapture(service.session().generationId(), buffer);
        };
        RealtimeInstrumentation::reset();
        capture(-20'000'000LL);
        auto samples = RecordingTestAccess::diagnosticCapture(service.realtime()).first(128);
        expect(std::ranges::all_of(samples, [](float value) { return value == 0.0F; }),
               "a file never leaks before its authoritative start");
        capture(0);
        samples = RecordingTestAccess::diagnosticCapture(service.realtime()).first(128);
        expect(std::abs(samples[0] - 0.05F) < 0.0001F,
               "both local clocks emit the first decoded vocal frame at the same room frame");
        const auto sourcePosition = (127U * 48'000U / inputRate) * 44'100.0 / 48'000.0;
        expect(std::abs(samples[127] - (0.1 + sourcePosition * 0.0002) * 0.5) < 0.0001,
               "sample conversion follows capture rate and the server frame, not callback count");
        capture(20'000'000LL);
        samples = RecordingTestAccess::diagnosticCapture(service.realtime()).first(128);
        expect(std::ranges::all_of(samples, [](float value) { return value == 0.0F; }),
               "natural EOF is silence, never a repeated vocal loop");
        const auto violations = RealtimeInstrumentation::snapshot();
        expect(violations.allocations == 0 && violations.deallocations == 0 &&
                   violations.blockingCalls == 0 && violations.diskIoCalls == 0 &&
                   violations.networkIoCalls == 0 && violations.ipcCalls == 0,
               "file sampling has no realtime allocation, lock, file, socket or IPC calls");
        const auto diagnostics = service.handleLine("1|GetDiagnostics").text;
        expect(diagnostics.find("DiagnosticInputMode: File") != std::string::npos &&
                   diagnostics.find("DiagnosticFileFrames: 441") != std::string::npos &&
                   diagnostics.find("DiagnosticFileSampleRate: 44100") != std::string::npos,
               "diagnostics identify the loaded source and captured file mode");
    }
}

void diagnosticFileInputRejectsActiveReplacementAndResetsOwnership() {
    const auto path = tempRoot / "diagnostic-owner.wav";
    WavWriter writer;
    writer.open(path.string(), 48'000, 1);
    writer.write(std::vector<float>(480, 0.2F));
    writer.close();
    AudioService service{std::make_unique<FakeAudioBackend>()};
    service.start();
    const auto load = "1|SetDiagnosticRoomInput|enabled=false|filePath=" + path.string();
    _putenv_s("AD_VOICE_ROOM_E2E", "");
    expect(service.handleLine(load).status == ControlStatus::NotSupported,
           "a WAV never bypasses the production diagnostic environment guard");
    const DiagnosticRoomEnvironment environment;
    service.session().prepare(RequestedConfiguration{});
    expect(service.handleLine(load).status == ControlStatus::Ok, "a stopped source loads");
    service.session().start();
    for (const auto& command : {load, std::string{"1|SetDiagnosticRoomInput|clearFile=true"}})
        expect(service.handleLine(command).status == ControlStatus::InvalidRequest,
               "active capture owns immutable file PCM; replacement and clear are rejected");
    expect(service.handleLine("1|SetDiagnosticRoomInput|enabled=true|gain=0.1|"
                              "musicalStartUnixMs=1000000")
                   .status == ControlStatus::Ok,
           "enabling an already loaded file does not replace its storage");
    service.session().stop();
    expect(service.handleLine("1|GetDiagnostics").text.find("DiagnosticInputMode: Disabled") !=
               std::string::npos,
           "session reset disarms diagnostic input");
    expect(service.handleLine(load).status == ControlStatus::Ok &&
               service.handleLine("1|SetDiagnosticRoomInput|enabled=false|clearFile=true").status ==
                   ControlStatus::Ok,
           "a stopped file can be reloaded and cleared without capture ownership");
    expect(service.handleLine("1|GetDiagnostics").text.find("DiagnosticFileFrames: 0") !=
               std::string::npos,
           "clear releases the old file identity");
}

void diagnosticFileInputBoundsDecodeAndPreservesAValidSourceOnFailure() {
    const DiagnosticRoomEnvironment environment;
    const auto longPath = tempRoot / "diagnostic-188s-pcm24.wav";
    makeDiagnosticPcm24(longPath, 188);
    AudioService service{std::make_unique<FakeAudioBackend>()};
    service.start();
    service.session().prepare(RequestedConfiguration{});
    const auto command = "1|SetDiagnosticRoomInput|enabled=false|filePath=";
    expect(service.handleLine(command + longPath.string()).status == ControlStatus::Ok,
           "a three-minute processed PCM24 stereo vocal is a supported diagnostic source");
    const auto identity = service.realtime().diagnosticRoomInputReport();
    const auto tooLong = tempRoot / "diagnostic-301s.wav";
    makeDiagnosticPcm24(tooLong, 301);
    for (const auto& path : {tooLong, tempRoot / "missing-diagnostic.wav"}) {
        expect(service.handleLine(command + path.string()).status != ControlStatus::Ok,
               "invalid diagnostic files fail explicitly before replacing the source");
        expect(service.realtime().diagnosticRoomInputReport() == identity,
               "a failed load preserves the previous decoded file identity");
    }
    expect(service.handleLine("1|SetDiagnosticRoomInput|enabled=true|gain=0.1").status ==
               ControlStatus::InvalidRequest,
           "file playback requires an explicit authoritative epoch");
    service.network().setRoomClock(1'000'000, 1'000'000);
    service.realtime().setDiagnosticRoomInput(true, 0, 0.5F, 1'000);
    std::array<float, 128> capture{};
    BackendAudioBuffer buffer{capture.data(), nullptr, 128, 1};
    buffer.captureTicks = 1'000'000'000;
    service.realtime().onCapture(service.session().generationId(), buffer);
    expect(std::abs(RecordingTestAccess::diagnosticCapture(service.realtime())[0] - 0.1875F) <
               0.000001F,
           "PCM24 channels downmix before capture with the configured gain");
}

void diagnosticFileInputReachesProcessedMonitorAndUpstream() {
    const DiagnosticRoomEnvironment environment;
    const auto path = tempRoot / "diagnostic-through-dsp.wav";
    makeTestWav(path, 48'000);
    auto backend = std::make_unique<FakeAudioBackend>();
    AudioService service{std::move(backend)};
    service.start();
    service.session().prepare(RequestedConfiguration{});
    expect(service.handleLine("1|SetDiagnosticRoomInput|enabled=true|gain=0.1|"
                              "musicalStartUnixMs=1000|filePath=" +
                              path.string())
                   .status == ControlStatus::Ok,
           "the file is armed before capture");
    service.session().start();
    service.network().setRoomClock(1'000'000, 1'000'000);
    service.network().setSharedTimeline(true);
    UdpSocket receiver;
    receiver.bind(0);
    service.network().startSend("127.0.0.1", receiver.localPort());
    service.realtime().setMonitoring(true);
    std::array<float, 128> capture{};
    std::array<float, 256> output{};
    float peak = 0.0F;
    RealtimeInstrumentation::reset();
    for (std::int64_t block = 0; block < 100; ++block) {
        const auto ticks = 1'000'000'000 + block * 128 * 1'000'000'000 / 48'000;
        BackendAudioBuffer input{capture.data(), nullptr, 128, 1, block * 128, ticks};
        input.captureTicks = ticks;
        service.realtime().onCapture(service.session().generationId(), input);
        service.realtime().onRender(service.session().generationId(),
                                    {nullptr, output.data(), 128, 2, block * 128, ticks});
        for (const auto sample : output)
            peak = std::max(peak, std::abs(sample));
    }
    const auto violations = RealtimeInstrumentation::snapshot();
    expect(
        peak > 0.001F && service.network().diagnostics().normalizedSendNonzeroBlocks > 0,
        "the same file traverses capture conversion and DSP into local monitor and network input");
    expect(violations.allocations == 0 && violations.deallocations == 0 &&
               violations.blockingCalls == 0 && violations.diskIoCalls == 0 &&
               violations.networkIoCalls == 0 && violations.ipcCalls == 0,
           "complete capture/render file path has no realtime violations");
    service.network().stop();
}

void diagnosticFilePilotIsAnOptionalLabelBeforeDspAndStopsAtEof() {
    const DiagnosticRoomEnvironment environment;
    const auto path = tempRoot / "diagnostic-labelled-vocal.wav";
    makeTestWav(path, 480);
    AudioService service{std::make_unique<FakeAudioBackend>()};
    service.start();
    service.session().prepare(RequestedConfiguration{});
    expect(service.handleLine("1|SetDiagnosticRoomInput|enabled=true|gain=0.1|"
                              "musicalStartUnixMs=1000|filePath=" +
                              path.string())
                   .status == ControlStatus::Ok,
           "the unlabelled file loads");
    service.session().start();
    service.network().setRoomClock(1'000'000, 1'000'000);
    std::array<float, 128> input{}, original{};
    BackendAudioBuffer buffer{input.data(), nullptr, 128, 1};
    buffer.captureTicks = 1'000'000'000;
    service.realtime().onCapture(service.session().generationId(), buffer);
    std::ranges::copy(RecordingTestAccess::diagnosticCapture(service.realtime()).first(128),
                      original.begin());
    expect(service.handleLine("1|SetDiagnosticRoomInput|enabled=true|gain=0.1|frequencyHz=697|"
                              "musicalStartUnixMs=1000|pilotGain=0.02")
                   .status == ControlStatus::Ok,
           "an explicit label can be armed without changing file ownership");
    service.realtime().onCapture(service.session().generationId(), buffer);
    const auto labelled = RecordingTestAccess::diagnosticCapture(service.realtime()).first(128);
    for (std::uint32_t frame = 0; frame < 128; ++frame) {
        const auto expected = original[frame] + diagnosticVocalPilotSample(48'000U + frame, 48'000U,
                                                                           48'000, 697, 0.02F);
        expect(std::abs(labelled[frame] - expected) < 0.000001F,
               "the label is a pointwise capture input sum, before bridge and DSP");
    }
    buffer.captureTicks += 20'000'000;
    service.realtime().onCapture(service.session().generationId(), buffer);
    expect(
        std::ranges::all_of(RecordingTestAccess::diagnosticCapture(service.realtime()).first(128),
                            [](float value) { return value == 0.0F; }),
        "the label stops with file EOF even inside a pilot pulse");
    expect(service.handleLine("1|SetDiagnosticRoomInput|pilotGain=2").status ==
               ControlStatus::InvalidRequest,
           "the optional label has a finite bounded gain");
}

void diagnosticFileOffsetResumesAtSongPositionWithoutEarlyAudio() {
    const DiagnosticRoomEnvironment environment;
    const auto path = tempRoot / "diagnostic-resume-offset.wav";
    WavWriter writer;
    writer.open(path.string(), 44'100, 1);
    std::vector<float> source(4'410);
    for (std::size_t frame = 0; frame < source.size(); ++frame)
        source[frame] = 0.1F + frame * 0.00001F;
    writer.write(source);
    writer.close();
    AudioService service{std::make_unique<FakeAudioBackend>()};
    service.start();
    service.session().prepare(RequestedConfiguration{});
    expect(service.handleLine("1|SetDiagnosticRoomInput|enabled=false|filePath=" + path.string())
                   .status == ControlStatus::Ok,
           "resume reuses a file loaded before capture starts");
    service.session().start();
    service.network().setRoomClock(1'000'000, 1'000'000);
    expect(service.handleLine("1|SetDiagnosticRoomInput|enabled=true|gain=0.5|frequencyHz=697|"
                              "musicalStartUnixMs=1000|fileOffsetFrames=441|pilotGain=0.02")
                   .status == ControlStatus::Ok,
           "a source-file frame offset arms without replacing immutable PCM");
    std::array<float, 128> input{};
    BackendAudioBuffer buffer{input.data(), nullptr, 128, 1};
    buffer.captureTicks = 980'000'000;
    RealtimeInstrumentation::reset();
    service.realtime().onCapture(service.session().generationId(), buffer);
    expect(
        std::ranges::all_of(RecordingTestAccess::diagnosticCapture(service.realtime()).first(128),
                            [](float value) { return value == 0.0F; }),
        "an offset never leaks a resumed vocal before the future authoritative start");
    buffer.captureTicks = 1'000'000'000;
    service.realtime().onCapture(service.session().generationId(), buffer);
    const auto captured = RecordingTestAccess::diagnosticCapture(service.realtime()).first(128);
    for (std::uint32_t frame = 0; frame < 128; ++frame) {
        const auto position = 441.0 + frame * 44'100.0 / 48'000.0;
        const auto expected = (0.1 + position * 0.00001) * 0.5 +
                              diagnosticVocalPilotSample(480U + frame, 0, 48'000, 697, 0.02F);
        expect(std::abs(captured[frame] - expected) < 0.00004,
               "vocal and pilot resume at the same source musical position");
    }
    buffer.captureTicks = 1'090'000'000;
    service.realtime().onCapture(service.session().generationId(), buffer);
    expect(
        std::ranges::all_of(RecordingTestAccess::diagnosticCapture(service.realtime()).first(128),
                            [](float value) { return value == 0.0F; }),
        "offset shortens remaining vocal duration and pilot ends exactly at EOF");
    const auto violations = RealtimeInstrumentation::snapshot();
    expect(violations.allocations == 0 && violations.deallocations == 0 &&
               violations.blockingCalls == 0 && violations.diskIoCalls == 0 &&
               violations.networkIoCalls == 0 && violations.ipcCalls == 0,
           "offset sampling retains the realtime no-work violations contract");
    expect(service.handleLine("1|GetDiagnostics").text.find("DiagnosticFileOffsetFrames: 441") !=
               std::string::npos,
           "diagnostics identify the actual resumed file position");
    expect(
        service.handleLine("1|SetDiagnosticRoomInput|enabled=false|fileOffsetFrames=-1").status ==
            ControlStatus::InvalidRequest,
        "a negative file position is rejected by the existing integer parser");
    service.session().stop();
    expect(service.handleLine("1|GetDiagnostics").text.find("DiagnosticFileOffsetFrames: 0") !=
               std::string::npos,
           "session reset clears diagnostic seek ownership");
}

void performanceAlignerPlacesVoiceOnTheMusicItWasSungTo() {
    constexpr std::uint32_t lead = 100;
    constexpr std::uint32_t block = 10;
    constexpr std::uint32_t voiceLate = 30;
    PerformanceAligner aligner;
    aligner.prepare(1, lead, block);
    std::vector<float> music(block, 0.0F), voice(block, 0.0F), out(block, 0.0F);
    std::vector<float> aligned;
    for (std::uint32_t index = 0; index < 30; ++index) {
        std::ranges::fill(music, 0.0F);
        std::ranges::fill(voice, 0.0F);
        if (index == 0)
            music[0] = 1.0F; // the beat
        if (index * block == voiceLate)
            voice[0] = 0.5F; // the singer's note on that beat arrives 30 frames later
        aligner.add(music, block, 1.0F, 0);
        aligner.add(voice, block, 1.0F, voiceLate);
        aligner.read(out, block);
        aligned.insert(aligned.end(), out.begin(), out.end());
    }
    expect(aligned[lead] == 1.5F && std::count_if(aligned.begin(), aligned.end(),
                                                  [](float v) { return v != 0.0F; }) == 1,
           "the late voice lands exactly on its beat, one alignment lead after the music");
}

void recordingLeadInKeepsTheFirstRecordedFrameOnItsSongPosition() {
    RecordingEngine recording;
    const auto path = (tempRoot / "lead-in.wav").string();
    recording.prepare("lead-in", path, 48000, 1, RecordingTap::RawInput, 4096);
    recording.setGeneration(GenerationId{0});
    recording.start(SessionFrame{0}, 1'000, 50);
    std::vector<float> ramp(80);
    for (std::size_t index = 0; index < ramp.size(); ++index)
        ramp[index] = static_cast<float>(index) / 100.0F;
    recording.push(GenerationId{0}, RecordingTap::RawInput, SessionFrame{0}, ramp, 80);
    const auto result = recording.stop(SessionFrame{80});
    WavDecoder decoder;
    decoder.open(path);
    std::vector<float> recorded(80);
    const auto frames = decoder.read(recorded, 80);
    expect(frames == 30 && std::abs(recorded[0] - 0.5F) < 1e-4F &&
               result.startPlaybackPosition == 1'000,
           "the alignment lead is dropped, so the first recorded frame is the start position");
}

void recordingPrepareFailureReleasesFileAndCanRetry() {
    RecordingEngine recording;
    const auto path = (tempRoot / "allocation-failure.wav").string();
    failNextAllocationOfSize(997 * sizeof(float));
    bool failed = false;
    try {
        recording.prepare("allocation", path, 48000, 1, RecordingTap::RawInput, 997);
    } catch (const std::bad_alloc&) {
        failed = true;
    }
    failNextAllocationOfSize(0);
    expect(failed && !RecordingTestAccess::fileOpen(recording) &&
               recording.state() == RecordingState::Failed,
           "failed queue allocation releases the opened WAV and publishes a failed preparation");
    recording.prepare("retry", path, 48000, 1, RecordingTap::RawInput, 997);
    recording.start(SessionFrame{0}, 0);
    expect(recording.stop(SessionFrame{0}).finalized, "a failed preparation permits a clean retry");
}

void recordingCommandsTrimOnlyThePerformanceAlignmentLead() {
    for (const auto [name, tap] : {std::pair{"raw", RecordingTap::RawInput},
                                   std::pair{"processed", RecordingTap::ProcessedVoice},
                                   std::pair{"master", RecordingTap::MasterMix},
                                   std::pair{"performance", RecordingTap::PerformanceMix}}) {
        AudioService service{std::make_unique<FakeAudioBackend>()};
        service.start();
        service.session().prepare(RequestedConfiguration{});
        service.session().start();
        const auto path = tempRoot / (std::string{"recording-command-"} + name + ".wav");
        expect(
            service.handleLine("1|PrepareRecording|id=lead|path=" + path.string() + "|tap=" + name)
                    .status == ControlStatus::Ok,
            "the requested recording tap is prepared through IPC");
        const auto lead = service.realtime().performanceLeadFrames();
        expect(lead > 0, "the performance aligner has a nonzero lead");
        expect(service.handleLine("1|StartRecording").status == ControlStatus::Ok,
               "the recording starts through IPC");
        std::vector<float> pcm(static_cast<std::size_t>(lead + 480U) * 2U, 0.25F);
        pcm[0] = 0.5F;
        pcm[static_cast<std::size_t>(lead) * 2U] = 0.75F;
        service.recording().push(service.session().generationId(), tap, SessionFrame{0}, pcm,
                                 lead + 480U);
        // This fixture injects the selected tap directly, bypassing the realtime aligner.
        // The separate performance boundary test exercises its real command-side drain.
        expect(service.recording().stop(SessionFrame{lead + 480U}).finalized,
               "the injected tap PCM finalizes");
        const auto aligned = tap == RecordingTap::PerformanceMix;
        const auto expectedFrames = aligned ? 480U : lead + 480U;
        WavDecoder decoder;
        const auto format = decoder.open(path.string());
        std::array<float, 2> first{};
        decoder.read(first, 1);
        expect(format.totalFrames == expectedFrames &&
                   service.recording().result().durationFrames == expectedFrames,
               "direct taps retain all frames; only the aligned performance drops its lead");
        expect(std::abs(first[0] - (aligned ? 0.75F : 0.5F)) < 0.0001F,
               "direct taps retain their first sample while performance starts after its lead");
    }
}

void performanceRecordingDrainsStopAndPauseWithoutCapturingThePause() {
    struct Scenario {
        bool pause;
        bool stopPaused;
        bool toEof;
    };
    constexpr std::array scenarios{Scenario{false, false, false}, Scenario{true, false, true},
                                   Scenario{true, true, false}, Scenario{false, false, true}};
    for (const auto segmentFrames : {4800U, 14400U}) {
        for (const auto [pause, stopPaused, toEof] : scenarios) {
            constexpr std::uint32_t blockFrames = 480;
            auto backend = std::make_unique<FakeAudioBackend>();
            auto* fake = backend.get();
            AudioService service{std::move(backend)};
            service.start();
            service.session().prepare(RequestedConfiguration{});
            service.session().start();
            service.realtime().setMicrophoneEnabled(false);
            const auto music = tempRoot / "tail-source.wav";
            const auto path = tempRoot / "tail-performance.wav";
            WavWriter writer;
            writer.open(music.string(), 48000, 2);
            for (const auto level : {0.2F, 0.7F, 0.4F})
                writer.write(std::vector<float>(segmentFrames * 2U, level));
            writer.close();
            service.media().load(MediaSlot::Music, music.string());
            expect(service.media().waitUntilReady(MediaSlot::Music) == PlaybackState::Ready,
                   "the controlled tail source is decoded");
            expect(service.handleLine("1|PrepareRecording|id=tail|tap=performance|path=" +
                                      path.string())
                               .status == ControlStatus::Ok &&
                       service.handleLine("1|StartRecording").status == ControlStatus::Ok,
                   "the performance starts through recording commands");
            service.media().play(MediaContext::Karaoke);
            std::vector<float> capture(blockFrames, 0.0F), output(blockFrames * 2U), expected;
            std::uint32_t sessionFrames = 0;
            const auto renderSegment = [&](bool retained) {
                for (std::uint32_t frame = 0; frame < segmentFrames; frame += blockFrames) {
                    const auto deadline =
                        std::chrono::steady_clock::now() + std::chrono::seconds(2);
                    while (service.media().snapshot(MediaSlot::Music).bufferFillFrames <
                               blockFrames &&
                           std::chrono::steady_clock::now() < deadline)
                        std::this_thread::yield();
                    fake->pump(capture, 1, output, 2, sessionFrames, sessionFrames);
                    sessionFrames += blockFrames;
                    if (retained)
                        expected.insert(expected.end(), output.begin(), output.end());
                }
            };
            renderSegment(true);
            if (pause) {
                expect(service.handleLine("1|PauseRecording").status == ControlStatus::Ok,
                       "pausing drains the end of the recorded segment");
                renderSegment(false);
                if (!stopPaused) {
                    expect(service.handleLine("1|ResumeRecording").status == ControlStatus::Ok,
                           "the next recording segment resumes");
                    renderSegment(true);
                }
            } else if (toEof) {
                renderSegment(true);
                renderSegment(true);
            }
            if (toEof)
                expect(service.media().snapshot(MediaSlot::Music).sourcePositionFrames ==
                           segmentFrames * 3U,
                       "the backing reaches its exact EOF before the recording is finalized");
            expect(service.handleLine("1|StopRecording").status == ControlStatus::Ok,
                   "stopping finalizes the entire retained performance");
            const auto result = service.recording().result();
            WavDecoder decoder;
            const auto format = decoder.open(path.string());
            std::vector<float> actual(expected.size());
            const auto read = decoder.read(actual, static_cast<std::uint32_t>(actual.size() / 2U));
            expect(format.totalFrames == expected.size() / 2U && read == expected.size() / 2U &&
                       result.durationFrames == expected.size() / 2U &&
                       result.stopSessionFrame == SessionFrame{sessionFrames},
                   "short takes keep exact duration and cutoff metadata without adding the "
                   "alignment lead");
            expect(
                std::ranges::any_of(expected, [](float value) { return std::abs(value) > 0.1F; }) &&
                    std::ranges::equal(actual, expected,
                                       [](float a, float b) { return std::abs(a - b) < 0.0001F; }),
                "saved PCM includes every retained sample and excludes PCM heard during pause");
        }
    }
}

void performanceTailWaitsForSmallQueuesAndReportsWriterFailure() {
    for (const auto failWriter : {false, true}) {
        RecordingEngine recording;
        const auto path = tempRoot / "small-tail-queue.wav";
        recording.prepare("tail", path.string(), 48000, 1, RecordingTap::PerformanceMix, 4);
        recording.start(SessionFrame{0}, 0);
        if (failWriter)
            RecordingTestAccess::failOutput(recording);
        std::vector<float> tail(131, 0.2F);
        tail.back() = 0.8F;
        bool failed = false;
        try {
            recording.appendPerformanceTail(SessionFrame{tail.size()}, tail,
                                            static_cast<std::uint32_t>(tail.size()));
        } catch (const std::runtime_error&) {
            failed = true;
        }
        const auto result = recording.stop(SessionFrame{tail.size()});
        expect(
            failed == failWriter && result.finalized != failWriter,
            "tail draining wakes on writer failure instead of waiting forever or claiming success");
        if (failWriter) {
            expect(recording.state() == RecordingState::Failed && !result.errorMessage.empty(),
                   "a failed tail retains explicit failure state and diagnostics");
        } else {
            WavDecoder decoder;
            const auto format = decoder.open(path.string());
            std::vector<float> actual(tail.size());
            decoder.read(actual, static_cast<std::uint32_t>(actual.size()));
            expect(
                format.totalFrames == tail.size() && result.overrunCount == 0 &&
                    std::ranges::equal(actual, tail,
                                       [](float a, float b) { return std::abs(a - b) < 0.0001F; }),
                "a control-side tail larger than queue capacity preserves every sample without "
                "overruns");
        }
    }
}

void performanceDrainNeverSuspendsTheAudibleRender() {
    auto backend = std::make_unique<FakeAudioBackend>();
    auto* fake = backend.get();
    AudioService service{std::move(backend)};
    service.start();
    service.session().prepare(RequestedConfiguration{});
    service.session().start();
    service.realtime().setMicrophoneEnabled(false);
    const auto source = tempRoot / "drain-live-source.wav";
    WavWriter writer;
    writer.open(source.string(), 48000, 2);
    writer.write(std::vector<float>(9600U * 2U, 0.2F));
    writer.close();
    service.media().load(MediaSlot::Music, source.string());
    expect(service.media().waitUntilReady(MediaSlot::Music) == PlaybackState::Ready,
           "the audible source is ready before the drain race");
    const auto path = tempRoot / "drain-live-take.wav";
    expect(service.handleLine("1|PrepareRecording|id=drain|tap=performance|path=" + path.string())
                       .status == ControlStatus::Ok &&
               service.handleLine("1|StartRecording").status == ControlStatus::Ok,
           "the take starts before the drain race");
    service.media().play(MediaContext::Karaoke);
    std::vector<float> input(480, 0.0F), output(960);
    fake->pump(input, 1, output, 2, 0, 0);
    RecordingTestAccess::holdPerformanceReader(service.realtime());
    ControlResponse stopped;
    std::thread control([&] { stopped = service.handleLine("1|StopRecording"); });
    const auto deadline = std::chrono::steady_clock::now() + std::chrono::seconds(2);
    while (!RecordingTestAccess::performanceSuspended(service.realtime()) &&
           std::chrono::steady_clock::now() < deadline)
        std::this_thread::yield();
    expect(RecordingTestAccess::performanceSuspended(service.realtime()),
           "control waits for the outstanding performance reader before draining");
    RealtimeInstrumentation::reset();
    fake->pump(input, 1, output, 2, 480, 480);
    const auto violations = RealtimeInstrumentation::snapshot();
    const std::array counters{violations.allocations,    violations.deallocations,
                              violations.blockingCalls,  violations.diskIoCalls,
                              violations.networkIoCalls, violations.ipcCalls};
    expect(std::ranges::all_of(counters, [](auto count) { return count == 0; }),
           "the audible callback never allocates, waits or performs I/O during control drain");
    expect(std::ranges::any_of(output, [](float value) { return std::abs(value) > 0.1F; }),
           "audible playback continues while the recording-only branch is suspended");
    RecordingTestAccess::releasePerformanceReader(service.realtime());
    control.join();
    const auto result = service.recording().result();
    expect(
        stopped.status == ControlStatus::Ok && result.durationFrames == 480 &&
            result.stopSessionFrame == SessionFrame{480} &&
            service.realtime().sessionFrame() == SessionFrame{960},
        "the file cutoff uses the last aligned block, independently of advancing audible output");
}

void performanceRecordingDrainsBeforeDeviceGenerationChanges() {
    using Transition = void (*)(AudioService&, FakeAudioBackend&);
    const std::array<Transition, 4> transitions{
        [](AudioService& service, FakeAudioBackend& fake) {
            fake.inject(BackendEventType::DeviceLost, -17);
            expect(service.handleLine("1|GetDiagnostics").status == ControlStatus::Ok,
                   "device loss is handled through the normal command dispatcher");
        },
        [](AudioService& service, FakeAudioBackend&) {
            RequestedConfiguration requested;
            requested.sampleRateHz = 44100;
            service.session().reconfigure(requested);
        },
        [](AudioService& service, FakeAudioBackend&) { service.session().stop(); },
        [](AudioService& service, FakeAudioBackend&) { service.session().suspend(); },
    };
    for (const auto transition : transitions) {
        auto backend = std::make_unique<FakeAudioBackend>();
        auto* fake = backend.get();
        AudioService service{std::move(backend)};
        service.start();
        service.session().prepare(RequestedConfiguration{});
        service.session().start();
        service.realtime().setMicrophoneEnabled(false);
        const auto source = tempRoot / "generation-tail-source.wav";
        const auto path = tempRoot / "generation-tail-take.wav";
        WavWriter writer;
        writer.open(source.string(), 48000, 2);
        writer.write(std::vector<float>(960U, 0.2F));
        writer.close();
        service.media().load(MediaSlot::Music, source.string());
        expect(service.media().waitUntilReady(MediaSlot::Music) == PlaybackState::Ready,
               "the device-loss source is ready");
        expect(service.handleLine("1|PrepareRecording|id=generation-tail|tap=performance|path=" +
                                  path.string())
                           .status == ControlStatus::Ok &&
                   service.handleLine("1|StartRecording").status == ControlStatus::Ok,
               "a short performance starts before the device generation changes");
        service.media().play(MediaContext::Karaoke);
        std::vector<float> input(480, 0.0F), expected(960);
        fake->pump(input, 1, expected, 2, 0, 0);
        const auto generation = service.session().generationId();
        transition(service, *fake);
        expect(service.session().generationId() > generation,
               "the transition invalidates the old device generation");
        expect(service.handleLine("1|StopRecording").status == ControlStatus::Ok,
               "the retained take remains available after the transition");
        const auto result = service.recording().result();
        WavDecoder decoder;
        const auto format = decoder.open(path.string());
        std::vector<float> actual(expected.size());
        const auto read = decoder.read(actual, 480);
        expect(result.finalized && result.durationFrames == 480 &&
                   result.stopSessionFrame == SessionFrame{480} && result.sampleRateHz == 48000 &&
                   format.sampleRateHz == 48000 && format.totalFrames == 480 && read == 480,
               "device transitions retain the exact old-format duration and logical cutoff");
        expect(std::ranges::any_of(expected, [](float value) { return std::abs(value) > 0.1F; }) &&
                   std::ranges::equal(actual, expected,
                                      [](float a, float b) { return std::abs(a - b) < 0.0001F; }),
               "device recovery never clears the pending audible performance before saving it");
    }
}

void performanceDrainFailureNeverClaimsFinalization() {
    for (const auto writerFailure : {false, true}) {
        for (const auto generationChange : {false, true}) {
            auto backend = std::make_unique<FakeAudioBackend>();
            auto* fake = backend.get();
            AudioService service{std::move(backend)};
            service.start();
            service.session().prepare(RequestedConfiguration{});
            service.session().start();
            const auto path = tempRoot / "tail-allocation-failure.wav";
            expect(service.handleLine("1|PrepareRecording|id=failed-tail|tap=performance|path=" +
                                      path.string())
                               .status == ControlStatus::Ok &&
                       service.handleLine("1|StartRecording").status == ControlStatus::Ok,
                   "the take starts before the control scratch allocation fails");
            std::vector<float> input(480, 0.0F), output(960);
            fake->pump(input, 1, output, 2, 0, 0);
            if (writerFailure) {
                RecordingTestAccess::failOutput(service.recording());
            } else {
                // Large vector allocations may include allocator alignment overhead.
                failNextAllocationOfSize(12000U * 2U * sizeof(float), true);
            }
            if (generationChange)
                service.session().stop();
            else
                expect(service.handleLine("1|StopRecording").status == ControlStatus::Failed,
                       "an unsuccessful tail drain reports a failed stop");
            failNextAllocationOfSize(0);
            const auto result = service.recording().result();
            expect(service.recording().state() == RecordingState::Failed && !result.finalized &&
                       !result.errorMessage.empty() &&
                       !RecordingTestAccess::fileOpen(service.recording()),
                   "drain failure releases the partial WAV and cannot become a finalized success");
        }
    }
}

void wavWriterReportsFinalizationAndRiffFailures() {
    WavWriter writer;
    writer.open((tempRoot / "header-failure.wav").string(), 48000, 1);
    RecordingTestAccess::failOutput(writer);
    bool rejected = false;
    try {
        writer.close();
    } catch (const std::runtime_error&) {
        rejected = true;
    }
    expect(rejected, "a failed header rewrite or flush cannot be reported as a finalized WAV");
    writer.abandon();
    writer.open((tempRoot / "riff-limit.wav").string(), 48000, 1);
    RecordingTestAccess::nearRiffLimit(writer);
    rejected = false;
    try {
        writer.write(std::array<float, 2>{0.1F, 0.2F});
    } catch (const std::length_error&) {
        rejected = true;
    }
    expect(rejected, "RIFF length includes its 36-byte header overhead and must not wrap");
    writer.abandon();
}

void recordingWavPathsPreserveUtf8Names() {
    const auto directory =
        tempRoot / std::filesystem::path{u8"\u0417\u0430\u043f\u0438\u0441\u0438_\u97f3\u58f0"};
    std::filesystem::create_directory(directory);
    const auto path = directory / std::filesystem::path{u8"\u0414\u0443\u044d\u0442_\u00e9.wav"};
    const auto utf8 = path.u8string();
    const std::string encoded{utf8.begin(), utf8.end()};
    WavWriter writer;
    try {
        writer.open(encoded, 48000, 1);
        writer.write(std::array<float, 3>{0.125F, 0.25F, 0.5F});
        writer.close();
    } catch (const std::runtime_error&) {
        writer.abandon();
    }
    expect(std::filesystem::is_regular_file(path),
           "the recording is created under the exact UTF-8 directory and file name");
    // Seed independently of the path under test so writer failure cannot mask decoder failure.
    const auto seed = tempRoot / "utf8-seed.wav";
    writer.open(seed.string(), 48000, 1);
    writer.write(std::array<float, 3>{0.125F, 0.25F, 0.5F});
    writer.close();
    const auto readPath = directory / std::filesystem::path{u8"\u8aad\u307f.wav"};
    std::filesystem::rename(seed, readPath);
    WavDecoder decoder;
    bool decoded = false;
    try {
        const auto readUtf8 = readPath.u8string();
        const auto format = decoder.open(std::string{readUtf8.begin(), readUtf8.end()});
        std::array<float, 3> samples{};
        decoded = format.totalFrames == 3 && decoder.read(samples, 3) == 3 &&
                  std::abs(samples.back() - 0.5F) < 0.0001F;
    } catch (const std::runtime_error&) {
    }
    expect(decoded, "UTF-8 names open the completed WAV and preserve its PCM");
}

void stopRecordingReportsWriterFailure() {
    AudioService service{std::make_unique<FakeAudioBackend>()};
    service.start();
    auto& recording = service.recording();
    recording.prepare("failed", (tempRoot / "disk-failure.wav").string(), 48000, 1,
                      RecordingTap::RawInput, 4096);
    RecordingTestAccess::failOutput(recording);
    recording.start(SessionFrame{0}, 0);
    recording.push(GenerationId{0}, RecordingTap::RawInput, SessionFrame{0},
                   std::array<float, 1>{0.2F}, 1);
    const auto deadline = std::chrono::steady_clock::now() + std::chrono::seconds(2);
    while (recording.state() != RecordingState::Failed &&
           std::chrono::steady_clock::now() < deadline)
        std::this_thread::yield();
    expect(recording.state() == RecordingState::Failed,
           "the disk fault reaches the recording state");
    const auto reply = service.handleLine("1|StopRecording");
    expect(reply.status == ControlStatus::Failed && !reply.text.empty(),
           "IPC must report a failed writer instead of returning a successful recording path");
}

void wavWriterRejectsUnrepresentableFormatsAndPartialFrames() {
    for (const auto [rate, channels] : {std::pair{48000U, 65536U}, std::pair{48000U, 32768U},
                                        std::pair{std::numeric_limits<std::uint32_t>::max(), 2U}}) {
        WavWriter writer;
        bool rejected = false;
        try {
            writer.open((tempRoot / "invalid-format.wav").string(), rate, channels);
        } catch (const std::invalid_argument&) {
            rejected = true;
        }
        expect(rejected,
               "WAV fields must represent channel count, block alignment and byte rate exactly");
    }
    WavWriter writer;
    writer.open((tempRoot / "partial-frame.wav").string(), 48000, 2);
    bool rejected = false;
    try {
        writer.write(std::array<float, 3>{0.1F, 0.2F, 0.3F});
    } catch (const std::invalid_argument&) {
        rejected = true;
    }
    expect(rejected, "WAV cannot contain a partial interleaved frame");
    writer.close();
}

void wavWriterSanitizesNonFiniteSamples() {
    WavWriter writer;
    writer.open((tempRoot / "nonfinite.wav").string(), 48000, 1);
    std::feclearexcept(FE_ALL_EXCEPT);
    writer.write(std::array<float, 3>{std::numeric_limits<float>::quiet_NaN(),
                                      std::numeric_limits<float>::infinity(), 0.5F});
    expect((std::fetestexcept(FE_INVALID) & FE_INVALID) == 0,
           "non-finite PCM never reaches integer conversion");
    writer.close();
    WavDecoder decoder;
    decoder.open((tempRoot / "nonfinite.wav").string());
    std::array<float, 3> pcm{};
    decoder.read(pcm, 3);
    expect(pcm[0] == 0.0F && pcm[1] == 0.0F && pcm[2] > 0.49F,
           "invalid PCM becomes silence without damaging valid samples");
}

void recordingOverrunsPreserveTheAudioTimeline() {
    RecordingEngine recording;
    const auto path = tempRoot / "recording-overrun-timeline.wav";
    recording.prepare("overrun", path.string(), 48000, 1, RecordingTap::RawInput, 4);
    recording.start(SessionFrame{0}, 0);
    recording.push(GenerationId{0}, RecordingTap::RawInput, SessionFrame{0},
                   std::vector<float>(8, 0.3F), 8);
    recording.push(GenerationId{0}, RecordingTap::RawInput, SessionFrame{8},
                   std::vector<float>(4, 0.5F), 4);
    const auto result = recording.stop(SessionFrame{12});
    WavDecoder decoder;
    decoder.open(path.string());
    std::vector<float> samples(12, -1.0F);
    expect(decoder.read(samples, 12) == 12 && result.durationFrames == 12,
           "dropped PCM is silence on the original timeline, not time compression");
    expect(std::ranges::all_of(std::span{samples}.first(8),
                               [](float sample) { return sample == 0.0F; }),
           "overflow silence precedes the next accepted audio block");
    expect(samples[8] > 0.49F && result.overrunCount == 1,
           "accepted PCM and overrun diagnostics remain intact");
}

void recordingStopDrainsAnInFlightProducer() {
    for (int attempt = 0; attempt < 4; ++attempt) {
        RecordingEngine recording;
        const auto path = tempRoot / "recording-stop-race.wav";
        constexpr std::uint32_t frames = 1U << 22;
        recording.prepare("race", path.string(), 48000, 1, RecordingTap::RawInput, frames);
        recording.start(SessionFrame{0}, 0);
        const std::vector<float> block(frames, 0.2F);
        std::atomic<bool> started{false};
        std::thread producer([&] {
            started.store(true);
            recording.push(GenerationId{0}, RecordingTap::RawInput, SessionFrame{0}, block, frames);
        });
        while (!started.load())
            std::this_thread::yield();
        const auto readyAt = std::chrono::steady_clock::now() + std::chrono::microseconds(100);
        while (std::chrono::steady_clock::now() < readyAt)
            std::this_thread::yield();
        const auto result = recording.stop(SessionFrame{frames});
        producer.join();
        expect(recording.queueFillFrames() == 0,
               "finalization cannot leave a late accepted block in the queue");
        WavDecoder decoder;
        decoder.open(path.string());
        std::vector<float> scratch(2048);
        std::uint64_t actualFrames = 0;
        while (const auto read = decoder.read(scratch, 2048))
            actualFrames += read;
        expect(actualFrames == result.durationFrames,
               "finalized duration matches all PCM actually written");
    }
}

void recordingGenerationChangeFinalizesTheExistingFormat() {
    RecordingEngine recording;
    const auto path = tempRoot / "recording-generation-change.wav";
    recording.setGeneration(GenerationId{1});
    recording.prepare("generation", path.string(), 44100, 1, RecordingTap::RawInput, 4096);
    recording.start(SessionFrame{0}, 0);
    recording.push(GenerationId{1}, RecordingTap::RawInput, SessionFrame{0},
                   std::vector<float>(100, 0.2F), 100);
    recording.setGeneration(GenerationId{2});
    recording.push(GenerationId{2}, RecordingTap::RawInput, SessionFrame{0},
                   std::vector<float>(200, 0.4F), 200);
    const auto result = recording.stop(SessionFrame{200});
    expect(result.stopSessionFrame == SessionFrame{100},
           "a new device timeline cannot overwrite the old recording's end frame");
    expect(result.finalized && result.durationFrames == 100,
           "device changes finalize the old recording without mixing formats");
    WavDecoder decoder;
    decoder.open(path.string());
    std::vector<float> samples(300);
    expect(decoder.read(samples, 300) == 100,
           "accepted old-generation PCM is drained instead of cleared");
}

void recordingShutdownFinalizesAcceptedPcm() {
    const auto path = tempRoot / "recording-shutdown.wav";
    {
        RecordingEngine recording;
        recording.prepare("shutdown", path.string(), 48000, 1, RecordingTap::RawInput, 4096);
        recording.start(SessionFrame{0}, 0);
        recording.push(GenerationId{0}, RecordingTap::RawInput, SessionFrame{0},
                       std::vector<float>(128, 0.2F), 128);
    }
    WavDecoder decoder;
    decoder.open(path.string());
    std::vector<float> samples(128);
    expect(decoder.read(samples, 128) == 128,
           "shutdown drains audio and publishes a valid WAV header");
}

void rawRecordingUsesTheNegotiatedInternalTimeline() {
    for (const auto inputRate : {24000U, 44100U, 96000U}) {
        FakeBackendSettings settings;
        settings.runtime.inputSampleRateHz = inputRate;
        settings.runtime.outputSampleRateHz = 48000;
        settings.runtime.inputPeriodFrames = inputRate / 100U;
        settings.runtime.outputPeriodFrames = 480;
        settings.runtime.clockRelationship = ClockRelationship::Independent;
        auto backend = std::make_unique<FakeAudioBackend>(settings);
        auto* fake = backend.get();
        AudioService service{std::move(backend)};
        service.start();
        service.session().prepare(RequestedConfiguration{});
        service.session().start();
        const auto path = tempRoot / ("raw-rate-" + std::to_string(inputRate) + ".wav");
        expect(service.handleLine("1|PrepareRecording|id=raw|path=" + path.string() + "|tap=raw")
                       .status == ControlStatus::Ok,
               "raw tap is prepared using negotiated configuration");
        service.recording().start(SessionFrame{0}, 0);
        std::vector<float> capture(inputRate / 100U, 0.2F), render(960, 0.0F);
        for (std::int64_t block = 0; block < 100; ++block)
            fake->pump(capture, 1, render, 2, block * (inputRate / 100U), block * 480);
        const auto result = service.recording().stop(service.realtime().sessionFrame());
        expect(result.sampleRateHz == 48000 && result.durationFrames == 48000,
               "one second of raw input is recorded on the internal clock after conversion");
        expect(std::abs(result.durationSeconds - 1.0) < 0.00001,
               "raw recording duration does not depend on the input device sample rate");
    }
}

namespace {
RecordingResult runRecordingScenario(const std::filesystem::path& path) {
    RecordingEngine recording;
    recording.setGeneration(GenerationId{1});
    recording.prepare("r1", path.string(), 48000, 1, RecordingTap::RawInput, 96000);
    recording.start(SessionFrame{0}, 0);
    const std::vector<float> block(480, 0.1F);
    SessionFrame frame{0};
    for (int index = 0; index < 50; ++index) {
        recording.push(GenerationId{1}, RecordingTap::RawInput, frame, block, 480);
        frame += 480;
    }
    recording.pause(frame);
    frame += 4800;
    recording.resume(frame);
    for (int index = 0; index < 50; ++index) {
        recording.push(GenerationId{1}, RecordingTap::RawInput, frame, block, 480);
        frame += 480;
    }
    return recording.stop(frame);
}
} // namespace

void recordingDurationCountsAcceptedPcm() {
    const auto result = runRecordingScenario(tempRoot / "recording-duration.wav");
    expect(result.durationFrames == 48000, "recording duration counts accepted PCM exactly");
}

void recordingPauseCreatesGapMetadata() {
    const auto result = runRecordingScenario(tempRoot / "recording-gap.wav");
    expect(!result.gaps.empty() && result.gaps.front().frameCount == 4800,
           "recording pause stored as metadata gap");
}

void recordingWritesWav() {
    const auto path = tempRoot / "recording-file.wav";
    const auto result = runRecordingScenario(path);
    expect(result.finalized && std::filesystem::file_size(path) > 44,
           "recording finalizes and writes WAV data");
}

void recordingRejectsStaleGeneration() {
    RecordingEngine recording;
    const auto path = tempRoot / "recording-stale.wav";
    recording.setGeneration(GenerationId{2});
    recording.prepare("r2", path.string(), 48000, 1, RecordingTap::RawInput, 4096);
    recording.start(SessionFrame{0}, 0);
    const std::vector<float> block(128, 0.1F);
    recording.push(GenerationId{1}, RecordingTap::RawInput, SessionFrame{0}, block, 128);
    const auto result = recording.stop(SessionFrame{128});
    expect(result.staleBlocks == 1 && result.durationFrames == 0,
           "recording rejects stale generation PCM");
}

void prepareRecordingSelectsMasterMixTap() {
    auto backend = std::make_unique<FakeAudioBackend>();
    AudioService service{std::move(backend)};
    service.start();
    service.session().prepare(RequestedConfiguration{});
    const auto path = tempRoot / "recording-master-mix.wav";

    const auto response =
        service.handleLine("1|PrepareRecording|id=mix|path=" + path.string() + "|tap=performance");

    expect(response.status == ControlStatus::Ok, "performance mix recording can be prepared");
    expect(service.recording().result().selectedTap == RecordingTap::PerformanceMix,
           "PrepareRecording maps performance tap to the song and configured voice mix");
}

void performanceMixRecordsVoiceWithoutMonitoring() {
    auto backend = std::make_unique<FakeAudioBackend>();
    auto* fake = backend.get();
    AudioService service{std::move(backend)};
    service.start();
    service.session().prepare(RequestedConfiguration{});
    service.session().start();
    service.realtime().setMonitoring(false);
    const auto path = tempRoot / "recording-performance-mix.wav";
    service.recording().prepare("performance", path.string(), 48000, 2,
                                RecordingTap::PerformanceMix, 48000);
    service.recording().start(SessionFrame{0}, 0);
    // The aligned performance trails the music by its lead (250 ms), so pump past it.
    constexpr std::int64_t blocks = 200;
    std::vector<float> capture(128, 0.25F), render(256, 0.0F);
    for (std::int64_t block = 0; block < blocks; ++block)
        fake->pump(capture, 1, render, 2, block * 128, block * 128);
    service.recording().stop(service.realtime().sessionFrame());

    WavDecoder decoder;
    decoder.open(path.string());
    std::vector<float> recorded(static_cast<std::size_t>(blocks) * 128U * 2U);
    const auto frames = decoder.read(recorded, static_cast<std::uint32_t>(blocks) * 128U);
    const auto loudest = *std::max_element(recorded.begin(), recorded.begin() + frames * 2U);
    expect(loudest > 0.01F,
           "performance mix contains configured microphone when monitoring is off");
    expect(std::ranges::all_of(render, [](float sample) { return sample == 0.0F; }),
           "recording the voice does not force microphone monitoring into the speakers");
}

void performanceVoiceHeadroomPreservesTheRecordedBalance() {
    const auto musicPath = tempRoot / "headroom-backing.wav";
    std::vector<float> music(48'000U * 2U, 0.0F);
    for (std::size_t index = 1; index < music.size(); index += 2)
        music[index] = 0.1F;
    WavWriter backing;
    backing.open(musicPath.string(), 48'000, 2);
    backing.write(music);
    backing.close();
    auto backend = std::make_unique<FakeAudioBackend>();
    auto* fake = backend.get();
    AudioService service{std::move(backend)};
    service.start();
    service.session().prepare(RequestedConfiguration{});
    service.session().start();
    service.realtime().setMonitoring(false);
    service.media().load(MediaSlot::Music, musicPath.string());
    expect(service.media().waitUntilReady(MediaSlot::Music) == PlaybackState::Ready,
           "headroom reference backing is loaded");
    service.media().play(MediaContext::Karaoke);
    const auto path = tempRoot / "voice-headroom.wav";
    expect(service.handleLine("1|PrepareRecording|id=headroom|tap=performance|path=" + path.string()).status == ControlStatus::Ok &&
               service.handleLine("1|StartRecording").status == ControlStatus::Ok,
           "a normal performance recording starts");
    constexpr std::uint32_t blocks = 200;
    std::vector<float> capture(128, 0.4F), render(256, 0.0F);
    for (std::uint32_t block = 0; block < blocks; ++block)
        fake->pump(capture, 1, render, 2, block * 128, block * 128);
    expect(service.handleLine("1|StopRecording").status == ControlStatus::Ok,
           "headroom is finalized through the normal stop command");
    WavDecoder decoder;
    const auto format = decoder.open(path.string());
    std::vector<float> recorded(static_cast<std::size_t>(format.totalFrames) * 2U);
    decoder.read(recorded, static_cast<std::uint32_t>(format.totalFrames));
    float voicePeak = 0.0F;
    for (std::size_t index = 0; index < recorded.size(); index += 2)
        voicePeak = std::max(voicePeak, std::abs(recorded[index]));
    constexpr float target = 0.12589254F;
    expect(std::abs(voicePeak - target) < 0.0001F,
           "the recorded voice peaks at minus 18 dBFS without changing monitoring or mixer knobs");
    // The left channel carries only the centred voice; subtracting it from the right isolates music.
    const auto last = recorded.size() - 2U;
    const auto recordedBacking = recorded[last + 1U] - recorded[last];
    expect(std::abs(recordedBacking - render.back() * target / 0.4F) < 0.001F,
           "one constant gain preserves the original voice/backing balance and stereo image");
    expect(render.back() > recordedBacking * 2.0F && format.totalFrames == blocks * 128U,
           "saving headroom leaves live playback and the complete aligned duration unchanged");
}

void performanceMixUsesTheServerDeadlineToAlignRemoteVoices() {
    NetworkAudioEngine network;
    network.prepare(48'000, 1, 24'000, 120, GenerationId{1});
    network.setRoomPlayoutDelay(160.0F);
    network.setSharedTimeline(true);

    expect(network.remoteRecordingDelayFrames() == 7'680,
           "the saved performance moves the delayed server mix back to its musical position");
    network.setSharedTimeline(false);
    expect(network.remoteRecordingDelayFrames() == 0,
           "ordinary non-room recordings keep remote audio at its rendered position");
}

void diagnosticRoomPilotTraversesTheCaptureBridge() {
    auto backend = std::make_unique<FakeAudioBackend>();
    auto* fake = backend.get();
    AudioService service{std::move(backend)};
    service.start();
    service.session().prepare(RequestedConfiguration{});
    service.session().start();
    service.realtime().setDiagnosticRoomInput(true, 697.0F, 0.1F);
    const auto path = tempRoot / "capture-path-pilot.wav";
    service.recording().prepare("capture-pilot", path.string(), 48'000, 2,
                                RecordingTap::RawInput, 48'000);
    service.recording().start(SessionFrame{0}, 0);
    std::vector<float> silence(128, 0.0F), output(256, 0.0F);
    for (std::int64_t block = 0; block < 200; ++block)
        fake->pump(silence, 1, output, 2, block * 128, block * 128);
    service.recording().stop(service.realtime().sessionFrame());
    WavDecoder decoder;
    decoder.open(path.string());
    std::vector<float> recorded(200U * 128U * 2U);
    const auto frames = decoder.read(recorded, 200U * 128U);
    const auto peak = *std::max_element(recorded.begin(),
                                        recorded.begin() + static_cast<std::ptrdiff_t>(frames * 2U));
    expect(peak > 0.05F && service.realtime().snapshot().inputChannelRms[0] > 0.05F,
           "the diagnostic pilot enters capture metering before RawInput and the clock bridge");
}

void diagnosticVocalMarkersFollowMusicalFrames() {
    constexpr std::uint64_t start = 85'000'000'000ULL;
    for (const auto rate : {44'100U, 48'000U}) {
        const auto period = rate / 2U;
        float first = 0.0F, second = 0.0F;
        for (std::uint32_t frame = 0; frame < rate / 50U; ++frame) {
            first = std::max(first, std::abs(diagnosticVocalPilotSample(
                                         start + frame, start, rate, 697.0F, 0.1F)));
            second = std::max(second, std::abs(diagnosticVocalPilotSample(
                                           start + period + frame, start, rate, 697.0F, 0.1F)));
        }
        expect(first > 0.05F && second > 0.05F,
               "distinct vocal markers recur on the same half-second musical positions");
        expect(diagnosticVocalPilotSample(start - 1U, start, rate, 697.0F, 0.1F) == 0.0F &&
                   diagnosticVocalPilotSample(start + period / 2U, start, rate, 697.0F,
                                              0.1F) == 0.0F,
               "no marker leaks into the previous beat or the inter-beat silence");
    }
}

void denseDiagnosticVocalMarkersBoundDropoutDuration() {
    constexpr std::uint64_t start = 85'000'000'000ULL;
    for (const auto rate : {44'100U, 48'000U}) {
        const auto period = rate / 20U;
        float first = 0.0F, second = 0.0F;
        for (std::uint32_t frame = 0; frame < rate / 100U; ++frame) {
            first = std::max(first, std::abs(diagnosticVocalPilotSample(
                start + frame, start, rate, 697.0F, 0.1F, 50U)));
            second = std::max(second, std::abs(diagnosticVocalPilotSample(
                start + period + frame, start, rate, 697.0F, 0.1F, 50U)));
        }
        expect(first > 0.05F && second > 0.05F,
               "dense markers recur every 50 ms of the authoritative musical timeline");
        expect(diagnosticVocalPilotSample(start + period / 2U, start, rate, 697.0F,
                                          0.1F, 50U) == 0.0F,
               "dense marker has an off interval so an output gap remains measurable");
    }
}

void performanceMixContainsConfiguredAutoTune() {
    auto backend = std::make_unique<FakeAudioBackend>();
    auto* fake = backend.get();
    AudioService service{std::move(backend)};
    service.start();
    service.session().prepare(RequestedConfiguration{});
    service.session().start();
    service.realtime().setDspEnabled(true);
    expect(service.realtime().setDspParameter("autotune.amount", 1.0F),
           "performance recording accepts full hard-tune");
    const auto musicPath = tempRoot / "recording-autotune-silent-music.wav";
    WavWriter silentMusic;
    silentMusic.open(musicPath.string(), 48000, 2);
    silentMusic.write(std::vector<float>(48000 * 4U * 2U, 0.0F));
    silentMusic.close();
    service.media().load(MediaSlot::Music, musicPath.string());
    expect(service.media().waitUntilReady(MediaSlot::Music) == PlaybackState::Ready,
           "silent backing is ready for the karaoke performance recording");
    service.media().play(MediaContext::Karaoke);
    const auto path = tempRoot / "recording-performance-autotune.wav";
    service.recording().prepare("performance-autotune", path.string(), 48000, 2,
                                RecordingTap::PerformanceMix, 48000 * 3U);
    service.recording().start(SessionFrame{0}, 0);
    constexpr std::uint32_t rate = 48'000, frames = 128;
    constexpr double inputFrequency = 448.0;
    constexpr double twoPi = 6.28318530717958647692;
    std::vector<float> capture(frames), render(frames * 2U);
    double phase = 0.0;
    for (std::uint32_t block = 0; block < rate * 3U / frames; ++block) {
        for (auto& sample : capture) {
            sample = 0.3F * static_cast<float>(std::sin(phase));
            phase += twoPi * inputFrequency / rate;
        }
        fake->pump(capture, 1, render, 2, block * frames, block * frames);
    }
    service.recording().stop(service.realtime().sessionFrame());

    WavDecoder decoder;
    decoder.open(path.string());
    std::vector<float> recorded(rate * 3U * 2U);
    const auto recordedFrames = decoder.read(recorded, rate * 3U);
    const auto first = (recordedFrames - rate) * 2U;
    std::uint32_t crossings = 0;
    for (std::size_t index = first + 2U; index < recordedFrames * 2U; index += 2U)
        if (recorded[index - 2U] <= 0.0F && recorded[index] > 0.0F)
            ++crossings;
    expect(crossings >= 380 && crossings <= 430,
           "performance mix records the exaggerated auto-tune instead of a dry microphone");
}

namespace {
struct FollowRun {
    std::int64_t firstSoundFrame{-1};
    std::uint32_t followFrames{0};
    std::uint64_t reportedFrame{0};
    std::uint64_t reportedAtStartFrame{0}; // just after the room start, before a follower sounds
};

// Plays a scheduled room song and reports when it became audible and where it claims to be.
// `delayAtBlock` changes the server delay mid-song to verify that an active timeline is locked.
FollowRun runRoomSong(bool delayed, std::int64_t delayAtBlock = -1) {
    constexpr std::uint32_t block = 128, rate = 48'000, startBlock = 20, blocks = 120;
    const auto musicPath = tempRoot / "room-follow-music.wav";
    makeTestWav(musicPath, rate);
    auto backend = std::make_unique<FakeAudioBackend>();
    auto* fake = backend.get();
    AudioService service{std::move(backend)};
    service.start();
    service.session().prepare(RequestedConfiguration{});
    service.session().start();
    service.network().setSharedTimeline(true);
    service.network().setRoomPlayoutDelay(delayed && delayAtBlock < 0 ? 160.0F : 0.0F);
    service.media().load(MediaSlot::Music, musicPath.string());
    (void)service.media().waitUntilReady(MediaSlot::Music);
    // The whole run must come from decoded PCM: a busy machine must not turn into an underrun.
    const auto filledBy = std::chrono::steady_clock::now() + std::chrono::seconds(3);
    while (service.media().snapshot(MediaSlot::Music).bufferFillFrames < blocks * block &&
           std::chrono::steady_clock::now() < filledBy)
        std::this_thread::yield();
    const auto base = monotonicTicksNow() + 1'000'000'000;
    const auto ticksAt = [&](std::int64_t frame) { return base + frame * 1'000'000'000LL / rate; };
    service.media().play(MediaContext::Karaoke, ticksAt(startBlock * block));
    FollowRun run;
    std::vector<float> capture(block, 0.0F), render(block * 2U, 0.0F);
    for (std::int64_t index = 0; index < blocks; ++index) {
        const auto frame = index * block;
        std::ranges::fill(render, 0.0F);
        if (delayed && index == delayAtBlock)
            service.network().setRoomPlayoutDelay(160.0F);
        fake->pump(capture, 1, render, 2, frame, frame, ticksAt(frame));
        if (index == startBlock + 1)
            run.reportedAtStartFrame = service.roomPlaybackFrame(ticksAt(frame + block));
        const auto sound =
            std::ranges::find_if(render, [](float s) { return std::abs(s) > 1e-4F; });
        if (run.firstSoundFrame < 0 && sound != render.end())
            run.firstSoundFrame = frame + (sound - render.begin()) / 2;
    }
    run.followFrames = service.realtime().roomFollowFrames();
    run.reportedFrame = service.roomPlaybackFrame(ticksAt(blocks * block - block));
    service.media().stop(MediaContext::Karaoke);
    return run;
}
} // namespace

void roomFollowNeverStartsWhileTheSongIsSounding() {
    const auto undelayed = runRoomSong(false);
    const auto changedMidSong = runRoomSong(true, 60);
    expect(changedMidSong.followFrames == 0 &&
               changedMidSong.reportedFrame == undelayed.reportedFrame,
           "the server room deadline is locked while a song is sounding");
}

void serverMixDeadlineNeverDelaysTheLocalBackingTrack() {
    const auto ordinary = runRoomSong(false);
    const auto serverMix = runRoomSong(true);
    expect(serverMix.followFrames == 0,
           "the remote server-mix deadline is not a delay on this singer's backing track");
    expect(std::llabs(serverMix.firstSoundFrame - ordinary.firstSoundFrame) <= 2,
           "every singer hears the scheduled backing immediately instead of a delayed duplicate");
    expect(std::llabs(static_cast<std::int64_t>(serverMix.reportedFrame) -
                      static_cast<std::int64_t>(ordinary.reportedFrame)) <= 2,
           "the server-mix deadline never changes the authoritative local media position");
}

void captureStampsCannotClaimAudioRecordedAfterItsDelivery() {
    // The fake backend stamps a packet at its delivery, as some drivers stamp a packet's end:
    // its first frame is then placed one packet length earlier, where it was physically recorded.
    auto backend = std::make_unique<FakeAudioBackend>();
    auto* fake = backend.get();
    AudioService service{std::move(backend)};
    service.start();
    service.session().prepare(RequestedConfiguration{});
    service.session().start();
    constexpr std::uint32_t block = 480;
    std::vector<float> capture(block, 0.0F), render(block * 2U, 0.0F);
    fake->pump(capture, 1, render, 2, 0, 0);
    const auto packetNs = static_cast<MonotonicTicks>(block) * 1'000'000'000LL / 48'000;
    const auto correction = service.realtime().captureStampCorrectionNs();
    expect(correction > packetNs - 5'000'000 && correction <= packetNs,
           "a stamp at the packet's end is moved back to the packet's start");
    expect(service.realtime().captureAgeNs() >= 0,
           "no captured audio is younger than its delivery");
}

void performanceMixFollowsMusicGain() {
    const auto musicPath = tempRoot / "performance-canonical-music.wav";
    makeTestWav(musicPath, 48000);
    auto backend = std::make_unique<FakeAudioBackend>();
    auto* fake = backend.get();
    AudioService service{std::move(backend)};
    service.start();
    service.session().prepare(RequestedConfiguration{});
    service.session().start();
    service.network().setSharedTimeline(true);
    service.media().load(MediaSlot::Music, musicPath.string());
    expect(service.media().waitUntilReady(MediaSlot::Music) == PlaybackState::Ready,
           "backing track is ready for canonical room recording");
    service.realtime().setMixerGains(MixerGains{.microphone = 0.0F, .music = 0.0F});
    service.media().play(MediaContext::Karaoke);
    const auto path = tempRoot / "performance-canonical-mix.wav";
    service.recording().prepare("canonical", path.string(), 48000, 2, RecordingTap::PerformanceMix,
                                48000);
    service.recording().start(SessionFrame{0}, 0);
    std::vector<float> capture(128, 0.0F), render(256, 0.0F);
    for (std::int64_t block = 0; block < 100; ++block)
        fake->pump(capture, 1, render, 2, block * 128, block * 128);
    service.recording().stop(service.realtime().sessionFrame());
    WavDecoder decoder;
    decoder.open(path.string());
    std::vector<float> recorded(32768);
    const auto frames = decoder.read(recorded, 16384);
    const auto peak = *std::max_element(recorded.begin(), recorded.begin() + frames * 2U);
    const auto delayedPrefixPeak =
        *std::max_element(recorded.begin(), recorded.begin() + 480U * 2U);
    expect(peak < 0.001F, "performance mix mutes the backing track when the music knob is muted");
    expect(delayedPrefixPeak < 0.001F,
           "room backing track is delayed by the already-warmed shared voice target");
}

void performanceMixExcludesReferenceVocal() {
    const auto musicPath = tempRoot / "silent-music.wav";
    const auto vocalPath = tempRoot / "reference-vocal.wav";
    WavWriter silent;
    silent.open(musicPath.string(), 48000, 2);
    silent.write(std::vector<float>(48000 * 2, 0.0F));
    silent.close();
    makeTestWav(vocalPath, 48000);

    auto backend = std::make_unique<FakeAudioBackend>();
    auto* fake = backend.get();
    AudioService service{std::move(backend)};
    service.start();
    service.session().prepare(RequestedConfiguration{});
    service.session().start();
    service.media().load(MediaSlot::Music, musicPath.string());
    service.media().load(MediaSlot::ReferenceVocal, vocalPath.string());
    expect(service.media().waitUntilReady(MediaSlot::Music) == PlaybackState::Ready &&
               service.media().waitUntilReady(MediaSlot::ReferenceVocal) == PlaybackState::Ready,
           "karaoke tracks are ready for the performance recording test");
    service.realtime().setMixerGains(
        MixerGains{.microphone = 0.0F, .music = 1.0F, .reference = 1.0F});
    service.media().play(MediaContext::Karaoke);

    const auto path = tempRoot / "performance-without-reference.wav";
    service.recording().prepare("without-reference", path.string(), 48000, 2,
                                RecordingTap::PerformanceMix, 48000);
    service.recording().start(SessionFrame{0}, 0);
    std::vector<float> capture(128, 0.0F), render(256, 0.0F);
    float speakerPeak = 0.0F;
    for (std::int64_t block = 0; block < 100; ++block) {
        fake->pump(capture, 1, render, 2, block * 128, block * 128);
        for (const auto sample : render)
            speakerPeak = std::max(speakerPeak, std::abs(sample));
    }
    service.recording().stop(service.realtime().sessionFrame());

    WavDecoder decoder;
    decoder.open(path.string());
    std::vector<float> recorded(32768);
    const auto frames = decoder.read(recorded, 16384);
    float recordingPeak = 0.0F;
    for (std::size_t index = 0; index < frames * 2U; ++index)
        recordingPeak = std::max(recordingPeak, std::abs(recorded[index]));
    expect(speakerPeak > 0.05F, "reference vocal remains audible in karaoke speakers");
    expect(recordingPeak < 0.001F, "reference vocal is excluded from the performance mix");
}

void roomMediaRendersWithoutDelayOrStretching() {
    const auto musicPath = tempRoot / "silent-room-guide-music.wav";
    const auto vocalPath = tempRoot / "delayed-room-guide-vocal.wav";
    WavWriter silent;
    silent.open(musicPath.string(), 48000, 2);
    silent.write(std::vector<float>(48000 * 2, 0.0F));
    silent.close();
    makeTestWav(vocalPath, 48000);

    auto backend = std::make_unique<FakeAudioBackend>();
    auto* fake = backend.get();
    AudioService service{std::move(backend)};
    service.start();
    service.session().prepare(RequestedConfiguration{});
    service.session().start();
    service.network().setSharedTimeline(true);
    service.media().load(MediaSlot::Music, musicPath.string());
    service.media().load(MediaSlot::ReferenceVocal, vocalPath.string());
    expect(service.media().waitUntilReady(MediaSlot::Music) == PlaybackState::Ready &&
               service.media().waitUntilReady(MediaSlot::ReferenceVocal) == PlaybackState::Ready,
           "room guide tracks are ready for shared-delay verification");
    service.realtime().setMixerGains(
        MixerGains{.microphone = 0.0F, .music = 0.0F, .reference = 1.0F});
    service.media().play(MediaContext::Karaoke);

    std::vector<float> capture(128, 0.0F), render(256, 0.0F);
    float prefixPeak = 0.0F;
    float laterPeak = 0.0F;
    for (std::int64_t block = 0; block < 12; ++block) {
        fake->pump(capture, 1, render, 2, block * 128, block * 128);
        const auto peak = std::ranges::max(render);
        if (block < 3)
            prefixPeak = std::max(prefixPeak, peak);
        else
            laterPeak = std::max(laterPeak, peak);
    }
    expect(prefixPeak > 0.01F && laterPeak > 0.01F,
           "room audio begins unmodified; compensation is applied only to the scheduled start");
}

void performanceMixExcludesMelody() {
    const auto musicPath = tempRoot / "silent-music-melody.wav";
    const auto melodyPath = tempRoot / "melody-reference.wav";
    WavWriter silent;
    silent.open(musicPath.string(), 48000, 2);
    silent.write(std::vector<float>(48000 * 2, 0.0F));
    silent.close();
    makeTestWav(melodyPath, 48000);

    auto backend = std::make_unique<FakeAudioBackend>();
    auto* fake = backend.get();
    AudioService service{std::move(backend)};
    service.start();
    service.session().prepare(RequestedConfiguration{});
    service.session().start();
    service.media().load(MediaSlot::Music, musicPath.string());
    service.media().load(MediaSlot::Melody, melodyPath.string());
    expect(service.media().waitUntilReady(MediaSlot::Music) == PlaybackState::Ready &&
               service.media().waitUntilReady(MediaSlot::Melody) == PlaybackState::Ready,
           "karaoke tracks are ready for the melody performance recording test");
    service.realtime().setMixerGains(MixerGains{.microphone = 0.0F, .music = 1.0F, .melody = 1.0F});
    service.media().play(MediaContext::Karaoke);

    const auto path = tempRoot / "performance-without-melody.wav";
    service.recording().prepare("without-melody", path.string(), 48000, 2,
                                RecordingTap::PerformanceMix, 48000);
    service.recording().start(SessionFrame{0}, 0);
    std::vector<float> capture(128, 0.0F), render(256, 0.0F);
    float speakerPeak = 0.0F;
    for (std::int64_t block = 0; block < 100; ++block) {
        fake->pump(capture, 1, render, 2, block * 128, block * 128);
        for (const auto sample : render)
            speakerPeak = std::max(speakerPeak, std::abs(sample));
    }
    service.recording().stop(service.realtime().sessionFrame());

    WavDecoder decoder;
    decoder.open(path.string());
    std::vector<float> recorded(32768);
    const auto frames = decoder.read(recorded, 16384);
    float recordingPeak = 0.0F;
    for (std::size_t index = 0; index < frames * 2U; ++index)
        recordingPeak = std::max(recordingPeak, std::abs(recorded[index]));
    expect(speakerPeak > 0.05F, "melody reference remains audible in karaoke speakers");
    expect(recordingPeak < 0.001F, "melody reference is excluded from the performance mix");
}
} // namespace Tests
