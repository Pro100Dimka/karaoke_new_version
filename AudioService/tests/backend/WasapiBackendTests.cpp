#include "TestHarness.hpp"
#ifdef _WIN32
#include "backend/wasapi/WasapiBackend.hpp"
#include <array>
#include <atomic>
#include <audioclient.h>
#include <cstring>
#include <mmdeviceapi.h>

namespace {
struct Event {
    HANDLE handle{CreateEventW(nullptr, TRUE, FALSE, nullptr)};
    ~Event() {
        CloseHandle(handle);
    }
    void signal() {
        SetEvent(handle);
    }
    bool wait() {
        return WaitForSingleObject(handle, 2000) == WAIT_OBJECT_0;
    }
};
template <typename Interface> struct ComStub : Interface {
    HRESULT STDMETHODCALLTYPE QueryInterface(REFIID, void** value) override {
        *value = nullptr;
        return E_NOINTERFACE;
    }
    ULONG STDMETHODCALLTYPE AddRef() override {
        return 1;
    }
    ULONG STDMETHODCALLTYPE Release() override {
        return 1;
    }
};
enum class Fault {
    None,
    PacketSize,
    CaptureGet,
    CaptureRelease,
    BufferSize,
    StreamLatency,
    Padding,
    RenderGet,
    RenderRelease
};
struct FormatMemorySpy : ComStub<IMallocSpy> {
    WAVEFORMATEX*& target;
    bool freed{false};
    explicit FormatMemorySpy(WAVEFORMATEX*& pointer) : target(pointer) {}
    HRESULT STDMETHODCALLTYPE QueryInterface(REFIID id, void** value) override {
        *value = (id == __uuidof(IMallocSpy) || id == __uuidof(IUnknown)) ? this : nullptr;
        return *value ? S_OK : E_NOINTERFACE;
    }
    SIZE_T STDMETHODCALLTYPE PreAlloc(SIZE_T bytes) override {
        return bytes;
    }
    void* STDMETHODCALLTYPE PostAlloc(void* value) override {
        return value;
    }
    void* STDMETHODCALLTYPE PreFree(void* value, BOOL) override {
        if (value == target && value)
            freed = true;
        return value;
    }
    void STDMETHODCALLTYPE PostFree(BOOL) override {}
    SIZE_T STDMETHODCALLTYPE PreRealloc(void* value, SIZE_T bytes, void** requested,
                                        BOOL) override {
        *requested = value;
        return bytes;
    }
    void* STDMETHODCALLTYPE PostRealloc(void* value, BOOL) override {
        return value;
    }
    void* STDMETHODCALLTYPE PreGetSize(void* value, BOOL) override {
        return value;
    }
    SIZE_T STDMETHODCALLTYPE PostGetSize(SIZE_T bytes, BOOL) override {
        return bytes;
    }
    void* STDMETHODCALLTYPE PreDidAlloc(void* value, BOOL) override {
        return value;
    }
    int STDMETHODCALLTYPE PostDidAlloc(void*, BOOL, int actual) override {
        return actual;
    }
    void STDMETHODCALLTYPE PreHeapMinimize() override {}
    void STDMETHODCALLTYPE PostHeapMinimize() override {}
};
struct DriverState {
    Fault fault{Fault::None};
    Event attempted;
    std::atomic<bool> started{false};
    HRESULT result(Fault operation) {
        if (started.load() && fault == operation) {
            attempted.signal();
            return AUDCLNT_E_DEVICE_INVALIDATED;
        }
        return S_OK;
    }
};
struct Capture : ComStub<IAudioCaptureClient> {
    DriverState& state;
    UINT32 frames{0};
    std::vector<float> samples = std::vector<float>(MaxBlockFrames + 64, 0.25F);
    explicit Capture(DriverState& value) : state(value) {}
    HRESULT STDMETHODCALLTYPE GetNextPacketSize(UINT32* value) override {
        *value = frames;
        return state.result(Fault::PacketSize);
    }
    HRESULT STDMETHODCALLTYPE GetBuffer(BYTE** data, UINT32* count, DWORD* flags, UINT64* position,
                                        UINT64* time) override {
        *data = reinterpret_cast<BYTE*>(samples.data());
        *count = frames;
        *flags = 0;
        *position = 1000;
        *time = 900000;
        return state.result(Fault::CaptureGet);
    }
    HRESULT STDMETHODCALLTYPE ReleaseBuffer(UINT32) override {
        frames = 0;
        state.attempted.signal();
        return state.result(Fault::CaptureRelease);
    }
};
struct Render : ComStub<IAudioRenderClient> {
    DriverState& state;
    UINT32 frames{MaxBlockFrames + 64};
    bool exclusive{false}, failPrefill{false};
    unsigned submitted{0}, acquired{0};
    std::vector<float> samples = std::vector<float>(MaxBlockFrames + 64);
    explicit Render(DriverState& value) : state(value) {}
    HRESULT STDMETHODCALLTYPE GetBuffer(UINT32 count, BYTE** data) override {
        ++acquired;
        *data = reinterpret_cast<BYTE*>(samples.data());
        if (failPrefill && !state.started.load())
            return E_FAIL;
        const auto fault = state.result(Fault::RenderGet);
        if (FAILED(fault))
            return fault;
        if (exclusive && count != frames) {
            state.attempted.signal();
            return AUDCLNT_E_BUFFER_SIZE_ERROR;
        }
        return count <= frames ? S_OK : AUDCLNT_E_BUFFER_TOO_LARGE;
    }
    HRESULT STDMETHODCALLTYPE ReleaseBuffer(UINT32 count, DWORD flags) override {
        if ((flags & AUDCLNT_BUFFERFLAGS_SILENT) == 0) {
            submitted += count;
            state.attempted.signal();
        }
        return state.result(Fault::RenderRelease);
    }
};
struct Clock : ComStub<IAudioClock> {
    HRESULT STDMETHODCALLTYPE GetFrequency(UINT64* value) override {
        *value = 48000;
        return S_OK;
    }
    HRESULT STDMETHODCALLTYPE GetPosition(UINT64* position, UINT64* time) override {
        *position = 1000;
        *time = 900000;
        return S_OK;
    }
    HRESULT STDMETHODCALLTYPE GetCharacteristics(DWORD* value) override {
        *value = 0;
        return S_OK;
    }
};
struct Client : ComStub<IAudioClient3> {
    DriverState state;
    Capture capture{state};
    Render render{state};
    Clock clock;
    HANDLE event{nullptr};
    bool output;
    bool failPeriodQuery{false}, failStart{false}, silentEvents{false}, failMix{false};
    WAVEFORMATEX* lastMix{nullptr};
    UINT32 selectedPeriod{0}, pad{0}, fundamental{64}, minimum{64}, maximum{512},
        unsupportedRate{0};
    int legacyInitializes{0}, stops{0};
    explicit Client(bool isOutput) : output(isOutput) {}
    HRESULT STDMETHODCALLTYPE QueryInterface(REFIID id, void** value) override {
        *value = nullptr;
        if (id != __uuidof(IAudioClient3) && id != __uuidof(IAudioClient2) &&
            id != __uuidof(IAudioClient) && id != __uuidof(IUnknown))
            return E_NOINTERFACE;
        *value = static_cast<IAudioClient3*>(this);
        AddRef();
        return S_OK;
    }
    HRESULT STDMETHODCALLTYPE Initialize(AUDCLNT_SHAREMODE mode, DWORD, REFERENCE_TIME,
                                         REFERENCE_TIME, const WAVEFORMATEX*, LPCGUID) override {
        render.exclusive = mode == AUDCLNT_SHAREMODE_EXCLUSIVE;
        ++legacyInitializes;
        selectedPeriod = 480;
        return S_OK;
    }
    HRESULT STDMETHODCALLTYPE GetBufferSize(UINT32* count) override {
        *count = render.frames;
        return state.result(Fault::BufferSize);
    }
    HRESULT STDMETHODCALLTYPE GetStreamLatency(REFERENCE_TIME* time) override {
        *time = 100000;
        return state.fault == Fault::StreamLatency ? AUDCLNT_E_DEVICE_INVALIDATED : S_OK;
    }
    HRESULT STDMETHODCALLTYPE GetCurrentPadding(UINT32* value) override {
        *value = pad;
        if (pad > render.frames)
            state.attempted.signal();
        return state.result(Fault::Padding);
    }
    HRESULT STDMETHODCALLTYPE IsFormatSupported(AUDCLNT_SHAREMODE, const WAVEFORMATEX* format,
                                                WAVEFORMATEX**) override {
        return format->nSamplesPerSec == unsupportedRate ? AUDCLNT_E_UNSUPPORTED_FORMAT : S_OK;
    }
    HRESULT STDMETHODCALLTYPE GetMixFormat(WAVEFORMATEX** value) override {
        if (failMix) {
            *value = nullptr;
            return E_FAIL;
        }
        *value = static_cast<WAVEFORMATEX*>(CoTaskMemAlloc(sizeof(WAVEFORMATEX)));
        lastMix = *value;
        if (!*value)
            return E_OUTOFMEMORY;
        **value = {WAVE_FORMAT_IEEE_FLOAT, 1, 48000, 192000, 4, 32, 0};
        return S_OK;
    }
    HRESULT STDMETHODCALLTYPE GetDevicePeriod(REFERENCE_TIME* normal,
                                              REFERENCE_TIME* minimumTime) override {
        *normal = 100000;
        *minimumTime = 10000;
        return S_OK;
    }
    HRESULT STDMETHODCALLTYPE Start() override {
        if (failStart)
            return AUDCLNT_E_DEVICE_INVALIDATED;
        state.started.store(true);
        if (!silentEvents)
            SetEvent(event);
        return S_OK;
    }
    HRESULT STDMETHODCALLTYPE Stop() override {
        ++stops;
        state.started.store(false);
        return S_OK;
    }
    HRESULT STDMETHODCALLTYPE Reset() override {
        return S_OK;
    }
    HRESULT STDMETHODCALLTYPE SetEventHandle(HANDLE value) override {
        event = value;
        return S_OK;
    }
    HRESULT STDMETHODCALLTYPE GetService(REFIID id, void** value) override {
        *value = nullptr;
        if (id == __uuidof(IAudioCaptureClient))
            *value = &capture;
        if (id == __uuidof(IAudioRenderClient))
            *value = &render;
        if (id == __uuidof(IAudioClock))
            *value = &clock;
        return *value ? S_OK : E_NOINTERFACE;
    }
    HRESULT STDMETHODCALLTYPE IsOffloadCapable(AUDIO_STREAM_CATEGORY, BOOL* value) override {
        *value = FALSE;
        return S_OK;
    }
    HRESULT STDMETHODCALLTYPE SetClientProperties(const AudioClientProperties*) override {
        return S_OK;
    }
    HRESULT STDMETHODCALLTYPE GetBufferSizeLimits(const WAVEFORMATEX*, BOOL, REFERENCE_TIME*,
                                                  REFERENCE_TIME*) override {
        return E_NOTIMPL;
    }
    HRESULT STDMETHODCALLTYPE GetSharedModeEnginePeriod(const WAVEFORMATEX*, UINT32* normal,
                                                        UINT32* step, UINT32* low,
                                                        UINT32* high) override {
        *normal = 256;
        *step = fundamental;
        *low = minimum;
        *high = maximum;
        return failPeriodQuery ? E_NOTIMPL : S_OK;
    }
    HRESULT STDMETHODCALLTYPE GetCurrentSharedModeEnginePeriod(WAVEFORMATEX** format,
                                                               UINT32* period) override {
        *period = selectedPeriod;
        return GetMixFormat(format);
    }
    HRESULT STDMETHODCALLTYPE InitializeSharedAudioStream(DWORD, UINT32 frames, const WAVEFORMATEX*,
                                                          LPCGUID) override {
        if (failPeriodQuery || frames < minimum || frames > maximum || frames % fundamental != 0)
            return AUDCLNT_E_INVALID_DEVICE_PERIOD;
        selectedPeriod = frames;
        return S_OK;
    }
};
struct Device : ComStub<IMMDevice> {
    Client client;
    explicit Device(bool output) : client(output) {}
    HRESULT STDMETHODCALLTYPE Activate(REFIID id, DWORD, PROPVARIANT*, void** value) override {
        return client.QueryInterface(id, value);
    }
    HRESULT STDMETHODCALLTYPE OpenPropertyStore(DWORD, IPropertyStore** value) override {
        *value = nullptr;
        return E_NOTIMPL;
    }
    HRESULT STDMETHODCALLTYPE GetId(LPWSTR*) override {
        return E_NOTIMPL;
    }
    HRESULT STDMETHODCALLTYPE GetState(DWORD* value) override {
        *value = DEVICE_STATE_ACTIVE;
        return S_OK;
    }
};
struct Callback : IAudioCallback {
    std::array<BackendAudioBuffer, 8> captures{}, renders{};
    unsigned captureCount{0}, renderCount{0}, lost{0};
    bool comInitialized{false};
    void onCapture(GenerationId, const BackendAudioBuffer& buffer) noexcept override {
        if (captureCount < captures.size())
            captures[captureCount++] = buffer;
    }
    void onRender(GenerationId, const BackendAudioBuffer& buffer) noexcept override {
        APTTYPE apartment{};
        APTTYPEQUALIFIER qualifier{};
        comInitialized = SUCCEEDED(CoGetApartmentType(&apartment, &qualifier));
        if (renderCount < renders.size())
            renders[renderCount++] = buffer;
        std::fill_n(buffer.output, static_cast<std::size_t>(buffer.frames) * buffer.channels,
                    0.125F);
    }
    void onBackendEvent(GenerationId, BackendEventType event, std::int32_t) noexcept override {
        if (event == BackendEventType::DeviceLost || event == BackendEventType::DeviceInvalidated)
            ++lost;
    }
};
struct Fixture {
    Device input{false}, output{true};
    Callback callback;
    WasapiBackend backend;
    explicit Fixture(WasapiMode mode = WasapiMode::Shared)
        : backend(mode, [this](Direction direction, const std::string&) -> IMMDevice* {
              return direction == Direction::Input ? &input : &output;
          }) {}
    RequestedConfiguration request(UINT32 period = 256) {
        return {"in", "out", BackendKind::WasapiShared, 48000, period, 1, 1};
    }
};
} // namespace

void Tests::wasapiExclusiveSubdividesPcmWithoutSplittingEndpointPackets() {
    Fixture fixture(WasapiMode::Exclusive);
    (void)fixture.backend.open(fixture.request());
    fixture.backend.start(fixture.callback, GenerationId{1});
    expect(fixture.output.client.state.attempted.wait(),
           "exclusive render must service the endpoint event");
    fixture.backend.stop();
    expect(fixture.output.client.render.submitted == MaxBlockFrames + 64,
           "exclusive GetBuffer/ReleaseBuffer must use one complete endpoint packet");
    expect(fixture.callback.renderCount == 2 && fixture.callback.renders[1].frames == 64,
           "large native buffers must retain bounded internal callbacks");
}

void Tests::wasapiReportsEveryDeviceFailure() {
    constexpr std::array faults{Fault::PacketSize,   Fault::CaptureGet, Fault::CaptureRelease,
                                Fault::BufferSize,   Fault::Padding,    Fault::RenderGet,
                                Fault::RenderRelease};
    for (const auto fault : faults) {
        Fixture fixture;
        (void)fixture.backend.open(fixture.request());
        const bool capture = fault == Fault::PacketSize || fault == Fault::CaptureGet ||
                             fault == Fault::CaptureRelease;
        auto& client = capture ? fixture.input.client : fixture.output.client;
        client.state.fault = fault;
        fixture.input.client.capture.frames = 64;
        fixture.backend.start(fixture.callback, GenerationId{1});
        expect(client.state.attempted.wait(), "WASAPI failure path must be exercised");
        fixture.backend.stop();
        expect(fixture.callback.lost == 1,
               "a failed WASAPI device operation must publish exactly one recovery event");
    }
    Fixture fixture;
    (void)fixture.backend.open(fixture.request());
    fixture.output.client.pad = fixture.output.client.render.frames + 1;
    fixture.output.client.state.fault = Fault::RenderGet;
    fixture.backend.start(fixture.callback, GenerationId{1});
    expect(fixture.output.client.state.attempted.wait(), "invalid padding must be observed");
    fixture.backend.stop();
    expect(
        fixture.output.client.render.acquired == 1,
        "invalid padding must not underflow into a huge render request; only prefill is allowed");
}

void Tests::wasapiSharedFallsBackWhenEnginePeriodQueryIsUnavailable() {
    Fixture fixture;
    fixture.input.client.failPeriodQuery = fixture.output.client.failPeriodQuery = true;
    try {
        const auto actual = fixture.backend.open(fixture.request());
        expect(actual.inputPeriodFrames == 480 && actual.outputPeriodFrames == 480,
               "runtime must report the actual fallback engine period");
        expect(fixture.input.client.legacyInitializes == 1 &&
                   fixture.output.client.legacyInitializes == 1,
               "unavailable period negotiation must use the legacy shared client");
    } catch (...) {
        expect(false, "IAudioClient3 period-query failure must have a supported shared fallback");
    }
}

void Tests::wasapiSharedPeriodStaysInsideDriverBounds() {
    Fixture fixture;
    fixture.input.client.maximum = fixture.output.client.maximum = 500;
    try {
        const auto actual = fixture.backend.open(fixture.request(499));
        expect(actual.inputPeriodFrames == 448 && actual.outputPeriodFrames == 448,
               "rounding to a fundamental must not exceed the maximum period");
    } catch (...) {
        expect(false, "valid fundamental period below the maximum must be selected");
    }
}

void Tests::wasapiChunkTimestampsFollowTheirSamplePositions() {
    Fixture fixture;
    (void)fixture.backend.open(fixture.request());
    fixture.input.client.capture.frames = MaxBlockFrames + 64;
    fixture.output.client.pad = 20;
    fixture.backend.start(fixture.callback, GenerationId{1});
    expect(fixture.input.client.state.attempted.wait(), "capture packet must be consumed");
    expect(fixture.output.client.state.attempted.wait(), "render packet must be filled");
    fixture.backend.stop();
    const auto firstAudible = 90'000'000LL +
        static_cast<MonotonicTicks>(fixture.output.client.render.frames - 1000) *
            1'000'000'000LL / 48000;
    expect(fixture.callback.renders[0].presentationTicks == firstAudible &&
               fixture.callback.renders[1].presentationTicks == firstAudible +
                   static_cast<MonotonicTicks>(MaxBlockFrames) * 1'000'000'000LL / 48000,
           "WASAPI presentation follows submitted PCM and the measured speaker clock");
    const auto ticks =
        static_cast<MonotonicTicks>(static_cast<std::uint64_t>(MaxBlockFrames) * 10000000 / 48000);
    expect(fixture.callback.captureCount == 2 &&
               fixture.callback.captures[1].timestamp == 900000 + ticks,
           "capture chunk timestamps must advance with the packet offset");
    expect(fixture.callback.renderCount == 2 &&
               fixture.callback.renders[0].devicePosition == 1020 &&
               fixture.callback.renders[1].devicePosition == 1020 + MaxBlockFrames,
           "render clock positions must include padding and processed frames");
}

void Tests::wasapiFailedStartRollsBackTheRunningSession() {
    {
        Fixture prefill;
        (void)prefill.backend.open(prefill.request());
        prefill.output.client.render.failPrefill = true;
        bool failed = false;
        try {
            prefill.backend.start(prefill.callback, GenerationId{1});
        } catch (...) {
            failed = true;
        }
        expect(failed && !prefill.backend.snapshot().running,
               "prefill failure must fail startup rather than leave a silent running session");
        prefill.backend.stop();
    }
    Fixture fixture;
    (void)fixture.backend.open(fixture.request());
    fixture.input.client.failStart = true;
    bool failed = false;
    try {
        fixture.backend.start(fixture.callback, GenerationId{1});
    } catch (...) {
        failed = true;
    }
    expect(failed && !fixture.backend.snapshot().running,
           "failed start must not leave the callback thread running");
    expect(!fixture.output.client.state.started.load(),
           "failed capture start must stop the already started render stream");
    fixture.backend.stop();
    fixture.input.client.failStart = false;
    fixture.backend.start(fixture.callback, GenerationId{2});
    bool duplicateRejected = false;
    try {
        fixture.backend.start(fixture.callback, GenerationId{3});
    } catch (const std::logic_error&) {
        duplicateRejected = true;
    }
    expect(
        duplicateRejected && fixture.backend.snapshot().running,
        "double start must preserve the running callback thread without terminating the process");
    fixture.backend.stop();
}

void Tests::wasapiCallbackThreadInitializesCom() {
    const auto initialized = CoInitializeEx(nullptr, COINIT_APARTMENTTHREADED);
    expect(SUCCEEDED(initialized), "fixture must start on an STA control thread");
    {
        Fixture fixture;
        (void)fixture.backend.open(fixture.request());
        fixture.backend.start(fixture.callback, GenerationId{1});
        expect(fixture.output.client.state.attempted.wait(), "render callback must run");
        fixture.backend.stop();
        expect(fixture.callback.comInitialized,
               "WASAPI callback thread must initialize its COM apartment");
    }
    if (SUCCEEDED(initialized))
        CoUninitialize();
}

void Tests::wasapiDetectsDeviceLossWithoutEndpointEvents() {
    Fixture fixture;
    (void)fixture.backend.open(fixture.request());
    fixture.input.client.silentEvents = fixture.output.client.silentEvents = true;
    fixture.output.client.state.fault = Fault::BufferSize;
    fixture.backend.start(fixture.callback, GenerationId{1});
    expect(fixture.output.client.state.attempted.wait(),
           "stalled event delivery must not hide an invalidated device");
    fixture.backend.stop();
    expect(fixture.callback.lost == 1, "silent endpoint loss must enter recovery");
}

void Tests::wasapiLatencyFailureDoesNotPublishInvalidMeasurements() {
    Fixture fixture;
    fixture.input.client.state.fault = fixture.output.client.state.fault = Fault::StreamLatency;
    bool failed = false;
    try {
        (void)fixture.backend.open(fixture.request());
    } catch (const std::exception&) {
        failed = true;
    }
    expect(failed, "device invalidation while querying latency must fail device initialization");
}

void Tests::wasapiCapabilitiesUseSupportedRatesAndSharedPeriods() {
    {
        Fixture fixture;
        fixture.output.client.failMix = true;
        FormatMemorySpy memory(fixture.input.client.lastMix);
        const auto registered = CoRegisterMallocSpy(&memory);
        expect(SUCCEEDED(registered), "COM allocator observer must be installed");
        if (SUCCEEDED(registered)) {
            bool failed = false;
            try {
                (void)fixture.backend.queryCapabilities(fixture.request());
            } catch (...) {
                failed = true;
            }
            expect(failed && memory.freed,
                   "capability failure must release the previously allocated input format");
            if (!memory.freed && memory.target)
                CoTaskMemFree(memory.target);
            expect(SUCCEEDED(CoRevokeMallocSpy()),
                   "allocator observer must have no outstanding allocations");
        }
    }
    {
        Fixture fixture(WasapiMode::Exclusive);
        auto request = fixture.request();
        request.sampleRateHz = 96000;
        const auto supported = fixture.backend.queryCapabilities(request);
        expect(std::find(supported.sampleRatesHz.begin(), supported.sampleRatesHz.end(), 96000U) !=
                   supported.sampleRatesHz.end(),
               "exclusive capabilities must probe the requested device rate");
        fixture.output.client.unsupportedRate = 88200;
        request.sampleRateHz = 88200;
        const auto rejected = fixture.backend.queryCapabilities(request);
        expect(std::find(rejected.sampleRatesHz.begin(), rejected.sampleRatesHz.end(), 88200U) ==
                   rejected.sampleRatesHz.end(),
               "unsupported exclusive rates must not be advertised");
    }
    {
        Fixture fixture;
        fixture.output.client.failPeriodQuery = true;
        const auto caps = fixture.backend.queryCapabilities(fixture.request());
        expect(caps.periodFrames == std::vector<std::uint32_t>{480} &&
                   caps.minPeriodFrames == 480 && caps.maxPeriodFrames == 480,
               "legacy shared mode must advertise its engine period rather than exclusive minimum "
               "latency");
    }
    {
        Fixture fixture;
        fixture.output.client.minimum = 70;
        fixture.output.client.maximum = 500;
        const auto caps = fixture.backend.queryCapabilities(fixture.request());
        expect(caps.periodFrames == std::vector<std::uint32_t>{128, 192, 256, 320, 384, 448},
               "shared choices must be fundamental multiples inside the driver bounds");
    }
}
#else
void Tests::wasapiLatencyFailureDoesNotPublishInvalidMeasurements() {}
void Tests::wasapiExclusiveSubdividesPcmWithoutSplittingEndpointPackets() {}
void Tests::wasapiReportsEveryDeviceFailure() {}
void Tests::wasapiSharedFallsBackWhenEnginePeriodQueryIsUnavailable() {}
void Tests::wasapiSharedPeriodStaysInsideDriverBounds() {}
void Tests::wasapiChunkTimestampsFollowTheirSamplePositions() {}
void Tests::wasapiFailedStartRollsBackTheRunningSession() {}
void Tests::wasapiCallbackThreadInitializesCom() {}
void Tests::wasapiDetectsDeviceLossWithoutEndpointEvents() {}
void Tests::wasapiCapabilitiesUseSupportedRatesAndSharedPeriods() {}
#endif
