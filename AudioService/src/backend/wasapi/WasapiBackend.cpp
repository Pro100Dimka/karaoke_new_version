#ifdef _WIN32
#include "backend/wasapi/WasapiBackend.hpp"
#include "backend/wasapi/WasapiPcm.hpp"
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
struct SharedPeriods {
    UINT32 normal{}, fundamental{}, minimum{}, maximum{};
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
std::wstring widen(const std::string& text) {
    if (text.empty())
        return {};
    const auto count = MultiByteToWideChar(CP_UTF8, 0, text.c_str(), -1, nullptr, 0);
    if (count <= 0)
        throw std::runtime_error("device id conversion failed");
    std::wstring out(static_cast<std::size_t>(count), L'\0');
    MultiByteToWideChar(CP_UTF8, 0, text.c_str(), -1, out.data(), count);
    out.resize(static_cast<std::size_t>(count - 1));
    return out;
}
ComPtr<IMMDevice> deviceFor(IMMDeviceEnumerator* enumerator, EDataFlow flow,
                            const std::string& id) {
    ComPtr<IMMDevice> device;
    if (id.empty())
        check(enumerator->GetDefaultAudioEndpoint(flow, eConsole, &device),
              "default endpoint unavailable");
    else {
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
std::uint32_t initializeSharedClient(IAudioClient* client, const WAVEFORMATEX* format, DWORD flags,
                                     std::uint32_t requestedPeriod) {
    ComPtr<IAudioClient3> client3;
    if (SUCCEEDED(client->QueryInterface(IID_PPV_ARGS(&client3)))) {
        if (const auto periods = sharedPeriods(client3.Get(), format)) {
            const auto fundamental = periods->fundamental;
            const auto lower = periods->minimum / fundamental;
            const auto upper = periods->maximum / fundamental;
            const auto steps =
                (static_cast<std::uint64_t>(requestedPeriod) + fundamental - 1) / fundamental;
            const auto selected =
                static_cast<UINT32>(std::clamp<std::uint64_t>(steps, lower, upper) * fundamental);
            check(client3->InitializeSharedAudioStream(audioClient3Flags(flags), selected, format,
                                                       nullptr),
                  "shared stream initialize failed");
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
    return hnsToFrames(normal, format->nSamplesPerSec);
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
    ComPtr<IAudioClient> inputClient, outputClient;
    ComPtr<IAudioCaptureClient> capture;
    ComPtr<IAudioRenderClient> render;
    ComPtr<IAudioClock> renderClock;
    UINT64 renderClockFrequency{0};
    UINT64 submittedRenderFrames{0};
    WAVEFORMATEX* inputFormat{nullptr};
    WAVEFORMATEX* outputFormat{nullptr};
    HANDLE captureEvent{nullptr}, renderEvent{nullptr}, stopEvent{nullptr};
    std::thread thread;
    std::atomic<bool> running{false};
    IAudioCallback* callback{nullptr};
    GenerationId generation{0};
    RuntimeConfiguration runtime{};
    std::vector<float> captureScratch, renderScratch;
    std::atomic<std::uint32_t> padding{0};
    std::atomic<std::uint64_t> xruns{0}, deadlineMisses{0};
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
        inputClient.Reset();
        outputClient.Reset();
        inputDevice.Reset();
        outputDevice.Reset();
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

    ComPtr<IMMDevice> selectDevice(Direction direction, const std::string& id) {
        if (!deviceFactory)
            return deviceFor(enumerator.Get(), direction == Direction::Input ? eCapture : eRender,
                             id);
        ComPtr<IMMDevice> result;
        result.Attach(deviceFactory(direction, id));
        if (!result)
            throw std::runtime_error("selected endpoint unavailable");
        return result;
    }

    void openEndpoints(const RequestedConfiguration& requested) {
        inputDevice = selectDevice(Direction::Input, requested.inputDeviceId);
        outputDevice = selectDevice(Direction::Output, requested.outputDeviceId);
        check(inputDevice->Activate(__uuidof(IAudioClient), CLSCTX_ALL, nullptr, &inputClient),
              "capture client activation failed");
        check(outputDevice->Activate(__uuidof(IAudioClient), CLSCTX_ALL, nullptr, &outputClient),
              "render client activation failed");
        check(inputClient->GetMixFormat(&inputFormat), "capture format failed");
        check(outputClient->GetMixFormat(&outputFormat), "render format failed");
    }

    void initializeSharedCapture(DWORD flags, std::uint32_t requestedPeriod,
                                 std::uint32_t& inputPeriod) {
        inputPeriod =
            initializeSharedClient(inputClient.Get(), inputFormat, flags, requestedPeriod);
    }

    void initializeSharedRender(DWORD flags, std::uint32_t requestedPeriod,
                                std::uint32_t& outputPeriod) {
        outputPeriod =
            initializeSharedClient(outputClient.Get(), outputFormat, flags, requestedPeriod);
    }

    void initializeShared(DWORD flags, std::uint32_t requestedPeriod, std::uint32_t& inputPeriod,
                          std::uint32_t& outputPeriod) {
        initializeSharedCapture(flags, requestedPeriod, inputPeriod);
        initializeSharedRender(flags, requestedPeriod, outputPeriod);
    }

    void initializeExclusive(DWORD flags, const RequestedConfiguration& requested,
                             std::uint32_t& inputPeriod) {
        // Keep capture on the stable, communications-friendly shared path. Only render needs direct
        // exclusive access for deterministic low-latency listening.
        initializeSharedCapture(flags, requested.periodFrames, inputPeriod);
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
    }

    // Event-driven streams need one silent buffer queued before Start(); without it exclusive
    // endpoints stall.
    void prefillRender() {
        UINT32 frames = 0;
        BYTE* data = nullptr;
        check(outputClient->GetBufferSize(&frames), "render prefill size failed");
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
        check(inputClient->SetEventHandle(captureEvent), "capture event registration failed");
        check(outputClient->SetEventHandle(renderEvent), "render event registration failed");
        check(inputClient->GetService(IID_PPV_ARGS(&capture)), "capture service failed");
        check(outputClient->GetService(IID_PPV_ARGS(&render)), "render service failed");
        (void)outputClient->GetService(IID_PPV_ARGS(&renderClock));
        if (renderClock)
            check(renderClock->GetFrequency(&renderClockFrequency),
                  "render clock frequency failed");
    }

    RuntimeConfiguration readRuntime(const RequestedConfiguration& requested,
                                     std::uint32_t inputPeriod, std::uint32_t outputPeriod) {
        UINT32 inputBuffer = 0, outputBuffer = 0;
        check(inputClient->GetBufferSize(&inputBuffer), "capture buffer size failed");
        check(outputClient->GetBufferSize(&outputBuffer), "render buffer size failed");
        REFERENCE_TIME inputLatency = 0, outputLatency = 0;
        check(inputClient->GetStreamLatency(&inputLatency), "capture latency query failed");
        check(outputClient->GetStreamLatency(&outputLatency), "render latency query failed");

        inputPeriod = currentSharedPeriod(inputClient.Get(), inputPeriod);
        if (mode == WasapiMode::Shared) {
            outputPeriod = currentSharedPeriod(outputClient.Get(), outputPeriod);
        } else {
            outputPeriod = outputBuffer;
        }
        if (inputPeriod == 0)
            inputPeriod = std::min(inputBuffer, requested.periodFrames);
        if (outputPeriod == 0)
            outputPeriod = std::min(outputBuffer, requested.periodFrames);

        runtime = {inputFormat->nSamplesPerSec,
                   outputFormat->nSamplesPerSec,
                   inputPeriod,
                   outputPeriod,
                   inputBuffer,
                   outputBuffer,
                   inputFormat->nChannels,
                   outputFormat->nChannels,
                   WasapiPcm::sampleFormat(inputFormat),
                   WasapiPcm::sampleFormat(outputFormat),
                   inputDevice.Get() == outputDevice.Get() ? ClockRelationship::SameDomain
                                                           : ClockRelationship::Independent,
                   hnsToFrames(inputLatency, inputFormat->nSamplesPerSec),
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
            if ((flags & AUDCLNT_BUFFERFLAGS_DATA_DISCONTINUITY) != 0)
                callback->onBackendEvent(generation, BackendEventType::DataDiscontinuity,
                                         static_cast<std::int32_t>(flags));
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
                callback->onCapture(generation,
                                    {target, nullptr, chunk, inputFormat->nChannels,
                                     static_cast<std::int64_t>(position + offset),
                                     static_cast<MonotonicTicks>(
                                         qpc + static_cast<std::uint64_t>(offset) * 10'000'000 /
                                                   inputFormat->nSamplesPerSec),
                                     flags});
                offset += chunk;
            }
            if (!streamSucceeded(capture->ReleaseBuffer(frames)))
                return;
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
        if (pad > bufferFrames) {
            (void)streamSucceeded(E_UNEXPECTED);
            return;
        }
        const auto available = bufferFrames - pad;
        if (available == 0)
            return;
        BYTE* data = nullptr;
        if (!streamSucceeded(render->GetBuffer(available, &data)))
            return;
        UINT64 position = 0, qpc = 0;
        auto presentation = monotonicTicksNow() +
            static_cast<MonotonicTicks>(runtime.outputLatencyFrames) * 1'000'000'000LL /
                outputFormat->nSamplesPerSec;
        if (renderClock && SUCCEEDED(renderClock->GetPosition(&position, &qpc)) &&
            renderClockFrequency != 0) {
            const auto whole = position / renderClockFrequency;
            const auto remainder = position % renderClockFrequency;
            position = whole * outputFormat->nSamplesPerSec +
                       (remainder * outputFormat->nSamplesPerSec) / renderClockFrequency;
            // IAudioClock reports the sample at the speakers. Count everything submitted,
            // including initial silence; endpoint padding alone omits downstream buffering.
            submittedRenderFrames = std::max(submittedRenderFrames, position + pad);
            presentation = static_cast<MonotonicTicks>(qpc) * 100 +
                static_cast<MonotonicTicks>(submittedRenderFrames - position) *
                    1'000'000'000LL / outputFormat->nSamplesPerSec;
        }
        // Acquire one native packet. Bounded DSP blocks fill views into it before one submission.
        for (UINT32 offset = 0; offset < available;) {
            const auto chunk = std::min<std::uint32_t>(MaxBlockFrames, available - offset);
            const auto frameOffset = static_cast<std::uint64_t>(pad) + offset;
            callback->onRender(generation,
                               {nullptr, renderScratch.data(), chunk, outputFormat->nChannels,
                                static_cast<std::int64_t>(position + frameOffset),
                                static_cast<MonotonicTicks>(qpc + frameOffset * 10'000'000 /
                                                                      outputFormat->nSamplesPerSec),
                                0, presentation + static_cast<MonotonicTicks>(offset) *
                                    1'000'000'000LL / outputFormat->nSamplesPerSec});
            WasapiPcm::fromFloat(renderScratch.data(),
                                 data +
                                     static_cast<std::size_t>(offset) * outputFormat->nBlockAlign,
                                 chunk, outputFormat);
            offset += chunk;
        }
        if (streamSucceeded(render->ReleaseBuffer(available, 0)))
            submittedRenderFrames += available;
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
                    !streamSucceeded(capture->GetNextPacketSize(&unused)))
                    break;
                continue;
            }
            if (result != WAIT_OBJECT_0 + 1 && result != WAIT_OBJECT_0 + 2) {
                callback->onBackendEvent(generation, BackendEventType::DeviceLost, GetLastError());
                break;
            }
            const auto callbackStarted = std::chrono::steady_clock::now();
            // Both endpoints are serviced on every wake-up: WaitForMultipleObjects reports only the
            // lowest signalled index, so a busy capture event would otherwise starve the render
            // deadline. Render goes first.
            if (result == WAIT_OBJECT_0 + 2 || WaitForSingleObject(renderEvent, 0) == WAIT_OBJECT_0)
                processRender();
            if (running.load(std::memory_order_acquire) &&
                (result == WAIT_OBJECT_0 + 1 ||
                 WaitForSingleObject(captureEvent, 0) == WAIT_OBJECT_0))
                processCapture();
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
    auto in = impl_->selectDevice(Direction::Input, requested.inputDeviceId);
    auto out = impl_->selectDevice(Direction::Output, requested.outputDeviceId);
    ComPtr<IAudioClient> inClient, outClient;
    check(in->Activate(__uuidof(IAudioClient), CLSCTX_ALL, nullptr, &inClient),
          "capture client activation failed");
    check(out->Activate(__uuidof(IAudioClient), CLSCTX_ALL, nullptr, &outClient),
          "render client activation failed");
    const auto inputFormat = mixFormat(inClient.Get());
    const auto outputFormat = mixFormat(outClient.Get());
    const auto* inFmt = inputFormat.get();
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
    caps.inputChannels = inFmt->nChannels;
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
                caps.defaultPeriodFrames = periods->normal;
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
    if (!impl_->inputClient || !impl_->outputClient)
        throw std::logic_error("WASAPI backend is not open");
    impl_->callback = &callback;
    impl_->generation = generation;
    ResetEvent(impl_->stopEvent);
    try {
        impl_->prefillRender();
        impl_->running.store(true, std::memory_order_release);
        impl_->thread = std::thread(&Impl::threadMain, impl_.get());
        check(impl_->outputClient->Start(), "render start failed");
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
    return {impl_->inputClient != nullptr && impl_->outputClient != nullptr,
            impl_->running.load(std::memory_order_relaxed),
            impl_->padding.load(std::memory_order_relaxed),
            impl_->xruns.load(std::memory_order_relaxed),
            impl_->deadlineMisses.load(std::memory_order_relaxed),
            impl_->mmcss.load(std::memory_order_relaxed)};
}
#endif
