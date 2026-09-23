#ifdef _WIN32
#include "backend/asio/AsioBackend.hpp"
#include "backend/asio/AsioAbi.hpp"
#ifndef WIN32_LEAN_AND_MEAN
#define WIN32_LEAN_AND_MEAN
#endif
#ifndef NOMINMAX
#define NOMINMAX
#endif
#include <algorithm>
#include <array>
#include <cstdio>
#include <atomic>
#include <cmath>
#include <cstring>
#include <future>
#include <objbase.h>
#include <ranges>
#include <stdexcept>
#include <string>
#include <thread>
#include <vector>
#include <windows.h>

namespace {
bool asioSucceeded(AsioError error) noexcept {
    return error == AsioOk || error == AsioSuccess;
}

void checkAsio(AsioError error, const char* message) {
    if (!asioSucceeded(error))
        throw std::runtime_error(message);
}
CLSID clsidFromText(const std::string& text) {
    std::wstring wide(text.begin(), text.end());
    CLSID id{};
    if (FAILED(CLSIDFromString(wide.c_str(), &id)))
        throw std::runtime_error("Invalid ASIO CLSID");
    return id;
}
std::string firstAsioClsid() {
    HKEY root = nullptr;
    if (RegOpenKeyExW(HKEY_LOCAL_MACHINE, L"SOFTWARE\\ASIO", 0, KEY_READ, &root) != ERROR_SUCCESS)
        throw std::runtime_error("No ASIO drivers installed");
    wchar_t name[256]{};
    DWORD chars = 256;
    if (RegEnumKeyExW(root, 0, name, &chars, nullptr, nullptr, nullptr, nullptr) != ERROR_SUCCESS) {
        RegCloseKey(root);
        throw std::runtime_error("No ASIO drivers installed");
    }
    HKEY key = nullptr;
    if (RegOpenKeyExW(root, name, 0, KEY_READ, &key) != ERROR_SUCCESS) {
        RegCloseKey(root);
        throw std::runtime_error("Cannot open ASIO registry entry");
    }
    wchar_t clsid[128]{};
    DWORD bytes = sizeof(clsid);
    if (RegQueryValueExW(key, L"CLSID", nullptr, nullptr, reinterpret_cast<BYTE*>(clsid), &bytes) !=
        ERROR_SUCCESS) {
        RegCloseKey(key);
        RegCloseKey(root);
        throw std::runtime_error("ASIO CLSID missing");
    }
    RegCloseKey(key);
    RegCloseKey(root);
    const auto count = WideCharToMultiByte(CP_UTF8, 0, clsid, -1, nullptr, 0, nullptr, nullptr);
    if (count <= 0)
        throw std::runtime_error("ASIO CLSID conversion failed");
    std::string out(static_cast<std::size_t>(count), '\0');
    WideCharToMultiByte(CP_UTF8, 0, clsid, -1, out.data(), count, nullptr, nullptr);
    out.resize(static_cast<std::size_t>(count - 1));
    return out;
}
float readSample(const void* base, AsioSampleType type, long frame) noexcept {
    const auto* bytes = static_cast<const unsigned char*>(base);
    switch (type) {
    case AsioFloat32Lsb: {
        float v{};
        std::memcpy(&v, bytes + static_cast<std::size_t>(frame) * 4U, 4U);
        return v;
    }
    case AsioInt16Lsb: {
        std::int16_t v{};
        std::memcpy(&v, bytes + static_cast<std::size_t>(frame) * 2U, 2U);
        return static_cast<float>(v) / 32768.0F;
    }
    case AsioInt24Lsb: {
        const auto o = static_cast<std::size_t>(frame) * 3U;
        std::int32_t v = static_cast<std::int32_t>(bytes[o]) |
                         (static_cast<std::int32_t>(bytes[o + 1U]) << 8) |
                         (static_cast<std::int32_t>(bytes[o + 2U]) << 16);
        if ((v & 0x00800000) != 0)
            v |= static_cast<std::int32_t>(0xFF000000U);
        return static_cast<float>(v) / 8388608.0F;
    }
    case AsioInt32Lsb:
    case AsioInt32Lsb16:
    case AsioInt32Lsb18:
    case AsioInt32Lsb20:
    case AsioInt32Lsb24: {
        std::int32_t v{};
        std::memcpy(&v, bytes + static_cast<std::size_t>(frame) * 4U, 4U);
        return static_cast<float>(static_cast<double>(v) / 2147483648.0);
    }
    default:
        return 0.0F;
    }
}
void writeSample(void* base, AsioSampleType type, long frame, float sample) noexcept {
    auto* bytes = static_cast<unsigned char*>(base);
    const auto x = std::clamp(sample, -1.0F, 1.0F);
    switch (type) {
    case AsioFloat32Lsb:
        std::memcpy(bytes + static_cast<std::size_t>(frame) * 4U, &x, 4U);
        break;
    case AsioInt16Lsb: {
        const auto v = static_cast<std::int16_t>(std::lrint(x * 32767.0F));
        std::memcpy(bytes + static_cast<std::size_t>(frame) * 2U, &v, 2U);
        break;
    }
    case AsioInt24Lsb: {
        const auto v = static_cast<std::int32_t>(std::lrint(x * 8388607.0F));
        const auto o = static_cast<std::size_t>(frame) * 3U;
        bytes[o] = static_cast<unsigned char>(v & 0xff);
        bytes[o + 1U] = static_cast<unsigned char>((v >> 8) & 0xff);
        bytes[o + 2U] = static_cast<unsigned char>((v >> 16) & 0xff);
        break;
    }
    case AsioInt32Lsb:
    case AsioInt32Lsb16:
    case AsioInt32Lsb18:
    case AsioInt32Lsb20:
    case AsioInt32Lsb24: {
        const auto v =
            static_cast<std::int32_t>(std::llround(static_cast<double>(x) * 2147483647.0));
        std::memcpy(bytes + static_cast<std::size_t>(frame) * 4U, &v, 4U);
        break;
    }
    default:
        break;
    }
}
} // namespace

struct AsioBackend::Impl {
    static std::atomic<Impl*> active;
    IAsioDriver* driver{nullptr};
    // ASIO drivers are apartment-threaded COM objects: they are created on, and stay tied to, one STA thread that
    // keeps pumping messages. The raw driver pointer is then used directly from the control and driver threads.
    std::thread apartment;
    HANDLE apartmentStop{nullptr};
    bool initialized{false};
    bool buffersCreated{false};
    std::vector<AsioBufferInfo> buffers;
    std::vector<AsioChannelInfo> inputInfo, outputInfo;
    std::vector<float> captureScratch, renderScratch;
    long inputChannels{0}, outputChannels{0}, bufferFrames{0};
    long inputLatency{0}, outputLatency{0};
    double sampleRate{48000.0};
    IAudioCallback* callback{nullptr};
    GenerationId generation{0};
    std::atomic<bool> running{false};
    std::atomic<std::uint64_t> xruns{0}, deadlineMisses{0};
    std::atomic<bool> resetRequested{false};
    AsioCallbacks callbacks{};

    static void bufferSwitch(long index, AsioBool direct) {
        if (auto* self = active.load(std::memory_order_acquire))
            self->process(index, direct);
    }
    static void sampleRateChanged(AsioSampleRate rate) {
        if (auto* self = active.load(std::memory_order_acquire)) {
            self->sampleRate = rate;
            if (self->callback)
                self->callback->onBackendEvent(self->generation,
                                               BackendEventType::SampleRateChanged, 0);
        }
    }
    static long asioMessage(long selector, long value, void*, double*) {
        auto* self = active.load(std::memory_order_acquire);
        if (!self)
            return 0;
        switch (selector) {
        case AsioSelectorSupported: {
            constexpr std::array supported{AsioResetRequest,  AsioBufferSizeChange,
                                           AsioResyncRequest, AsioLatenciesChanged,
                                           AsioEngineVersion, AsioSupportsTimeInfo};
            return std::ranges::find(supported, value) != supported.end();
        }
        case AsioEngineVersion:
            return 2;
        case AsioResetRequest:
            self->resetRequested.store(true, std::memory_order_release);
            if (self->callback)
                self->callback->onBackendEvent(self->generation, BackendEventType::DriverReset, 0);
            return 1;
        case AsioBufferSizeChange:
        case AsioResyncRequest:
            if (self->callback)
                self->callback->onBackendEvent(self->generation, BackendEventType::DriverReset,
                                               static_cast<std::int32_t>(selector));
            return 1;
        case AsioLatenciesChanged:
            return 1;
        default:
            return 0;
        }
    }
    static void* bufferSwitchTimeInfo(void* params, long index, AsioBool direct) {
        bufferSwitch(index, direct);
        return params;
    }
    struct DriverOpenResult {
        IAsioDriver* driver{nullptr};
        HRESULT hr{E_FAIL};
        bool initialized{false};
    };
    static void runApartment(const CLSID id, HANDLE stop, std::promise<DriverOpenResult>& ready) {
        DriverOpenResult result;
        result.hr = CoInitializeEx(nullptr, COINIT_APARTMENTTHREADED);
        if (FAILED(result.hr)) {
            ready.set_value(result);
            return;
        }
        void* object = nullptr;
        result.hr = CoCreateInstance(id, nullptr, CLSCTX_INPROC_SERVER, id, &object);
        if (SUCCEEDED(result.hr) && object) {
            result.driver = static_cast<IAsioDriver*>(object);
            result.initialized = result.driver->init(GetDesktopWindow()) != 0;
        }
        ready.set_value(result);
        while (MsgWaitForMultipleObjects(1, &stop, FALSE, INFINITE, QS_ALLINPUT) != WAIT_OBJECT_0) {
            MSG message;
            while (PeekMessageW(&message, nullptr, 0, 0, PM_REMOVE)) {
                TranslateMessage(&message);
                DispatchMessageW(&message);
            }
        }
        CoUninitialize();
    }
    void stopApartment() noexcept {
        if (apartmentStop)
            SetEvent(apartmentStop);
        if (apartment.joinable())
            apartment.join();
        if (apartmentStop) {
            CloseHandle(apartmentStop);
            apartmentStop = nullptr;
        }
    }
    void openDriver(const std::string& requestedId) {
        const auto id = clsidFromText(requestedId.empty() ? firstAsioClsid() : requestedId);
        apartmentStop = CreateEventW(nullptr, TRUE, FALSE, nullptr);
        if (!apartmentStop)
            throw std::runtime_error("ASIO apartment event creation failed");
        std::promise<DriverOpenResult> ready;
        auto opened = ready.get_future();
        apartment = std::thread(&Impl::runApartment, id, apartmentStop, std::ref(ready));
        const auto result = opened.get();
        if (!result.driver || !result.initialized) {
            if (result.driver)
                result.driver->Release();
            stopApartment();
            if (result.driver)
                throw std::runtime_error("ASIO driver init failed");
            char code[48]{};
            std::snprintf(code, sizeof(code), " (0x%08lX)", static_cast<unsigned long>(result.hr));
            throw std::runtime_error(std::string("ASIO driver activation failed") + code);
        }
        driver = result.driver;
        initialized = true;
    }
    void process(long index, AsioBool) noexcept {
        if (!running.load(std::memory_order_acquire) || !callback || index < 0 || index > 1)
            return;
        AsioSamples position{};
        AsioTimeStamp stamp{};
        (void)driver->getSamplePosition(&position, &stamp);
        for (long f = 0; f < bufferFrames; ++f) {
            for (long ch = 0; ch < inputChannels; ++ch)
                captureScratch[static_cast<std::size_t>(f) *
                                   static_cast<std::size_t>(inputChannels) +
                               static_cast<std::size_t>(ch)] =
                    readSample(buffers[static_cast<std::size_t>(ch)].buffers[index],
                               inputInfo[static_cast<std::size_t>(ch)].type, f);
        }
        callback->onCapture(generation, {captureScratch.data(), nullptr,
                                         static_cast<std::uint32_t>(bufferFrames),
                                         static_cast<std::uint32_t>(inputChannels),
                                         static_cast<std::int64_t>(asioInt64Value(position)),
                                         static_cast<MonotonicTicks>(asioInt64Value(stamp)), 0});
        callback->onRender(generation,
                           {nullptr, renderScratch.data(), static_cast<std::uint32_t>(bufferFrames),
                            static_cast<std::uint32_t>(outputChannels),
                            static_cast<std::int64_t>(asioInt64Value(position)),
                            static_cast<MonotonicTicks>(asioInt64Value(stamp)), 0});
        for (long f = 0; f < bufferFrames; ++f) {
            for (long ch = 0; ch < outputChannels; ++ch) {
                const auto bi = static_cast<std::size_t>(inputChannels + ch);
                writeSample(buffers[bi].buffers[index],
                            outputInfo[static_cast<std::size_t>(ch)].type, f,
                            renderScratch[static_cast<std::size_t>(f) *
                                              static_cast<std::size_t>(outputChannels) +
                                          static_cast<std::size_t>(ch)]);
            }
        }
        (void)driver->outputReady();
    }
    void closeAll() noexcept {
        running.store(false, std::memory_order_release);
        if (driver) {
            if (buffersCreated) {
                driver->disposeBuffers();
                buffersCreated = false;
            }
            if (initialized) {
                driver->Release();
                initialized = false;
            }
            driver = nullptr;
        }
        stopApartment();
        buffers.clear();
        inputInfo.clear();
        outputInfo.clear();
        captureScratch.clear();
        renderScratch.clear();
        callback = nullptr;
        active.store(nullptr, std::memory_order_release);
    }
};
std::atomic<AsioBackend::Impl*> AsioBackend::Impl::active{nullptr};

AsioBackend::AsioBackend() : impl_(std::make_unique<Impl>()) {}
AsioBackend::~AsioBackend() {
    impl_->closeAll();
}
AudioDeviceCapabilities AsioBackend::queryCapabilities(const RequestedConfiguration& requested) {
    Impl temp;
    temp.openDriver(!requested.outputDeviceId.empty() ? requested.outputDeviceId
                                                      : requested.inputDeviceId);
    long in = 0, out = 0, min = 0, max = 0, pref = 0, gran = 0;
    checkAsio(temp.driver->getChannels(&in, &out), "ASIO getChannels failed");
    checkAsio(temp.driver->getBufferSize(&min, &max, &pref, &gran), "ASIO getBufferSize failed");
    AudioDeviceCapabilities caps;
    double currentRate = 0;
    if (temp.driver->getSampleRate(&currentRate) == AsioOk && currentRate > 0)
        caps.defaultSampleRateHz = static_cast<std::uint32_t>(currentRate);
    caps.sampleRatesHz.clear();
    for (const auto rate : {44100U, 48000U, 88200U, 96000U, 192000U})
        if (asioSucceeded(temp.driver->canSampleRate(rate)))
            caps.sampleRatesHz.push_back(rate);
    if (caps.sampleRatesHz.empty()) {
        caps.sampleRatesHz.push_back(caps.defaultSampleRateHz);
    }
    caps.minPeriodFrames = static_cast<std::uint32_t>(std::max(1L, min));
    caps.maxPeriodFrames = static_cast<std::uint32_t>(std::max(min, max));
    caps.defaultPeriodFrames = static_cast<std::uint32_t>(std::clamp(pref, min, max));
    caps.fundamentalPeriodFrames = gran > 0 ? static_cast<std::uint32_t>(gran) : 1U;
    if (gran == -1) {
        for (long frames = 1; frames <= max && frames > 0; frames *= 2)
            if (frames >= min)
                caps.periodFrames.push_back(static_cast<std::uint32_t>(frames));
    } else if (gran == 0) {
        caps.periodFrames.push_back(caps.defaultPeriodFrames);
    } else {
        for (long frames = min; frames <= max; frames += gran)
            caps.periodFrames.push_back(static_cast<std::uint32_t>(frames));
    }
    caps.inputChannels = static_cast<std::uint32_t>(std::max(0L, in));
    caps.outputChannels = static_cast<std::uint32_t>(std::max(0L, out));
    temp.closeAll();
    return caps;
}
RuntimeConfiguration AsioBackend::open(const RequestedConfiguration& requested) {
    impl_->closeAll();
    impl_->openDriver(!requested.outputDeviceId.empty() ? requested.outputDeviceId
                                                        : requested.inputDeviceId);
    checkAsio(impl_->driver->getChannels(&impl_->inputChannels, &impl_->outputChannels),
              "ASIO getChannels failed");
    long min = 0, max = 0, pref = 0, gran = 0;
    checkAsio(impl_->driver->getBufferSize(&min, &max, &pref, &gran), "ASIO getBufferSize failed");
    impl_->bufferFrames = std::clamp<long>(static_cast<long>(requested.periodFrames), min, max);
    if (gran > 0)
        impl_->bufferFrames = ((impl_->bufferFrames + gran - 1) / gran) * gran;
    double current = 0;
    checkAsio(impl_->driver->getSampleRate(&current), "ASIO getSampleRate failed");
    if (static_cast<std::uint32_t>(current) != requested.sampleRateHz &&
        asioSucceeded(impl_->driver->canSampleRate(requested.sampleRateHz)))
        checkAsio(impl_->driver->setSampleRate(requested.sampleRateHz),
                  "ASIO setSampleRate failed");
    checkAsio(impl_->driver->getSampleRate(&impl_->sampleRate), "ASIO getSampleRate failed");
    const auto inUse =
        std::min<long>(impl_->inputChannels, static_cast<long>(requested.inputChannels));
    const auto outUse =
        std::min<long>(impl_->outputChannels, static_cast<long>(requested.outputChannels));
    impl_->inputChannels = inUse;
    impl_->outputChannels = outUse;
    if (inUse <= 0 || outUse <= 0)
        throw std::runtime_error("ASIO driver has insufficient channels");
    impl_->buffers.resize(static_cast<std::size_t>(inUse + outUse));
    impl_->inputInfo.resize(static_cast<std::size_t>(inUse));
    impl_->outputInfo.resize(static_cast<std::size_t>(outUse));
    for (long ch = 0; ch < inUse; ++ch) {
        impl_->buffers[static_cast<std::size_t>(ch)] = {1, ch, {nullptr, nullptr}};
        auto& info = impl_->inputInfo[static_cast<std::size_t>(ch)];
        info.channel = ch;
        info.isInput = 1;
        checkAsio(impl_->driver->getChannelInfo(&info), "ASIO input channel info failed");
    }
    for (long ch = 0; ch < outUse; ++ch) {
        const auto i = static_cast<std::size_t>(inUse + ch);
        impl_->buffers[i] = {0, ch, {nullptr, nullptr}};
        auto& info = impl_->outputInfo[static_cast<std::size_t>(ch)];
        info.channel = ch;
        info.isInput = 0;
        checkAsio(impl_->driver->getChannelInfo(&info), "ASIO output channel info failed");
    }
    impl_->callbacks = {&Impl::bufferSwitch, &Impl::sampleRateChanged, &Impl::asioMessage,
                        &Impl::bufferSwitchTimeInfo};
    Impl::active.store(impl_.get(), std::memory_order_release);
    checkAsio(impl_->driver->createBuffers(impl_->buffers.data(),
                                           static_cast<long>(impl_->buffers.size()),
                                           impl_->bufferFrames, &impl_->callbacks),
              "ASIO createBuffers failed");
    impl_->buffersCreated = true;
    (void)impl_->driver->getLatencies(&impl_->inputLatency, &impl_->outputLatency);
    impl_->captureScratch.assign(
        static_cast<std::size_t>(impl_->bufferFrames) * static_cast<std::size_t>(inUse), 0.0F);
    impl_->renderScratch.assign(
        static_cast<std::size_t>(impl_->bufferFrames) * static_cast<std::size_t>(outUse), 0.0F);
    return {static_cast<std::uint32_t>(impl_->sampleRate),
            static_cast<std::uint32_t>(impl_->sampleRate),
            static_cast<std::uint32_t>(impl_->bufferFrames),
            static_cast<std::uint32_t>(impl_->bufferFrames),
            static_cast<std::uint32_t>(impl_->bufferFrames * 2),
            static_cast<std::uint32_t>(impl_->bufferFrames * 2),
            static_cast<std::uint32_t>(inUse),
            static_cast<std::uint32_t>(outUse),
            AudioSampleFormat::Float32,
            AudioSampleFormat::Float32,
            ClockRelationship::SameDomain,
            static_cast<std::uint32_t>(std::max(0L, impl_->inputLatency)),
            static_cast<std::uint32_t>(std::max(0L, impl_->outputLatency))};
}
void AsioBackend::start(IAudioCallback& callback, GenerationId generation) {
    if (!impl_->driver || !impl_->buffersCreated)
        throw std::logic_error("ASIO backend is not open");
    impl_->callback = &callback;
    impl_->generation = generation;
    impl_->running.store(true, std::memory_order_release);
    Impl::active.store(impl_.get(), std::memory_order_release);
    checkAsio(impl_->driver->start(), "ASIO start failed");
}
void AsioBackend::stop() noexcept {
    if (impl_->driver && impl_->running.exchange(false, std::memory_order_acq_rel))
        impl_->driver->stop();
    impl_->callback = nullptr;
}
void AsioBackend::close() noexcept {
    stop();
    impl_->closeAll();
}
BackendSnapshot AsioBackend::snapshot() const noexcept {
    return {impl_->driver != nullptr,
            impl_->running.load(std::memory_order_relaxed),
            0,
            impl_->xruns.load(std::memory_order_relaxed),
            impl_->deadlineMisses.load(std::memory_order_relaxed),
            false};
}
#endif
