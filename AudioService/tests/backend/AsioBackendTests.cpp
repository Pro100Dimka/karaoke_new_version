#include "TestHarness.hpp"
#ifdef _WIN32
#include "backend/asio/AsioAbi.hpp"
#include "backend/asio/AsioBackend.hpp"
#include "backend/asio/AsioComApartment.hpp"
#include "realtime/RealtimeInstrumentation.hpp"
#include <array>
#include <atomic>
#include <future>
#include <latch>
#include <limits>
#include <ranges>
#include <thread>

namespace Tests {
namespace {
struct Driver final : IAsioDriver {
    long minimum{8}, maximum{104}, preferred{56}, granularity{16};
    double rate{44100};
    bool failChannels{false}, failStart{false}, started{false};
    bool rateDependentPeriod{false}, failLatency{false};
    long latency{0};
    int releases{0}, starts{0}, stops{0}, disposals{0};
    long selectedFrames{0};
    AsioCallbacks callbacks{};
    std::promise<void>* stopped{nullptr};
    std::array<std::vector<float>, 4> samples{};
    HRESULT STDMETHODCALLTYPE QueryInterface(REFIID, void**) override {
        return E_NOINTERFACE;
    }
    ULONG STDMETHODCALLTYPE AddRef() override {
        return 1;
    }
    ULONG STDMETHODCALLTYPE Release() override {
        ++releases;
        return 0;
    }
    AsioBool STDMETHODCALLTYPE init(void*) override {
        return 1;
    }
    void STDMETHODCALLTYPE getDriverName(char*) override {}
    long STDMETHODCALLTYPE getDriverVersion() override {
        return 1;
    }
    void STDMETHODCALLTYPE getErrorMessage(char*) override {}
    AsioError STDMETHODCALLTYPE start() override {
        ++starts;
        started = !failStart;
        return failStart ? -1 : AsioOk;
    }
    AsioError STDMETHODCALLTYPE stop() override {
        ++stops;
        started = false;
        if (stopped)
            stopped->set_value();
        return AsioOk;
    }
    AsioError STDMETHODCALLTYPE getChannels(long* in, long* out) override {
        *in = *out = 1;
        return failChannels ? -1 : AsioOk;
    }
    AsioError STDMETHODCALLTYPE getLatencies(long* in, long* out) override {
        if (failLatency)
            return -1;
        *in = *out = latency;
        return AsioOk;
    }
    AsioError STDMETHODCALLTYPE getBufferSize(long* min, long* max, long* pref,
                                              long* gran) override {
        if (rateDependentPeriod && rate == 96000) {
            *min = *max = *pref = 128;
            *gran = 0;
            return AsioOk;
        }
        *min = minimum;
        *max = maximum;
        *pref = preferred;
        *gran = granularity;
        return AsioOk;
    }
    AsioError STDMETHODCALLTYPE canSampleRate(double value) override {
        return value == 44100 || value == 96000 ? AsioOk : -1;
    }
    AsioError STDMETHODCALLTYPE getSampleRate(double* value) override {
        *value = rate;
        return AsioOk;
    }
    AsioError STDMETHODCALLTYPE setSampleRate(double value) override {
        rate = value;
        return AsioOk;
    }
    AsioError STDMETHODCALLTYPE getClockSources(void*, long*) override {
        return -1;
    }
    AsioError STDMETHODCALLTYPE setClockSource(long) override {
        return -1;
    }
    AsioError STDMETHODCALLTYPE getSamplePosition(AsioSamples* pos, AsioTimeStamp* time) override {
        *pos = {};
        *time = {};
        return AsioOk;
    }
    AsioError STDMETHODCALLTYPE getChannelInfo(AsioChannelInfo* info) override {
        info->type = AsioFloat32Lsb;
        return AsioOk;
    }
    AsioError STDMETHODCALLTYPE createBuffers(AsioBufferInfo* infos, long count, long frames,
                                              AsioCallbacks* cb) override {
        selectedFrames = frames;
        callbacks = *cb;
        for (auto& channel : samples)
            channel.assign(static_cast<std::size_t>(frames), 0.0F);
        for (long index = 0; index < count; ++index) {
            infos[index].buffers[0] = samples[static_cast<std::size_t>(index) * 2].data();
            infos[index].buffers[1] = samples[static_cast<std::size_t>(index) * 2 + 1].data();
        }
        return AsioOk;
    }
    AsioError STDMETHODCALLTYPE disposeBuffers() override {
        ++disposals;
        return AsioOk;
    }
    AsioError STDMETHODCALLTYPE controlPanel() override {
        return AsioOk;
    }
    AsioError STDMETHODCALLTYPE future(long, void*) override {
        return -1;
    }
    AsioError STDMETHODCALLTYPE outputReady() override {
        return AsioOk;
    }
};
struct Callback final : IAudioCallback {
    int renders{0};
    void onCapture(GenerationId, const BackendAudioBuffer&) noexcept override {}
    void onRender(GenerationId, const BackendAudioBuffer&) noexcept override {
        ++renders;
    }
    void onBackendEvent(GenerationId, BackendEventType, std::int32_t) noexcept override {}
};
RequestedConfiguration request(std::uint32_t period = 56) {
    return {"driver", "driver", BackendKind::Asio, 44100, period, 1, 1};
}
} // namespace

void asioCapabilityProbePreservesTheActiveDriver() {
    Driver driver, probe;
    Callback callback;
    AsioBackend running([&](const auto&) { return &driver; });
    (void)running.open(request());
    running.start(callback, GenerationId{1});
    driver.callbacks.bufferSwitch(0, 0);
    {
        AsioBackend other([&](const auto&) { return &probe; });
        (void)other.queryCapabilities(request());
    }
    driver.callbacks.bufferSwitch(0, 0);
    expect(callback.renders == 2,
           "A capability probe or unrelated destructor must not silence the active ASIO driver");
    running.close();
}

void asioLatencyFailureDoesNotReuseThePreviousDevice() {
    Driver driver;
    driver.latency = 512;
    AsioBackend backend([&](const auto&) { return &driver; });
    expect(backend.open(request()).outputLatencyFrames == 512,
           "driver latency is authoritative when available");
    backend.close();
    driver.failLatency = true;
    const auto runtime = backend.open(request());
    expect(runtime.inputLatencyFrames == 0 && runtime.outputLatencyFrames == 0,
           "unavailable latency must not reuse the previous device's measurements");
}

void asioCapabilityFailureReleasesTheDriver() {
    Driver driver;
    driver.failChannels = true;
    AsioBackend backend([&](const auto&) { return &driver; });
    try {
        (void)backend.queryCapabilities(request());
    } catch (const std::exception&) {
    }
    expect(driver.releases == 1, "A failed ASIO capability probe must release its COM driver");
}

void asioCapabilitiesIncludeSupportedRequestedRate() {
    Driver driver;
    AsioBackend backend([&](const auto&) { return &driver; });
    auto wanted = request();
    wanted.sampleRateHz = 96000;
    const auto caps = backend.queryCapabilities(wanted);
    expect(std::ranges::find(caps.sampleRatesHz, 96000U) != caps.sampleRatesHz.end(),
           "ASIO must test the requested rate instead of restricting the session to the current "
           "driver rate");
    expect(caps.defaultSampleRateHz == 44100,
           "Probing supported rates must not change the current driver rate");
}

void asioBufferSelectionUsesDriverConstraints() {
    struct Case {
        long min, max, pref, gran;
        std::uint32_t wanted, expected;
    };
    constexpr std::array cases{
        Case{8, 104, 56, 16, 56, 56},
        Case{8, 100, 56, 16, 99, 88},
        Case{16, 128, 64, -1, 65, 128},
        Case{16, 100, 64, -1, 99, 64},
    };
    for (const auto& item : cases) {
        Driver driver;
        driver.minimum = item.min;
        driver.maximum = item.max;
        driver.preferred = item.pref;
        driver.granularity = item.gran;
        AsioBackend backend([&](const auto&) { return &driver; });
        const auto runtime = backend.open(request(item.wanted));
        expect(runtime.outputPeriodFrames == item.expected,
               "ASIO buffer must respect the driver origin, range and power-of-two constraint");
        backend.close();
    }
}

void asioDestructionStopsTheDriver() {
    Driver driver;
    Callback callback;
    {
        AsioBackend backend([&](const auto&) { return &driver; });
        (void)backend.open(request());
        backend.start(callback, GenerationId{1});
    }
    expect(driver.stops == 1 && !driver.started,
           "Destroying ASIO must stop the driver before disposing its buffers");
}

void asioFailedStartDoesNotPublishRunning() {
    Driver driver;
    driver.failStart = true;
    Callback callback;
    AsioBackend backend([&](const auto&) { return &driver; });
    (void)backend.open(request());
    try {
        backend.start(callback, GenerationId{1});
    } catch (const std::exception&) {
    }
    expect(!backend.snapshot().running, "A failed ASIO start must not report a running stream");
    backend.close();
}

void asioRepeatedStartPreservesTheActiveCallback() {
    Driver driver;
    Callback first, replacement;
    AsioBackend backend([&](const auto&) { return &driver; });
    (void)backend.open(request());
    backend.start(first, GenerationId{1});
    bool rejected = false;
    try {
        backend.start(replacement, GenerationId{2});
    } catch (const std::logic_error&) {
        rejected = true;
    }
    expect(rejected, "ASIO rejects a second start before mutating callback ownership");
    driver.callbacks.bufferSwitch(0, 0);
    expect(driver.starts == 1 && first.renders == 1 && replacement.renders == 0,
           "the already-running driver and callback remain intact");
    backend.stop();
    backend.stop();
    expect(driver.stops == 1, "repeated stop calls the driver exactly once");
    backend.start(replacement, GenerationId{2});
    driver.callbacks.bufferSwitch(0, 0);
    expect(replacement.renders == 1, "start after a completed stop accepts the new generation");
    backend.close();
}

void asioApartmentFailedStartupReleasesItsEvent() {
    AsioComApartment apartment;
    DWORD before = 0, after = 0;
    expect(GetProcessHandleCount(GetCurrentProcess(), &before) != FALSE,
           "handle baseline is available");
    for (int attempt = 0; attempt < 3; ++attempt) {
        failNextAllocation();
        bool rejected = false;
        try {
            (void)apartment.start();
        } catch (const std::bad_alloc&) {
            rejected = true;
        }
        expect(rejected, "allocation failure is injected after the wake event is created");
    }
    expect(GetProcessHandleCount(GetCurrentProcess(), &after) != FALSE && after == before,
           "failed apartment startup must not leak wake events across retries");
    expect(apartment.start(), "apartment can start after resource failure");
    apartment.reset();
}

void asioStopDrainsInFlightCallbacks() {
    struct WaitingCallback final : IAudioCallback {
        std::latch entered{1}, release{1};
        void onCapture(GenerationId, const BackendAudioBuffer&) noexcept override {}
        void onRender(GenerationId, const BackendAudioBuffer&) noexcept override {
            entered.count_down();
            release.wait();
        }
        void onBackendEvent(GenerationId, BackendEventType, std::int32_t) noexcept override {}
    } callback;
    Driver driver;
    std::promise<void> stopped;
    driver.stopped = &stopped;
    AsioBackend backend([&](const auto&) { return &driver; });
    (void)backend.open(request());
    backend.start(callback, GenerationId{1});
    std::thread processing([&] { driver.callbacks.bufferSwitch(0, 0); });
    callback.entered.wait();
    auto stopping = std::async(std::launch::async, [&] { backend.stop(); });
    stopped.get_future().wait();
    expect(stopping.wait_for(std::chrono::milliseconds(20)) == std::future_status::timeout,
           "ASIO stop must wait for the in-flight callback before releasing session ownership");
    callback.release.count_down();
    processing.join();
    stopping.get();
    backend.close();
}

void asioRejectsInvalidDriverCapabilities() {
    Driver driver;
    driver.minimum = 0;
    AsioBackend backend([&](const auto&) { return &driver; });
    bool rejected = false;
    try {
        (void)backend.queryCapabilities(request());
    } catch (const std::exception&) {
        rejected = true;
    }
    expect(
        rejected,
        "Invalid ASIO driver constraints must be rejected instead of manufacturing capabilities");
}

void asioNegotiatesBufferAfterChangingRate() {
    Driver driver;
    driver.rateDependentPeriod = true;
    AsioBackend backend([&](const auto&) { return &driver; });
    auto wanted = request();
    wanted.sampleRateHz = 96000;
    const auto runtime = backend.open(wanted);
    expect(runtime.outputPeriodFrames == 128,
           "ASIO buffer constraints must be queried after setting the rate");
    backend.close();
}
void asioSplitsLargeDriverBuffers() {
    Driver driver;
    driver.minimum = driver.maximum = driver.preferred = MaxBlockFrames * 2 + 1;
    driver.granularity = 0;
    AsioBackend backend([&](const auto&) { return &driver; });
    struct ChunkedCallback final : IAudioCallback {
        std::uint32_t captured{0}, rendered{0}, maximum{0};
        bool positionsContinuous{true};
        void onCapture(GenerationId, const BackendAudioBuffer& buffer) noexcept override {
            positionsContinuous &= buffer.devicePosition == captured;
            for (std::uint32_t frame = 0; frame < buffer.frames; ++frame)
                positionsContinuous &=
                    buffer.input[frame] == static_cast<float>(captured + frame) / 16384.0F;
            captured += buffer.frames;
            maximum = std::max(maximum, buffer.frames);
        }
        void onRender(GenerationId, const BackendAudioBuffer& buffer) noexcept override {
            positionsContinuous &= buffer.devicePosition == rendered;
            for (std::uint32_t frame = 0; frame < buffer.frames; ++frame)
                buffer.output[frame] = static_cast<float>(rendered + frame) / 16384.0F;
            rendered += buffer.frames;
            maximum = std::max(maximum, buffer.frames);
        }
        void onBackendEvent(GenerationId, BackendEventType, std::int32_t) noexcept override {}
    } callback;
    (void)backend.open(request(static_cast<std::uint32_t>(driver.preferred)));
    for (std::size_t frame = 0; frame < driver.samples[0].size(); ++frame)
        driver.samples[0][frame] = static_cast<float>(frame) / 16384.0F;
    backend.start(callback, GenerationId{1});
    RealtimeInstrumentation::reset();
    {
        RealtimeScope realtime;
        driver.callbacks.bufferSwitch(0, 0);
    }
    const auto violations = RealtimeInstrumentation::snapshot();
    expect(violations.allocations == 0 && violations.deallocations == 0,
           "ASIO callback leases, conversion and chunking must not allocate or free memory");
    expect(driver.samples[0] == driver.samples[2],
           "Chunked ASIO rendering must preserve all PCM positions");
    expect(
        callback.captured == static_cast<std::uint32_t>(driver.preferred) &&
            callback.rendered == callback.captured && callback.maximum <= MaxBlockFrames &&
            callback.positionsContinuous,
        "Large ASIO buffers must become bounded, continuous callback chunks without losing frames");
    backend.close();
}
} // namespace Tests
#else
namespace Tests {
void asioCapabilityProbePreservesTheActiveDriver() {}
void asioLatencyFailureDoesNotReuseThePreviousDevice() {}
void asioCapabilityFailureReleasesTheDriver() {}
void asioCapabilitiesIncludeSupportedRequestedRate() {}
void asioBufferSelectionUsesDriverConstraints() {}
void asioDestructionStopsTheDriver() {}
void asioFailedStartDoesNotPublishRunning() {}
void asioRepeatedStartPreservesTheActiveCallback() {}
void asioApartmentFailedStartupReleasesItsEvent() {}
void asioStopDrainsInFlightCallbacks() {}
void asioRejectsInvalidDriverCapabilities() {}
void asioNegotiatesBufferAfterChangingRate() {}
void asioSplitsLargeDriverBuffers() {}
} // namespace Tests
#endif
