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
#include <atomic>
#include <audioclient.h>
#include <avrt.h>
#include <array>
#include <chrono>
#include <cmath>
#include <cstdio>
#include <cstring>
#include <ksmedia.h>
#include <mmdeviceapi.h>
#include <stdexcept>
#include <thread>
#include <vector>
#include <windows.h>
#include <wrl/client.h>

using Microsoft::WRL::ComPtr;
namespace {
void check(HRESULT hr, const char* message) {
    if (FAILED(hr)) {
        char code[16]{};
        std::snprintf(code, sizeof(code), " (0x%08lX)", static_cast<unsigned long>(hr));
        throw std::runtime_error(std::string(message) + code);
    }
}
// IAudioClient3::InitializeSharedAudioStream rejects AUDCLNT_STREAMFLAGS_NOPERSIST with AUDCLNT_E_INVALID_STREAM_FLAG.
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
std::uint32_t hnsToFrames(REFERENCE_TIME hns, std::uint32_t rate) {
    return static_cast<std::uint32_t>(
        (static_cast<std::uint64_t>(std::max<REFERENCE_TIME>(0, hns)) * rate + 9'999'999ULL) /
        10'000'000ULL);
}
REFERENCE_TIME framesToHns(std::uint32_t frames, std::uint32_t rate) {
    return static_cast<REFERENCE_TIME>(
        (static_cast<std::uint64_t>(frames) * 10'000'000ULL + rate - 1U) / rate);
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
// Exclusive mode accepts only formats the endpoint supports natively, which is rarely the float mix format.
// Candidates are ordered by fidelity; WasapiPcm converts every one of them to and from float.
WAVEFORMATEX* exclusiveFormatFor(IAudioClient* client, const WAVEFORMATEX* mix,
                                 std::uint32_t requestedRate) {
    struct Candidate {
        WORD bits;
        bool isFloat;
    };
    constexpr std::array<Candidate, 4> candidates{
        {{32, true}, {32, false}, {24, false}, {16, false}}};
    DWORD channelMask = (1UL << mix->nChannels) - 1UL;
    if (mix->wFormatTag == WAVE_FORMAT_EXTENSIBLE)
        channelMask = reinterpret_cast<const WAVEFORMATEXTENSIBLE*>(mix)->dwChannelMask;
    for (const auto rate : {requestedRate, static_cast<std::uint32_t>(mix->nSamplesPerSec)}) {
        for (const auto& candidate : candidates) {
            WAVEFORMATEXTENSIBLE format{};
            format.Format.wFormatTag = WAVE_FORMAT_EXTENSIBLE;
            format.Format.nChannels = mix->nChannels;
            format.Format.nSamplesPerSec = rate;
            format.Format.wBitsPerSample = candidate.bits;
            format.Format.nBlockAlign = static_cast<WORD>(mix->nChannels * candidate.bits / 8U);
            format.Format.nAvgBytesPerSec = rate * format.Format.nBlockAlign;
            format.Format.cbSize = sizeof(WAVEFORMATEXTENSIBLE) - sizeof(WAVEFORMATEX);
            format.Samples.wValidBitsPerSample = candidate.bits;
            format.dwChannelMask = channelMask;
            format.SubFormat = candidate.isFloat ? KSDATAFORMAT_SUBTYPE_IEEE_FLOAT
                                                 : KSDATAFORMAT_SUBTYPE_PCM;
            if (client->IsFormatSupported(AUDCLNT_SHAREMODE_EXCLUSIVE, &format.Format, nullptr) ==
                S_OK) {
                auto* result = static_cast<WAVEFORMATEX*>(CoTaskMemAlloc(sizeof(format)));
                if (result != nullptr)
                    std::memcpy(result, &format, sizeof(format));
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
    auto hr = client->Initialize(AUDCLNT_SHAREMODE_EXCLUSIVE, flags, duration, duration, format,
                                 nullptr);
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
    explicit Impl(WasapiMode value) : mode(value) {}
    WasapiMode mode;
    bool comInitialized{false};
    ComPtr<IMMDeviceEnumerator> enumerator;
    ComPtr<IMMDevice> inputDevice, outputDevice;
    ComPtr<IAudioClient> inputClient, outputClient;
    ComPtr<IAudioCaptureClient> capture;
    ComPtr<IAudioRenderClient> render;
    ComPtr<IAudioClock> renderClock;
    UINT64 renderClockFrequency{0};
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

    void openEndpoints(const RequestedConfiguration& requested) {
        inputDevice = deviceFor(enumerator.Get(), eCapture, requested.inputDeviceId);
        outputDevice = deviceFor(enumerator.Get(), eRender, requested.outputDeviceId);
        check(inputDevice->Activate(__uuidof(IAudioClient), CLSCTX_ALL, nullptr, &inputClient),
              "capture client activation failed");
        check(outputDevice->Activate(__uuidof(IAudioClient), CLSCTX_ALL, nullptr, &outputClient),
              "render client activation failed");
        check(inputClient->GetMixFormat(&inputFormat), "capture format failed");
        check(outputClient->GetMixFormat(&outputFormat), "render format failed");
    }

    void initializeSharedCapture(DWORD flags, std::uint32_t requestedPeriod,
                                 std::uint32_t& inputPeriod) {
        ComPtr<IAudioClient3> input3;
        if (SUCCEEDED(inputClient.As(&input3))) {
            UINT32 defaultPeriod = 0, fundamental = 0, minimum = 0, maximum = 0;
            if (SUCCEEDED(input3->GetSharedModeEnginePeriod(inputFormat, &defaultPeriod,
                                                            &fundamental, &minimum, &maximum))) {
                inputPeriod = std::clamp(requestedPeriod, minimum, maximum);
                if (fundamental != 0)
                    inputPeriod = ((inputPeriod + fundamental - 1U) / fundamental) * fundamental;
            }
            check(input3->InitializeSharedAudioStream(audioClient3Flags(flags), inputPeriod, inputFormat, nullptr),
                  "shared capture initialize failed");
        } else {
            check(inputClient->Initialize(AUDCLNT_SHAREMODE_SHARED, flags,
                                          framesToHns(requestedPeriod, inputFormat->nSamplesPerSec),
                                          0, inputFormat, nullptr),
                  "shared capture initialize failed");
        }
    }

    void initializeSharedRender(DWORD flags, std::uint32_t requestedPeriod,
                                std::uint32_t& outputPeriod) {
        ComPtr<IAudioClient3> output3;
        if (SUCCEEDED(outputClient.As(&output3))) {
            UINT32 defaultPeriod = 0, fundamental = 0, minimum = 0, maximum = 0;
            if (SUCCEEDED(output3->GetSharedModeEnginePeriod(outputFormat, &defaultPeriod,
                                                             &fundamental, &minimum, &maximum))) {
                outputPeriod = std::clamp(requestedPeriod, minimum, maximum);
                if (fundamental != 0)
                    outputPeriod = ((outputPeriod + fundamental - 1U) / fundamental) * fundamental;
            }
            check(output3->InitializeSharedAudioStream(audioClient3Flags(flags), outputPeriod, outputFormat, nullptr),
                  "shared render initialize failed");
        } else {
            check(
                outputClient->Initialize(AUDCLNT_SHAREMODE_SHARED, flags,
                                         framesToHns(requestedPeriod, outputFormat->nSamplesPerSec),
                                         0, outputFormat, nullptr),
                "shared render initialize failed");
        }
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
        auto* outputNative =
            exclusiveFormatFor(outputClient.Get(), outputFormat, requested.sampleRateHz);
        if (outputNative == nullptr) {
            CoTaskMemFree(outputNative);
            throw std::runtime_error("exclusive mode: the device supports no usable PCM format");
        }
        CoTaskMemFree(outputFormat);
        outputFormat = outputNative;
        initializeExclusiveClient(outputClient, outputDevice.Get(), outputFormat,
                                  requested.periodFrames, flags, "exclusive render initialize failed");
    }

    // Event-driven streams need one silent buffer queued before Start(); without it exclusive endpoints stall.
    void prefillRender() noexcept {
        UINT32 frames = 0;
        BYTE* data = nullptr;
        if (!render || FAILED(outputClient->GetBufferSize(&frames)) || FAILED(render->GetBuffer(frames, &data)))
            return;
        render->ReleaseBuffer(frames, AUDCLNT_BUFFERFLAGS_SILENT);
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
        inputClient->GetStreamLatency(&inputLatency);
        outputClient->GetStreamLatency(&outputLatency);

        inputPeriod = currentSharedPeriod(inputClient.Get(), inputPeriod);
        if (mode == WasapiMode::Shared) {
            outputPeriod = currentSharedPeriod(outputClient.Get(), outputPeriod);
        } else {
            outputPeriod = std::min(outputBuffer, requested.periodFrames);
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

    void processCapture() noexcept {
        if (!capture || !callback)
            return;
        UINT32 packet = 0;
        while (SUCCEEDED(capture->GetNextPacketSize(&packet)) && packet != 0) {
            BYTE* data = nullptr;
            UINT32 frames = 0;
            DWORD flags = 0;
            UINT64 position = 0, qpc = 0;
            const auto hr = capture->GetBuffer(&data, &frames, &flags, &position, &qpc);
            if (FAILED(hr)) {
                xruns.fetch_add(1, std::memory_order_relaxed);
                return;
            }
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
                callback->onCapture(generation, {target, nullptr, chunk, inputFormat->nChannels,
                                                 static_cast<std::int64_t>(position + offset),
                                                 static_cast<MonotonicTicks>(qpc), flags});
                offset += chunk;
            }
            capture->ReleaseBuffer(frames);
        }
    }
    void processRender() noexcept {
        if (!render || !outputClient || !callback)
            return;
        UINT32 bufferFrames = 0, pad = 0;
        if (FAILED(outputClient->GetBufferSize(&bufferFrames)))
            return;
        // Event-driven exclusive mode has no partial fills: every event asks for the whole buffer.
        if (mode == WasapiMode::Shared && FAILED(outputClient->GetCurrentPadding(&pad)))
            return;
        padding.store(pad, std::memory_order_relaxed);
        auto available = bufferFrames - pad;
        while (available != 0) {
            const auto chunk = std::min<std::uint32_t>(MaxBlockFrames, available);
            BYTE* data = nullptr;
            if (FAILED(render->GetBuffer(chunk, &data))) {
                xruns.fetch_add(1, std::memory_order_relaxed);
                return;
            }
            UINT64 position = 0, qpc = 0;
            if (renderClock && SUCCEEDED(renderClock->GetPosition(&position, &qpc)) &&
                renderClockFrequency != 0) {
                const auto whole = position / renderClockFrequency;
                const auto remainder = position % renderClockFrequency;
                position = whole * outputFormat->nSamplesPerSec +
                           (remainder * outputFormat->nSamplesPerSec) / renderClockFrequency;
            }
            callback->onRender(generation,
                               {nullptr, renderScratch.data(), chunk, outputFormat->nChannels,
                                static_cast<std::int64_t>(position),
                                static_cast<MonotonicTicks>(qpc), 0});
            const auto listeningGain = mode == WasapiMode::Exclusive
                                           ? WasapiPcm::ExclusiveListeningLevelCompensation
                                           : 1.0F;
            WasapiPcm::fromFloat(renderScratch.data(), data, chunk, outputFormat, listeningGain);
            if (FAILED(render->ReleaseBuffer(chunk, 0)))
                xruns.fetch_add(1, std::memory_order_relaxed);
            available -= chunk;
        }
    }
    void threadMain() noexcept {
        DWORD taskIndex = 0;
        HANDLE task = AvSetMmThreadCharacteristicsW(L"Pro Audio", &taskIndex);
        mmcss.store(task != nullptr, std::memory_order_relaxed);
        HANDLE handles[3]{stopEvent, captureEvent, renderEvent};
        const auto period = std::chrono::duration<double>(
            static_cast<double>(runtime.outputPeriodFrames) / runtime.outputSampleRateHz);
        while (running.load(std::memory_order_acquire)) {
            const auto started = std::chrono::steady_clock::now();
            const auto result = WaitForMultipleObjects(3, handles, FALSE, 1000);
            if (result == WAIT_OBJECT_0)
                break;
            if (result == WAIT_TIMEOUT)
                continue;
            if (result != WAIT_OBJECT_0 + 1 && result != WAIT_OBJECT_0 + 2) {
                callback->onBackendEvent(generation, BackendEventType::DeviceLost, GetLastError());
                break;
            }
            // Both endpoints are serviced on every wake-up: WaitForMultipleObjects reports only the lowest signalled
            // index, so a busy capture event would otherwise starve the render deadline. Render goes first.
            if (result == WAIT_OBJECT_0 + 2 || WaitForSingleObject(renderEvent, 0) == WAIT_OBJECT_0)
                processRender();
            if (result == WAIT_OBJECT_0 + 1 || WaitForSingleObject(captureEvent, 0) == WAIT_OBJECT_0)
                processCapture();
            if (std::chrono::steady_clock::now() - started > period)
                deadlineMisses.fetch_add(1, std::memory_order_relaxed);
        }
        if (task)
            AvRevertMmThreadCharacteristics(task);
        mmcss.store(false, std::memory_order_relaxed);
    }
};

WasapiBackend::WasapiBackend(WasapiMode mode) : impl_(std::make_unique<Impl>(mode)) {}
WasapiBackend::~WasapiBackend() {
    impl_->closeAll();
}
std::string_view WasapiBackend::name() const noexcept {
    return impl_->mode == WasapiMode::Shared ? "WASAPI Shared" : "WASAPI Exclusive";
}
AudioDeviceCapabilities WasapiBackend::queryCapabilities(const RequestedConfiguration& requested) {
    if (!impl_->enumerator)
        impl_->initCom();
    auto in = deviceFor(impl_->enumerator.Get(), eCapture, requested.inputDeviceId);
    auto out = deviceFor(impl_->enumerator.Get(), eRender, requested.outputDeviceId);
    ComPtr<IAudioClient> inClient, outClient;
    check(in->Activate(__uuidof(IAudioClient), CLSCTX_ALL, nullptr, &inClient),
          "capture client activation failed");
    check(out->Activate(__uuidof(IAudioClient), CLSCTX_ALL, nullptr, &outClient),
          "render client activation failed");
    WAVEFORMATEX *inFmt = nullptr, *outFmt = nullptr;
    check(inClient->GetMixFormat(&inFmt), "capture mix format failed");
    check(outClient->GetMixFormat(&outFmt), "render mix format failed");
    AudioDeviceCapabilities caps;
    caps.sampleRatesHz.clear();
    addUniqueRate(caps.sampleRatesHz, inFmt->nSamplesPerSec);
    addUniqueRate(caps.sampleRatesHz, outFmt->nSamplesPerSec);
    caps.inputChannels = inFmt->nChannels;
    caps.outputChannels = outFmt->nChannels;
    REFERENCE_TIME defaultPeriod = 0, minPeriod = 0;
    outClient->GetDevicePeriod(&defaultPeriod, &minPeriod);
    caps.defaultPeriodFrames = hnsToFrames(defaultPeriod, outFmt->nSamplesPerSec);
    caps.minPeriodFrames = std::max(1U, hnsToFrames(minPeriod, outFmt->nSamplesPerSec));
    caps.maxPeriodFrames = std::max(caps.defaultPeriodFrames * 8U, caps.minPeriodFrames);
    caps.fundamentalPeriodFrames = 1;
    CoTaskMemFree(inFmt);
    CoTaskMemFree(outFmt);
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
    if (!impl_->inputClient || !impl_->outputClient)
        throw std::logic_error("WASAPI backend is not open");
    impl_->callback = &callback;
    impl_->generation = generation;
    ResetEvent(impl_->stopEvent);
    impl_->running.store(true, std::memory_order_release);
    impl_->thread = std::thread(&Impl::threadMain, impl_.get());
    impl_->prefillRender();
    check(impl_->outputClient->Start(), "render start failed");
    check(impl_->inputClient->Start(), "capture start failed");
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
