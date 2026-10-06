#ifdef _WIN32
#include "backend/wasapi/WasapiBackend.hpp"
#include "backend/wasapi/WasapiPcm.hpp"
#include "common/WindowsText.hpp"
#ifndef WIN32_LEAN_AND_MEAN
#define WIN32_LEAN_AND_MEAN
#endif
#ifndef NOMINMAX
#define NOMINMAX
#endif
#include <algorithm>
#include <array>
#include <atomic>
#include <audioclient.h>
#include <avrt.h>
#include <chrono>
#include <cmath>
#include <cstdio>
#include <cstring>
#include <endpointvolume.h>
#include <ksmedia.h>
#include <mmdeviceapi.h>
#include <optional>
#include <propsys.h>
#include <stdexcept>
#include <thread>
#include <vector>
#include <windows.h>
#include <wrl/client.h>

// Property keys depend on the SDK's COM property declarations above.
#include <functiondiscoverykeys_devpkey.h>

using Microsoft::WRL::ComPtr;
namespace {
void check(HRESULT hr, const char* message) {
    if (FAILED(hr)) {
        char code[16]{};
        std::snprintf(code, sizeof(code), " (0x%08lX)", static_cast<unsigned long>(hr));
        throw std::runtime_error(std::string(message) + code);
    }
}
using OwnedWaveFormat = std::unique_ptr<WAVEFORMATEX, decltype(&CoTaskMemFree)>;
OwnedWaveFormat mixFormat(IAudioClient* client) {
    WAVEFORMATEX* raw = nullptr;
    const auto result = client->GetMixFormat(&raw);
    OwnedWaveFormat owned(raw, &CoTaskMemFree);
    check(result, "endpoint mix format failed");
    if (!owned)
        throw std::runtime_error("endpoint returned no mix format");
    return owned;
}
// RAWMode feature flag: shared streams skip the Windows signal processing where the endpoint
// supports it. On the microphone, echo cancellation, noise suppression and beamforming buffer the
// voice (tens of ms on laptop microphones) and remove the speaker sound the acoustic latency meter
// listens for. On the output, the vendor's enhancement effects buffer the song and voices the same
// way, and while they are in the path Windows offers no shared period below its default (10 ms).
// Speaker protection is an endpoint effect and stays active in RAW mode.
constexpr bool RawProcessingMode = true;

// System.Devices.AudioDevice.RawProcessingSupported (propkey.h), spelled out so no extra SDK
// header or GUID library is needed.
constexpr PROPERTYKEY RawProcessingSupportedKey{
    {0x8943B373, 0x388C, 0x4395, {0xB5, 0x57, 0xBC, 0x6D, 0xBA, 0xFF, 0xAF, 0xDB}}, 2};

bool rawProcessingSupported(IMMDevice* device) {
    ComPtr<IPropertyStore> properties;
    if (device == nullptr || FAILED(device->OpenPropertyStore(STGM_READ, &properties)))
        return false;
    PROPVARIANT value;
    PropVariantInit(&value);
    const auto supported = SUCCEEDED(properties->GetValue(RawProcessingSupportedKey, &value)) &&
                           value.vt == VT_BOOL && value.boolVal != VARIANT_FALSE;
    PropVariantClear(&value);
    return supported;
}

// Processing mode affects the periods reported by the engine, so capabilities are queried with
// the same properties the stream is opened with.
// Returns whether the stream bypasses the Windows signal processing (RAW).
bool configureSharedMediaClient(IAudioClient* client, IMMDevice* device) {
    ComPtr<IAudioClient2> client2;
    if (FAILED(client->QueryInterface(IID_PPV_ARGS(&client2))))
        return false;
    const auto raw = RawProcessingMode && rawProcessingSupported(device);
    AudioClientProperties properties{sizeof(AudioClientProperties), FALSE, AudioCategory_Media,
                                     raw ? AUDCLNT_STREAMOPTIONS_RAW : AUDCLNT_STREAMOPTIONS_NONE};
    if (raw && SUCCEEDED(client2->SetClientProperties(&properties)))
        return true;
    properties.Options = AUDCLNT_STREAMOPTIONS_NONE;
    check(client2->SetClientProperties(&properties), "shared media properties failed");
    return false;
}
struct SharedPeriods {
    UINT32 normal{}, fundamental{}, minimum{}, maximum{};
};
struct SharedPeriodInfo {
    bool client3Available{false}, locked{false}, cpuFallback{false};
    UINT32 requested{0}, normal{0}, fundamental{0}, minimum{0}, maximum{0}, actual{0};
};
std::optional<SharedPeriods> sharedPeriods(IAudioClient3* client, const WAVEFORMATEX* format) {
    SharedPeriods value;
    if (FAILED(client->GetSharedModeEnginePeriod(format, &value.normal, &value.fundamental,
                                                 &value.minimum, &value.maximum)) ||
        value.fundamental == 0 || value.minimum == 0 || value.minimum > value.maximum)
        return std::nullopt;
    const auto lower =
        (static_cast<std::uint64_t>(value.minimum) + value.fundamental - 1) / value.fundamental;
    const auto upper = value.maximum / value.fundamental;
    if (lower > upper)
        return std::nullopt;
    value.minimum = static_cast<UINT32>(lower * value.fundamental);
    value.maximum = upper * value.fundamental;
    const auto normal =
        (static_cast<std::uint64_t>(value.normal) + value.fundamental - 1) / value.fundamental;
    value.normal =
        static_cast<UINT32>(std::clamp<std::uint64_t>(normal, lower, upper) * value.fundamental);
    return value;
}
// IAudioClient3::InitializeSharedAudioStream rejects AUDCLNT_STREAMFLAGS_NOPERSIST with
// AUDCLNT_E_INVALID_STREAM_FLAG.
constexpr DWORD audioClient3Flags(DWORD flags) noexcept {
    return flags & ~static_cast<DWORD>(AUDCLNT_STREAMFLAGS_NOPERSIST);
}
ComPtr<IMMDevice> deviceFor(IMMDeviceEnumerator* enumerator, EDataFlow flow, const std::string& id,
                            bool allowMissingDefault) {
    ComPtr<IMMDevice> device;
    if (id.empty()) {
        const auto result = enumerator->GetDefaultAudioEndpoint(flow, eConsole, &device);
        if (allowMissingDefault && result == E_NOTFOUND)
            return {};
        check(result, "default endpoint unavailable");
    } else {
        const auto wide = widen(id);
        check(enumerator->GetDevice(wide.c_str(), &device), "selected endpoint unavailable");
    }
    return device;
}
std::vector<std::byte> endpointNativeFormat(IMMDevice* device) {
    ComPtr<IPropertyStore> properties;
    if (device == nullptr || FAILED(device->OpenPropertyStore(STGM_READ, &properties)))
        return {};
    PROPVARIANT value;
    PropVariantInit(&value);
    std::vector<std::byte> result;
    if (SUCCEEDED(properties->GetValue(PKEY_AudioEngine_DeviceFormat, &value)) &&
        value.vt == VT_BLOB && value.blob.pBlobData != nullptr &&
        value.blob.cbSize >= sizeof(WAVEFORMATEX)) {
        const auto* format = reinterpret_cast<const WAVEFORMATEX*>(value.blob.pBlobData);
        const auto bytes = sizeof(WAVEFORMATEX) + static_cast<std::size_t>(format->cbSize);
        if (bytes <= value.blob.cbSize) {
            result.resize(bytes);
            std::memcpy(result.data(), value.blob.pBlobData, bytes);
        }
    }
    PropVariantClear(&value);
    return result;
}
std::uint32_t hnsToFrames(REFERENCE_TIME hns, std::uint32_t rate) {
    return static_cast<std::uint32_t>(
        (static_cast<std::uint64_t>(std::max<REFERENCE_TIME>(0, hns)) * rate + 9'999'999ULL) /
        10'000'000ULL);
}
REFERENCE_TIME framesToHns(std::uint32_t frames, std::uint32_t rate) {
    return static_cast<REFERENCE_TIME>(
        (static_cast<std::uint64_t>(frames) * 10'000'000ULL + rate - 1U) / rate);
}
std::uint32_t currentSharedPeriod(IAudioClient* client, std::uint32_t fallback) noexcept;
std::uint32_t initializeSharedClient(IAudioClient* client, const WAVEFORMATEX* format, DWORD flags,
                                     std::uint32_t requestedPeriod,
                                     SharedPeriodInfo* info = nullptr) {
    if (info)
        info->requested = requestedPeriod;
    ComPtr<IAudioClient3> client3;
    if (SUCCEEDED(client->QueryInterface(IID_PPV_ARGS(&client3)))) {
        if (info)
            info->client3Available = true;
        if (const auto periods = sharedPeriods(client3.Get(), format)) {
            if (info) {
                info->normal = periods->normal;
                info->fundamental = periods->fundamental;
                info->minimum = periods->minimum;
                info->maximum = periods->maximum;
            }
            const auto fundamental = periods->fundamental;
            const auto lower = periods->minimum / fundamental;
            const auto upper = periods->maximum / fundamental;
            const auto steps =
                (static_cast<std::uint64_t>(requestedPeriod) + fundamental - 1) / fundamental;
            auto selected =
                static_cast<UINT32>(std::clamp<std::uint64_t>(steps, lower, upper) * fundamental);
            auto result = client3->InitializeSharedAudioStream(audioClient3Flags(flags), selected,
                                                               format, nullptr);
            UINT32 fallback = 0;
            if (result == AUDCLNT_E_ENGINE_PERIODICITY_LOCKED) {
                if (info)
                    info->locked = true;
                // Other clients can lock the engine period. Join its actual period instead of
                // failing a supported device or advertising the original low-latency request.
                fallback = currentSharedPeriod(client, 0);
            } else if (result == AUDCLNT_E_CPUUSAGE_EXCEEDED && selected < periods->normal) {
                if (info)
                    info->cpuFallback = true;
                // The driver minimum is not necessarily usable with the engine's active APOs.
                fallback = periods->normal;
            }
            if (fallback != 0 && fallback != selected) {
                selected = fallback;
                result = client3->InitializeSharedAudioStream(audioClient3Flags(flags), selected,
                                                              format, nullptr);
            }
            check(result, "shared stream initialize failed");
            if (info)
                info->actual = selected;
            return selected;
        }
    }
    // Legacy shared mode selects the engine's period; requested duration sizes buffering only.
    REFERENCE_TIME normal = 0, minimum = 0;
    check(client->GetDevicePeriod(&normal, &minimum), "shared engine period unavailable");
    check(client->Initialize(AUDCLNT_SHAREMODE_SHARED, flags,
                             framesToHns(requestedPeriod, format->nSamplesPerSec), 0, format,
                             nullptr),
          "shared stream initialize failed");
    const auto actual = hnsToFrames(normal, format->nSamplesPerSec);
    if (info) {
        info->normal = actual;
        info->minimum = hnsToFrames(minimum, format->nSamplesPerSec);
        info->actual = actual;
    }
    return actual;
}
void addUniqueRate(std::vector<std::uint32_t>& rates, std::uint32_t rate) {
    if (rate != 0 && std::find(rates.begin(), rates.end(), rate) == rates.end())
        rates.push_back(rate);
}
std::uint32_t currentSharedPeriod(IAudioClient* client, std::uint32_t fallback) noexcept {
    ComPtr<IAudioClient3> client3;
    if (FAILED(client->QueryInterface(IID_PPV_ARGS(&client3))))
        return fallback;
    WAVEFORMATEX* format = nullptr;
    UINT32 period = 0;
    if (FAILED(client3->GetCurrentSharedModeEnginePeriod(&format, &period)))
        return fallback;
    if (format != nullptr)
        CoTaskMemFree(format);
    return period == 0 ? fallback : period;
}
// Exclusive mode accepts endpoint-native layouts. Preserve the exact PCM/float subtype, bit depth,
// channel mask and valid-bit count reported by Windows instead of guessing a list of formats.
WAVEFORMATEX* exclusiveFormatFor(IAudioClient* client, const WAVEFORMATEX* native,
                                 const WAVEFORMATEX* mix, std::uint32_t requestedRate) {
    const std::array bases{native, mix};
    for (const auto* base : bases) {
        if (base == nullptr)
            continue;
        const std::array rates{requestedRate, static_cast<std::uint32_t>(base->nSamplesPerSec)};
        for (const auto rate : rates) {
            if (rate == 0)
                continue;
            const auto bytes = WasapiPcm::copyWithSampleRate(base, rate);
            if (bytes.empty())
                continue;
            const auto* format = reinterpret_cast<const WAVEFORMATEX*>(bytes.data());
            if (client->IsFormatSupported(AUDCLNT_SHAREMODE_EXCLUSIVE, format, nullptr) == S_OK) {
                auto* result = static_cast<WAVEFORMATEX*>(CoTaskMemAlloc(bytes.size()));
                if (result != nullptr)
                    std::memcpy(result, bytes.data(), bytes.size());
                return result;
            }
        }
    }
    return nullptr;
}
void initializeExclusiveClient(ComPtr<IAudioClient>& client, IMMDevice* device,
                               const WAVEFORMATEX* format, std::uint32_t requestedPeriod,
                               DWORD flags, const char* message) {
    REFERENCE_TIME defaultPeriod = 0, minimumPeriod = 0;
    check(client->GetDevicePeriod(&defaultPeriod, &minimumPeriod), message);
    auto duration = std::max(framesToHns(requestedPeriod, format->nSamplesPerSec), minimumPeriod);
    auto hr =
        client->Initialize(AUDCLNT_SHAREMODE_EXCLUSIVE, flags, duration, duration, format, nullptr);
    if (hr == AUDCLNT_E_BUFFER_SIZE_NOT_ALIGNED) {
        // The device wants a hardware-aligned buffer: re-open the client with the size it reported.
        UINT32 alignedFrames = 0;
        check(client->GetBufferSize(&alignedFrames), message);
        client.Reset();
        check(device->Activate(__uuidof(IAudioClient), CLSCTX_ALL, nullptr, &client), message);
        duration = framesToHns(alignedFrames, format->nSamplesPerSec);
        hr = client->Initialize(AUDCLNT_SHAREMODE_EXCLUSIVE, flags, duration, duration, format,
                                nullptr);
    }
    check(hr, message);
}
} // namespace

struct WasapiBackend::Impl {
    Impl(WasapiMode value, DeviceFactory factory)
        : mode(value), deviceFactory(std::move(factory)) {}
    WasapiMode mode;
    DeviceFactory deviceFactory;
    bool comInitialized{false};
    ComPtr<IMMDeviceEnumerator> enumerator;
    ComPtr<IMMDevice> inputDevice, outputDevice;
    // Windows' volume of the output endpoint. It scales Shared and Exclusive output (as hardware
    // volume on most interfaces) but not ASIO, so it explains a mode sounding quieter than ASIO.
    ComPtr<IAudioEndpointVolume> outputVolume;
    ComPtr<IAudioClient> inputClient, outputClient;
    ComPtr<IAudioCaptureClient> capture;
    ComPtr<IAudioRenderClient> render;
    ComPtr<IAudioClock> renderClock;
    UINT64 renderClockFrequency{0};
    UINT64 submittedRenderFrames{0};
    WAVEFORMATEX* inputFormat{nullptr};
    WAVEFORMATEX* outputFormat{nullptr};
    HANDLE captureEvent{nullptr}, renderEvent{nullptr}, stopEvent{nullptr};
    HANDLE captureDeadline{nullptr};
    MonotonicTicks lastCaptureAt{0};
    std::thread thread;
    std::atomic<bool> running{false};
    IAudioCallback* callback{nullptr};
    GenerationId generation{0};
    RuntimeConfiguration runtime{};
    std::vector<float> captureScratch, renderScratch;
    std::atomic<std::uint32_t> padding{0};
    std::atomic<std::uint64_t> xruns{0}, deadlineMisses{0}, renderClockSkipFrames{0},
        renderClockRebaseFrames{0}, renderStarvedFrames{0};
    std::atomic<std::uint64_t> outputNonzeroBlocks{0};
    std::atomic<std::uint64_t> captureDiscontinuities{0};
    std::atomic<float> outputPeak{0.0F};
    // Shared queue depth grows on starvation and recovers during silence (render thread only).
    std::uint32_t sharedPeriods{1};
    std::uint64_t silentRenderFrames{0};
    std::atomic<bool> inputRaw{false}, outputRaw{false}; // streams bypassing Windows processing
    SharedPeriodInfo outputSharedPeriod{};
    std::atomic<std::uint32_t> renderQueueFramesNow{0};
    WasapiPcm::RecentMeasurements renderPaddingSamples, captureEventGapSamples,
        capturePacketGapSamples, renderEventGapSamples, duplexWaitSamples, renderCallbackSamples;
    MonotonicTicks lastCaptureEventAt{0}, lastRenderEventAt{0};
    std::uint64_t lastCapturePacketQpc{0};
    std::uint64_t starveWindowQpc{0}, starveWindowPosition{0};
    bool exclusiveCapture{false}; // capture opened exclusively (render period), not shared
    std::atomic<bool> mmcss{false};

    void initCom() {
        const auto hr = CoInitializeEx(nullptr, COINIT_MULTITHREADED);
        if (SUCCEEDED(hr))
            comInitialized = true;
        else if (hr != RPC_E_CHANGED_MODE)
            check(hr, "COM initialization failed");
        if (deviceFactory)
            return;
        check(CoCreateInstance(__uuidof(MMDeviceEnumerator), nullptr, CLSCTX_ALL,
                               IID_PPV_ARGS(&enumerator)),
              "MMDeviceEnumerator failed");
    }
    void releaseFormats() noexcept {
        if (inputFormat) {
            CoTaskMemFree(inputFormat);
            inputFormat = nullptr;
        }
        if (outputFormat) {
            CoTaskMemFree(outputFormat);
            outputFormat = nullptr;
        }
    }
    void releaseEvents() noexcept {
        if (captureEvent) {
            CloseHandle(captureEvent);
            captureEvent = nullptr;
        }
        if (renderEvent) {
            CloseHandle(renderEvent);
            renderEvent = nullptr;
        }
        if (stopEvent) {
            CloseHandle(stopEvent);
            stopEvent = nullptr;
        }
        if (captureDeadline) {
            CloseHandle(captureDeadline);
            captureDeadline = nullptr;
        }
    }
    /** 0..1 (0 when muted), or -1 when Windows does not expose a volume for the endpoint. */
    [[nodiscard]] float endpointVolume() const noexcept {
        float level = -1.0F;
        BOOL muted = FALSE;
        if (!outputVolume || FAILED(outputVolume->GetMasterVolumeLevelScalar(&level)))
            return -1.0F;
        return SUCCEEDED(outputVolume->GetMute(&muted)) && muted ? 0.0F : level;
    }

    void closeAll() noexcept {
        running.store(false, std::memory_order_release);
        if (stopEvent)
            SetEvent(stopEvent);
        if (thread.joinable())
            thread.join();
        if (inputClient)
            inputClient->Stop();
        if (outputClient)
            outputClient->Stop();
        capture.Reset();
        render.Reset();
        renderClock.Reset();
        renderClockFrequency = 0;
        submittedRenderFrames = 0;
        sharedPeriods = 1;
        silentRenderFrames = 0;
        inputRaw.store(false, std::memory_order_relaxed);
        outputRaw.store(false, std::memory_order_relaxed);
        outputSharedPeriod = {};
        captureDiscontinuities.store(0, std::memory_order_relaxed);
        starveWindowQpc = 0;
        renderPaddingSamples.reset();
        captureEventGapSamples.reset();
        capturePacketGapSamples.reset();
        renderEventGapSamples.reset();
        duplexWaitSamples.reset();
        renderCallbackSamples.reset();
        lastCaptureEventAt = lastRenderEventAt = 0;
        lastCapturePacketQpc = 0;
        lastCaptureAt = 0;
        exclusiveCapture = false;
        inputClient.Reset();
        outputClient.Reset();
        inputDevice.Reset();
        outputDevice.Reset();
        outputVolume.Reset();
        releaseFormats();
        releaseEvents();
        enumerator.Reset();
        if (comInitialized) {
            CoUninitialize();
            comInitialized = false;
        }
        runtime = {};
        callback = nullptr;
    }

    ComPtr<IMMDevice> selectDevice(Direction direction, const std::string& id,
                                   bool allowMissingDefault = false) {
        if (!deviceFactory)
            return deviceFor(enumerator.Get(), direction == Direction::Input ? eCapture : eRender,
                             id, allowMissingDefault);
        ComPtr<IMMDevice> result;
        result.Attach(deviceFactory(direction, id));
        if (!result && !(allowMissingDefault && id.empty()))
            throw std::runtime_error("selected endpoint unavailable");
        return result;
    }

    void openEndpoints(const RequestedConfiguration& requested) {
        outputDevice = selectDevice(Direction::Output, requested.outputDeviceId);
        if (FAILED(outputDevice->Activate(__uuidof(IAudioEndpointVolume), CLSCTX_ALL, nullptr,
                                          &outputVolume)))
            outputVolume.Reset();
        inputDevice = selectDevice(Direction::Input, requested.inputDeviceId,
                                   requested.inputDeviceId.empty());
        check(outputDevice->Activate(__uuidof(IAudioClient), CLSCTX_ALL, nullptr, &outputClient),
              "render client activation failed");
        if (mode == WasapiMode::Shared)
            outputRaw.store(configureSharedMediaClient(outputClient.Get(), outputDevice.Get()),
                            std::memory_order_relaxed);
        check(outputClient->GetMixFormat(&outputFormat), "render format failed");
        if (inputDevice) {
            check(inputDevice->Activate(__uuidof(IAudioClient), CLSCTX_ALL, nullptr, &inputClient),
                  "capture client activation failed");
            inputRaw.store(configureSharedMediaClient(inputClient.Get(), inputDevice.Get()),
                           std::memory_order_relaxed);
            check(inputClient->GetMixFormat(&inputFormat), "capture format failed");
        }
    }

    void initializeSharedCapture(DWORD flags, std::uint32_t requestedPeriod,
                                 std::uint32_t& inputPeriod) {
        if (!inputClient) {
            inputPeriod = 0;
            return;
        }
        inputPeriod =
            initializeSharedClient(inputClient.Get(), inputFormat, flags, requestedPeriod);
    }

    void initializeSharedRender(DWORD flags, std::uint32_t requestedPeriod,
                                std::uint32_t& outputPeriod) {
        outputPeriod = initializeSharedClient(outputClient.Get(), outputFormat, flags,
                                              requestedPeriod, &outputSharedPeriod);
    }

    void initializeShared(DWORD flags, std::uint32_t requestedPeriod, std::uint32_t& inputPeriod,
                          std::uint32_t& outputPeriod) {
        initializeSharedCapture(flags, requestedPeriod, inputPeriod);
        initializeSharedRender(flags, requestedPeriod, outputPeriod);
    }

    // Exclusive capture at the render rate and period: a shared capture engine period (10 ms on
    // many interfaces) plus the clock bridge it fills in bursts delays every sung note by ~15 ms.
    // Any device that refuses it keeps the shared capture path.
    [[nodiscard]] bool initializeExclusiveCapture(DWORD flags, std::uint32_t requestedPeriod,
                                                  std::uint32_t& inputPeriod) {
        const auto nativeBytes = endpointNativeFormat(inputDevice.Get());
        const auto* native = nativeBytes.empty()
                                 ? nullptr
                                 : reinterpret_cast<const WAVEFORMATEX*>(nativeBytes.data());
        auto* inputNative = exclusiveFormatFor(inputClient.Get(), native, inputFormat,
                                               outputFormat->nSamplesPerSec);
        if (inputNative == nullptr)
            return false;
        try {
            initializeExclusiveClient(inputClient, inputDevice.Get(), inputNative, requestedPeriod,
                                      flags, "exclusive capture initialize failed");
        } catch (const std::exception&) {
            CoTaskMemFree(inputNative);
            inputClient.Reset();
            check(inputDevice->Activate(__uuidof(IAudioClient), CLSCTX_ALL, nullptr, &inputClient),
                  "capture client activation failed");
            inputRaw.store(configureSharedMediaClient(inputClient.Get(), inputDevice.Get()),
                           std::memory_order_relaxed);
            return false;
        }
        CoTaskMemFree(inputFormat);
        inputFormat = inputNative;
        exclusiveCapture = true;
        UINT32 bufferFrames = 0;
        check(inputClient->GetBufferSize(&bufferFrames), "capture buffer size failed");
        inputPeriod = bufferFrames;
        return true;
    }

    void initializeExclusive(DWORD flags, const RequestedConfiguration& requested,
                             std::uint32_t& inputPeriod) {
        const auto nativeBytes = endpointNativeFormat(outputDevice.Get());
        const auto* native = nativeBytes.empty()
                                 ? nullptr
                                 : reinterpret_cast<const WAVEFORMATEX*>(nativeBytes.data());
        auto* outputNative =
            exclusiveFormatFor(outputClient.Get(), native, outputFormat, requested.sampleRateHz);
        if (outputNative == nullptr) {
            CoTaskMemFree(outputNative);
            throw std::runtime_error("exclusive mode: the device supports no usable PCM format");
        }
        CoTaskMemFree(outputFormat);
        outputFormat = outputNative;
        initializeExclusiveClient(outputClient, outputDevice.Get(), outputFormat,
                                  requested.periodFrames, flags,
                                  "exclusive render initialize failed");
        if (!inputClient)
            inputPeriod = 0;
        else if (!initializeExclusiveCapture(flags, requested.periodFrames, inputPeriod))
            initializeSharedCapture(flags, requested.periodFrames, inputPeriod);
    }

    // A shared endpoint buffer holds about two engine periods, but the engine consumes one period
    // per pass. Queued render PCM is latency, so shared mode keeps one period queued; an exclusive
    // endpoint buffer is exactly one device period and is always filled whole.
    std::uint32_t renderQueueFrames(std::uint32_t bufferFrames) const noexcept {
        return mode == WasapiMode::Shared
                   ? std::min(bufferFrames, runtime.outputPeriodFrames * sharedPeriods)
                   : bufferFrames;
    }

    // Event-driven streams need one silent period queued before Start(); without it exclusive
    // endpoints stall.
    void prefillRender() {
        UINT32 bufferFrames = 0;
        BYTE* data = nullptr;
        check(outputClient->GetBufferSize(&bufferFrames), "render prefill size failed");
        const auto frames = renderQueueFrames(bufferFrames);
        check(render->GetBuffer(frames, &data), "render prefill buffer failed");
        check(render->ReleaseBuffer(frames, AUDCLNT_BUFFERFLAGS_SILENT),
              "render prefill submit failed");
        submittedRenderFrames += frames;
    }

    void prepareEventsAndServices() {
        captureEvent = CreateEventW(nullptr, FALSE, FALSE, nullptr);
        renderEvent = CreateEventW(nullptr, FALSE, FALSE, nullptr);
        stopEvent = CreateEventW(nullptr, TRUE, FALSE, nullptr);
        if (!captureEvent || !renderEvent || !stopEvent)
            throw std::runtime_error("WASAPI event creation failed");
        check(outputClient->SetEventHandle(renderEvent), "render event registration failed");
        check(outputClient->GetService(IID_PPV_ARGS(&render)), "render service failed");
        if (inputClient) {
            check(inputClient->SetEventHandle(captureEvent), "capture event registration failed");
            check(inputClient->GetService(IID_PPV_ARGS(&capture)), "capture service failed");
            if (mode == WasapiMode::Shared)
                captureDeadline = CreateWaitableTimerExW(
                    nullptr, nullptr, CREATE_WAITABLE_TIMER_HIGH_RESOLUTION, TIMER_ALL_ACCESS);
        }
        (void)outputClient->GetService(IID_PPV_ARGS(&renderClock));
        if (renderClock)
            check(renderClock->GetFrequency(&renderClockFrequency),
                  "render clock frequency failed");
    }

    RuntimeConfiguration readRuntime(const RequestedConfiguration& requested,
                                     std::uint32_t inputPeriod, std::uint32_t outputPeriod) {
        UINT32 inputBuffer = 0, outputBuffer = 0;
        check(outputClient->GetBufferSize(&outputBuffer), "render buffer size failed");
        REFERENCE_TIME inputLatency = 0, outputLatency = 0;
        check(outputClient->GetStreamLatency(&outputLatency), "render latency query failed");
        if (inputClient) {
            check(inputClient->GetBufferSize(&inputBuffer), "capture buffer size failed");
            check(inputClient->GetStreamLatency(&inputLatency), "capture latency query failed");
        }

        if (inputClient && !exclusiveCapture)
            inputPeriod = currentSharedPeriod(inputClient.Get(), inputPeriod);
        if (mode == WasapiMode::Shared) {
            outputPeriod = currentSharedPeriod(outputClient.Get(), outputPeriod);
            outputSharedPeriod.actual = outputPeriod;
        } else {
            outputPeriod = outputBuffer;
        }
        if (inputClient && inputPeriod == 0)
            inputPeriod = std::min(inputBuffer, requested.periodFrames);
        if (outputPeriod == 0)
            outputPeriod = std::min(outputBuffer, requested.periodFrames);
        if (!inputClient)
            inputPeriod = outputPeriod;

        const auto* captureFormat = inputFormat != nullptr ? inputFormat : outputFormat;
        runtime = {captureFormat->nSamplesPerSec,
                   outputFormat->nSamplesPerSec,
                   inputPeriod,
                   outputPeriod,
                   inputBuffer,
                   outputBuffer,
                   inputFormat != nullptr ? static_cast<std::uint32_t>(inputFormat->nChannels) : 0U,
                   outputFormat->nChannels,
                   WasapiPcm::sampleFormat(captureFormat),
                   WasapiPcm::sampleFormat(outputFormat),
                   inputDevice.Get() == outputDevice.Get() ? ClockRelationship::SameDomain
                                                           : ClockRelationship::Independent,
                   hnsToFrames(inputLatency, captureFormat->nSamplesPerSec),
                   hnsToFrames(outputLatency, outputFormat->nSamplesPerSec)};
        captureScratch.assign(static_cast<std::size_t>(MaxBlockFrames) * runtime.inputChannels,
                              0.0F);
        renderScratch.assign(static_cast<std::size_t>(MaxBlockFrames) * runtime.outputChannels,
                             0.0F);
        return runtime;
    }

    bool streamSucceeded(HRESULT result) noexcept {
        if (SUCCEEDED(result))
            return true;
        xruns.fetch_add(1, std::memory_order_relaxed);
        // A temporarily unavailable packet is retried on the next event. Other stream errors
        // need a new session, including invalidated devices and a stopped Windows audio service.
        if (result != AUDCLNT_E_BUFFER_ERROR && result != AUDCLNT_E_BUFFER_OPERATION_PENDING &&
            running.exchange(false, std::memory_order_acq_rel))
            callback->onBackendEvent(generation, BackendEventType::DeviceLost,
                                     static_cast<std::int32_t>(result));
        return false;
    }

    void processCapture() noexcept {
        if (!capture || !callback)
            return;
        UINT32 packet = 0;
        std::uint64_t processed = 0;
        while (processed < runtime.inputEndpointBufferFrames &&
               streamSucceeded(capture->GetNextPacketSize(&packet)) && packet != 0) {
            BYTE* data = nullptr;
            UINT32 frames = 0;
            DWORD flags = 0;
            UINT64 position = 0, qpc = 0;
            const auto hr = capture->GetBuffer(&data, &frames, &flags, &position, &qpc);
            if (!streamSucceeded(hr) || hr == AUDCLNT_S_BUFFER_EMPTY || frames == 0)
                return;
            if (qpc != 0 && lastCapturePacketQpc != 0 && qpc > lastCapturePacketQpc)
                capturePacketGapSamples.observe(static_cast<std::uint32_t>(
                    (qpc - lastCapturePacketQpc) / 10));
            lastCapturePacketQpc = qpc;
            if ((flags & AUDCLNT_BUFFERFLAGS_DATA_DISCONTINUITY) != 0) {
                captureDiscontinuities.fetch_add(1, std::memory_order_relaxed);
                callback->onBackendEvent(generation, BackendEventType::DataDiscontinuity,
                                         static_cast<std::int32_t>(flags));
            }
            if ((flags & AUDCLNT_BUFFERFLAGS_TIMESTAMP_ERROR) != 0)
                callback->onBackendEvent(generation, BackendEventType::TimestampError,
                                         static_cast<std::int32_t>(flags));
            std::uint32_t offset = 0;
            while (offset < frames) {
                const auto chunk = std::min<std::uint32_t>(MaxBlockFrames, frames - offset);
                auto* target = captureScratch.data();
                const auto* src =
                    data ? data + static_cast<std::size_t>(offset) * inputFormat->nBlockAlign
                         : nullptr;
                WasapiPcm::toFloat(src, target, chunk, inputFormat,
                                   (flags & AUDCLNT_BUFFERFLAGS_SILENT) != 0 || src == nullptr);
                const auto packetTicks =
                    static_cast<MonotonicTicks>(qpc + static_cast<std::uint64_t>(offset) *
                                                          10'000'000 / inputFormat->nSamplesPerSec);
                callback->onCapture(generation,
                                    {target, nullptr, chunk, inputFormat->nChannels,
                                     static_cast<std::int64_t>(position + offset), packetTicks,
                                     flags, 0, WasapiPcm::captureTicksFromQpc(packetTicks)});
                offset += chunk;
            }
            if (!streamSucceeded(capture->ReleaseBuffer(frames)))
                return;
            lastCaptureAt = monotonicTicksNow();
            processed += frames;
        }
    }
    void processRender() noexcept {
        if (!render || !outputClient || !callback)
            return;
        UINT32 bufferFrames = 0, pad = 0;
        if (!streamSucceeded(outputClient->GetBufferSize(&bufferFrames)))
            return;
        // Event-driven exclusive mode has no partial fills: every event asks for the whole buffer.
        if (mode == WasapiMode::Shared && !streamSucceeded(outputClient->GetCurrentPadding(&pad)))
            return;
        padding.store(pad, std::memory_order_relaxed);
        if (mode == WasapiMode::Shared)
            renderPaddingSamples.observe(pad);
        if (pad > bufferFrames) {
            (void)streamSucceeded(E_UNEXPECTED);
            return;
        }
        const auto queueFrames = renderQueueFrames(bufferFrames);
        if (pad >= queueFrames)
            return;
        if (captureDeadline) {
            // Duplex events can arrive in either order. Give the matching capture event up to
            // one quarter of the shorter negotiated period, then render even if capture stalls.
            // This is an interruptible event wait before acquiring any PCM buffer, not a sleep
            // or polling loop in the audio callback. Older systems without a precise timer skip it.
            const auto capturePeriod = static_cast<std::uint64_t>(runtime.inputPeriodFrames) *
                                       10'000'000 / runtime.inputSampleRateHz;
            const auto renderPeriod = static_cast<std::uint64_t>(runtime.outputPeriodFrames) *
                                      10'000'000 / runtime.outputSampleRateHz;
            LARGE_INTEGER deadline{};
            deadline.QuadPart = -static_cast<LONGLONG>(
                std::max<std::uint64_t>(1, std::min(capturePeriod, renderPeriod) / 4));
            // A packet captured while output was full may be almost a whole period old now.
            // Its presence must not permanently lock monitoring into that older phase.
            if (monotonicTicksNow() - lastCaptureAt >= -deadline.QuadPart * 100 &&
                SetWaitableTimer(captureDeadline, &deadline, 0, nullptr, nullptr, FALSE)) {
                const auto waitedAt = monotonicTicksNow();
                HANDLE events[]{stopEvent, captureEvent, captureDeadline};
                const auto result = WaitForMultipleObjects(3, events, FALSE, INFINITE);
                duplexWaitSamples.observe(static_cast<std::uint32_t>(
                    std::max<MonotonicTicks>(0, monotonicTicksNow() - waitedAt) / 1'000));
                CancelWaitableTimer(captureDeadline);
                if (result == WAIT_OBJECT_0 || !running.load(std::memory_order_acquire))
                    return;
                if (result == WAIT_FAILED) {
                    callback->onBackendEvent(generation, BackendEventType::DeviceLost,
                                             GetLastError());
                    return;
                }
                processCapture();
                if (!running.load(std::memory_order_acquire) ||
                    !streamSucceeded(outputClient->GetCurrentPadding(&pad)))
                    return;
                padding.store(pad, std::memory_order_relaxed);
                if (pad >= queueFrames)
                    return;
            }
        }
        renderQueueFramesNow.store(queueFrames, std::memory_order_relaxed);
        const auto available = queueFrames - pad;
        BYTE* data = nullptr;
        if (!streamSucceeded(render->GetBuffer(available, &data)))
            return;
        UINT64 position = 0, qpc = 0;
        auto presentation =
            monotonicTicksNow() + static_cast<MonotonicTicks>(runtime.outputLatencyFrames) *
                                      1'000'000'000LL / outputFormat->nSamplesPerSec;
        if (renderClock && SUCCEEDED(renderClock->GetPosition(&position, &qpc)) &&
            renderClockFrequency != 0) {
            const auto whole = position / renderClockFrequency;
            const auto remainder = position % renderClockFrequency;
            position = whole * outputFormat->nSamplesPerSec +
                       (remainder * outputFormat->nSamplesPerSec) / renderClockFrequency;
            // IAudioClock reports the sample at the speakers. Count everything submitted,
            // including initial silence; endpoint padding alone omits downstream buffering.
            if (position + pad > submittedRenderFrames) {
                renderClockSkipFrames.fetch_add(position + pad - submittedRenderFrames,
                                                std::memory_order_relaxed);
                submittedRenderFrames = position + pad;
            }
            const auto rebased = WasapiPcm::rebasedRenderSubmission(
                submittedRenderFrames, position, pad, bufferFrames, runtime.outputLatencyFrames);
            if (rebased != submittedRenderFrames) {
                renderClockRebaseFrames.fetch_add(submittedRenderFrames - rebased,
                                                  std::memory_order_relaxed);
                submittedRenderFrames = rebased;
            }
            if (mode == WasapiMode::Shared)
                measureStarvation(position, qpc, bufferFrames);
            presentation = static_cast<MonotonicTicks>(qpc) * 100 +
                           static_cast<MonotonicTicks>(submittedRenderFrames - position) *
                               1'000'000'000LL / outputFormat->nSamplesPerSec;
        }
        // Acquire one native packet. Bounded DSP blocks fill views into it before one submission.
        float packetPeak = 0.0F;
        for (UINT32 offset = 0; offset < available;) {
            const auto chunk = std::min<std::uint32_t>(MaxBlockFrames, available - offset);
            const auto frameOffset = static_cast<std::uint64_t>(pad) + offset;
            const auto callbackAt = monotonicTicksNow();
            callback->onRender(generation,
                               {nullptr, renderScratch.data(), chunk, outputFormat->nChannels,
                                static_cast<std::int64_t>(position + frameOffset),
                                static_cast<MonotonicTicks>(qpc + frameOffset * 10'000'000 /
                                                                      outputFormat->nSamplesPerSec),
                                0,
                                presentation + static_cast<MonotonicTicks>(offset) *
                                                   1'000'000'000LL / outputFormat->nSamplesPerSec});
            renderCallbackSamples.observe(static_cast<std::uint32_t>(
                std::max<MonotonicTicks>(0, monotonicTicksNow() - callbackAt) / 1'000));
            const auto samples = static_cast<std::size_t>(chunk) * outputFormat->nChannels;
            for (std::size_t index = 0; index < samples; ++index)
                packetPeak = std::max(packetPeak, std::abs(renderScratch[index]));
            if (mode == WasapiMode::Shared) {
                const auto silent =
                    std::all_of(renderScratch.begin(), renderScratch.begin() + samples,
                                [](float sample) { return sample == 0.0F; });
                const auto recoveryFrames =
                    static_cast<std::uint64_t>(outputFormat->nSamplesPerSec) * SilentRecoverySeconds;
                silentRenderFrames = silent ? std::min(silentRenderFrames + chunk, recoveryFrames) : 0;
            }
            WasapiPcm::fromFloat(renderScratch.data(),
                                 data +
                                     static_cast<std::size_t>(offset) * outputFormat->nBlockAlign,
                                 chunk, outputFormat);
            offset += chunk;
        }
        if (streamSucceeded(render->ReleaseBuffer(available, 0))) {
            submittedRenderFrames += available;
            if (packetPeak > 0.0F) {
                outputNonzeroBlocks.fetch_add(1, std::memory_order_relaxed);
                auto previous = outputPeak.load(std::memory_order_relaxed);
                while (previous < packetPeak && !outputPeak.compare_exchange_weak(
                                                    previous, packetPeak,
                                                    std::memory_order_relaxed)) {}
            }
        }
    }
    // A window of this many periods judges starvation: one silent period in it is a click every
    // window, which is already audible.
    static constexpr std::uint32_t StarvationWindowPeriods = 100;
    // Retry a shallower queue only after ten seconds of exact silence and stable device progress.
    // Already queued PCM drains normally; no audible samples are discarded to reduce latency.
    static constexpr std::uint32_t SilentRecoverySeconds = 10;
    void measureStarvation(std::uint64_t positionFrames, std::uint64_t qpc100ns,
                           std::uint32_t bufferFrames) noexcept {
        const auto rate = outputFormat->nSamplesPerSec;
        const auto period = std::max(1U, runtime.outputPeriodFrames);
        if (starveWindowQpc == 0 || positionFrames < starveWindowPosition) {
            starveWindowQpc = qpc100ns;
            starveWindowPosition = positionFrames;
            return;
        }
        const auto elapsed = (qpc100ns - starveWindowQpc) * rate / 10'000'000;
        if (elapsed < static_cast<std::uint64_t>(period) * StarvationWindowPeriods)
            return;
        const auto played = positionFrames - starveWindowPosition;
        if (elapsed > played)
            renderStarvedFrames.fetch_add(elapsed - played, std::memory_order_relaxed);
        const auto recovered =
            silentRenderFrames >= static_cast<std::uint64_t>(rate) * SilentRecoverySeconds;
        const auto nextPeriods = WasapiPcm::sharedQueuePeriods(sharedPeriods, bufferFrames / period,
                                                              elapsed, played, period, recovered);
        if (nextPeriods != sharedPeriods || elapsed > played + period)
            silentRenderFrames = 0;
        sharedPeriods = nextPeriods;
        starveWindowQpc = qpc100ns;
        starveWindowPosition = positionFrames;
    }
    void threadMain() noexcept {
        const auto apartment = CoInitializeEx(nullptr, COINIT_MULTITHREADED);
        if (!streamSucceeded(apartment))
            return;
        DWORD taskIndex = 0;
        HANDLE task = AvSetMmThreadCharacteristicsW(L"Pro Audio", &taskIndex);
        mmcss.store(task != nullptr, std::memory_order_relaxed);
        HANDLE handles[3]{stopEvent, captureEvent, renderEvent};
        const auto period = std::chrono::duration<double>(
            static_cast<double>(runtime.outputPeriodFrames) / runtime.outputSampleRateHz);
        while (running.load(std::memory_order_acquire)) {
            const auto waitStarted = std::chrono::steady_clock::now();
            const auto result = WaitForMultipleObjects(3, handles, FALSE, 1000);
            if (result == WAIT_OBJECT_0)
                break;
            if (result == WAIT_TIMEOUT) {
                UINT32 unused = 0;
                if (!streamSucceeded(outputClient->GetBufferSize(&unused)) ||
                    (capture && !streamSucceeded(capture->GetNextPacketSize(&unused))))
                    break;
                continue;
            }
            if (result != WAIT_OBJECT_0 + 1 && result != WAIT_OBJECT_0 + 2) {
                callback->onBackendEvent(generation, BackendEventType::DeviceLost, GetLastError());
                break;
            }
            const auto callbackStarted = std::chrono::steady_clock::now();
            const auto renderReady =
                result == WAIT_OBJECT_0 + 2 || WaitForSingleObject(renderEvent, 0) == WAIT_OBJECT_0;
            const auto eventAt = monotonicTicksNow();
            const auto noteGap = [eventAt](MonotonicTicks& previous,
                                            WasapiPcm::RecentMeasurements& samples) {
                if (previous != 0 && eventAt > previous)
                    samples.observe(static_cast<std::uint32_t>((eventAt - previous) / 1'000));
                previous = eventAt;
            };
            const auto coalescedCapture = result != WAIT_OBJECT_0 + 1 &&
                                          WaitForSingleObject(captureEvent, 0) == WAIT_OBJECT_0;
            if (result == WAIT_OBJECT_0 + 1 || coalescedCapture)
                noteGap(lastCaptureEventAt, captureEventGapSamples);
            if (renderReady)
                noteGap(lastRenderEventAt, renderEventGapSamples);
            // An available capture packet may precede its event. Drain it before filling this
            // render period, otherwise monitoring waits an unnecessary whole engine period.
            // Capture work is bounded by the endpoint capacity, so render cannot be starved.
            processCapture();
            // Shared padding is authoritative: a capture wake may expose writable output
            // before the render event arrives. Exclusive still requires its own event.
            if (running.load(std::memory_order_acquire) &&
                (renderReady || mode == WasapiMode::Shared))
                processRender();
            if (WasapiPcm::eventCallbackMissedDeadline(
                    waitStarted, callbackStarted, std::chrono::steady_clock::now(),
                    std::chrono::duration_cast<std::chrono::steady_clock::duration>(period)))
                deadlineMisses.fetch_add(1, std::memory_order_relaxed);
        }
        if (task)
            AvRevertMmThreadCharacteristics(task);
        mmcss.store(false, std::memory_order_relaxed);
        CoUninitialize();
    }
};

WasapiBackend::WasapiBackend(WasapiMode mode, DeviceFactory factory)
    : impl_(std::make_unique<Impl>(mode, std::move(factory))) {}
WasapiBackend::~WasapiBackend() {
    impl_->closeAll();
}
std::string_view WasapiBackend::name() const noexcept {
    return impl_->mode == WasapiMode::Shared ? "WASAPI Shared" : "WASAPI Exclusive";
}
AudioDeviceCapabilities WasapiBackend::queryCapabilities(const RequestedConfiguration& requested) {
    if (!impl_->enumerator && !impl_->comInitialized)
        impl_->initCom();
    auto out = impl_->selectDevice(Direction::Output, requested.outputDeviceId);
    auto in = impl_->selectDevice(Direction::Input, requested.inputDeviceId,
                                  requested.inputDeviceId.empty());
    ComPtr<IAudioClient> inClient, outClient;
    check(out->Activate(__uuidof(IAudioClient), CLSCTX_ALL, nullptr, &outClient),
          "render client activation failed");
    if (in)
        check(in->Activate(__uuidof(IAudioClient), CLSCTX_ALL, nullptr, &inClient),
              "capture client activation failed");
    if (impl_->mode == WasapiMode::Shared)
        configureSharedMediaClient(outClient.Get(), out.Get());
    if (inClient)
        configureSharedMediaClient(inClient.Get(), in.Get());
    const auto inputFormat =
        inClient ? mixFormat(inClient.Get()) : OwnedWaveFormat(nullptr, &CoTaskMemFree);
    const auto outputFormat = mixFormat(outClient.Get());
    const auto* outFmt = outputFormat.get();
    const auto nativeBytes = impl_->mode == WasapiMode::Exclusive ? endpointNativeFormat(out.Get())
                                                                  : std::vector<std::byte>{};
    const auto* selectedFormat =
        nativeBytes.empty() ? outFmt : reinterpret_cast<const WAVEFORMATEX*>(nativeBytes.data());
    AudioDeviceCapabilities caps;
    caps.sampleRatesHz.clear();
    addUniqueRate(caps.sampleRatesHz, selectedFormat->nSamplesPerSec);
    if (impl_->mode == WasapiMode::Exclusive && requested.sampleRateHz != 0) {
        for (const auto* base : std::array{selectedFormat, outFmt}) {
            const auto bytes = WasapiPcm::copyWithSampleRate(base, requested.sampleRateHz);
            if (bytes.empty())
                continue;
            const auto* format = reinterpret_cast<const WAVEFORMATEX*>(bytes.data());
            if (WasapiPcm::sampleFormat(format) != AudioSampleFormat::Unknown &&
                outClient->IsFormatSupported(AUDCLNT_SHAREMODE_EXCLUSIVE, format, nullptr) == S_OK)
                addUniqueRate(caps.sampleRatesHz, requested.sampleRateHz);
        }
    }
    caps.defaultSampleRateHz = selectedFormat->nSamplesPerSec;
    const auto outputSampleFormat = WasapiPcm::sampleFormat(selectedFormat);
    if (outputSampleFormat != AudioSampleFormat::Unknown)
        caps.formats.push_back(outputSampleFormat);
    caps.inputChannels = inputFormat ? inputFormat->nChannels : 0;
    caps.outputChannels = selectedFormat->nChannels;
    REFERENCE_TIME defaultPeriod = 0, minPeriod = 0;
    check(outClient->GetDevicePeriod(&defaultPeriod, &minPeriod), "endpoint periods unavailable");
    caps.defaultPeriodFrames = hnsToFrames(defaultPeriod, selectedFormat->nSamplesPerSec);
    caps.minPeriodFrames = std::max(1U, hnsToFrames(minPeriod, selectedFormat->nSamplesPerSec));
    caps.maxPeriodFrames = std::max(caps.defaultPeriodFrames, caps.minPeriodFrames);
    caps.fundamentalPeriodFrames = 1;
    if (impl_->mode == WasapiMode::Shared) {
        caps.minPeriodFrames = caps.maxPeriodFrames = caps.defaultPeriodFrames;
        ComPtr<IAudioClient3> output3;
        if (SUCCEEDED(outClient.As(&output3))) {
            if (const auto periods = sharedPeriods(output3.Get(), outFmt)) {
                // Automatic monitoring chooses a driver-supported minimum. Explicit user periods
                // remain available; this recommendation is never reported as the actual period.
                caps.defaultPeriodFrames = periods->minimum;
                caps.minPeriodFrames = periods->minimum;
                caps.maxPeriodFrames = periods->maximum;
                caps.fundamentalPeriodFrames = periods->fundamental;
            }
        }
        for (std::uint64_t frames = caps.minPeriodFrames; frames <= caps.maxPeriodFrames;
             frames += caps.fundamentalPeriodFrames)
            caps.periodFrames.push_back(static_cast<std::uint32_t>(frames));
    } else {
        caps.periodFrames.push_back(caps.minPeriodFrames);
        if (caps.defaultPeriodFrames != caps.minPeriodFrames)
            caps.periodFrames.push_back(caps.defaultPeriodFrames);
    }
    return caps;
}
RuntimeConfiguration WasapiBackend::open(const RequestedConfiguration& requested) {
    impl_->closeAll();
    impl_->outputNonzeroBlocks.store(0, std::memory_order_relaxed);
    impl_->outputPeak.store(0.0F, std::memory_order_relaxed);
    impl_->initCom();
    impl_->openEndpoints(requested);

    constexpr DWORD Flags = AUDCLNT_STREAMFLAGS_EVENTCALLBACK | AUDCLNT_STREAMFLAGS_NOPERSIST;
    auto inputPeriod = requested.periodFrames;
    auto outputPeriod = requested.periodFrames;
    if (impl_->mode == WasapiMode::Shared)
        impl_->initializeShared(Flags, requested.periodFrames, inputPeriod, outputPeriod);
    else
        impl_->initializeExclusive(Flags, requested, inputPeriod);

    impl_->prepareEventsAndServices();
    return impl_->readRuntime(requested, inputPeriod, outputPeriod);
}
void WasapiBackend::start(IAudioCallback& callback, GenerationId generation) {
    if (impl_->thread.joinable())
        throw std::logic_error("WASAPI backend is already started");
    if (!impl_->outputClient)
        throw std::logic_error("WASAPI backend is not open");
    impl_->callback = &callback;
    impl_->generation = generation;
    impl_->lastCaptureAt = 0;
    ResetEvent(impl_->stopEvent);
    try {
        impl_->prefillRender();
        impl_->running.store(true, std::memory_order_release);
        impl_->thread = std::thread(&Impl::threadMain, impl_.get());
        check(impl_->outputClient->Start(), "render start failed");
        if (impl_->inputClient)
            check(impl_->inputClient->Start(), "capture start failed");
    } catch (...) {
        stop();
        throw;
    }
}
void WasapiBackend::stop() noexcept {
    impl_->running.store(false, std::memory_order_release);
    if (impl_->stopEvent)
        SetEvent(impl_->stopEvent);
    if (impl_->thread.joinable())
        impl_->thread.join();
    if (impl_->inputClient)
        impl_->inputClient->Stop();
    if (impl_->outputClient)
        impl_->outputClient->Stop();
    impl_->callback = nullptr;
}
void WasapiBackend::close() noexcept {
    impl_->closeAll();
}
BackendSnapshot WasapiBackend::snapshot() const noexcept {
    BackendSnapshot result{impl_->outputClient != nullptr,
            impl_->running.load(std::memory_order_relaxed),
            impl_->padding.load(std::memory_order_relaxed),
            impl_->xruns.load(std::memory_order_relaxed),
            impl_->deadlineMisses.load(std::memory_order_relaxed),
            impl_->mmcss.load(std::memory_order_relaxed),
            impl_->renderClockSkipFrames.load(std::memory_order_relaxed),
            impl_->renderClockRebaseFrames.load(std::memory_order_relaxed),
            impl_->endpointVolume(),
            impl_->renderStarvedFrames.load(std::memory_order_relaxed),
            impl_->renderQueueFramesNow.load(std::memory_order_relaxed),
            impl_->inputRaw.load(std::memory_order_relaxed),
            impl_->outputRaw.load(std::memory_order_relaxed),
            impl_->outputNonzeroBlocks.load(std::memory_order_relaxed),
            impl_->outputPeak.load(std::memory_order_relaxed)};
    const auto copy = [](WasapiPcm::MeasurementQuantiles source) {
        return BackendSnapshot::Quantiles{source.count, source.p50, source.p95, source.p99,
                                          source.maximum};
    };
    result.renderPaddingStats = copy(impl_->renderPaddingSamples.snapshot());
    result.captureEventGapStats = copy(impl_->captureEventGapSamples.snapshot());
    result.capturePacketGapStats = copy(impl_->capturePacketGapSamples.snapshot());
    result.renderEventGapStats = copy(impl_->renderEventGapSamples.snapshot());
    result.duplexWaitStats = copy(impl_->duplexWaitSamples.snapshot());
    result.renderCallbackStats = copy(impl_->renderCallbackSamples.snapshot());
    const auto& period = impl_->outputSharedPeriod;
    result.sharedClient3Available = period.client3Available;
    result.sharedPeriodLocked = period.locked;
    result.sharedCpuFallback = period.cpuFallback;
    result.sharedRequestedPeriodFrames = period.requested;
    result.sharedDefaultPeriodFrames = period.normal;
    result.sharedFundamentalPeriodFrames = period.fundamental;
    result.sharedMinimumPeriodFrames = period.minimum;
    result.sharedMaximumPeriodFrames = period.maximum;
    result.sharedActualPeriodFrames = period.actual;
    result.captureDiscontinuities = impl_->captureDiscontinuities.load(std::memory_order_relaxed);
    return result;
}
#endif
