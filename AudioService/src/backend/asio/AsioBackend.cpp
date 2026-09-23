#ifdef _WIN32
#include "backend/asio/AsioBackend.hpp"
#include "backend/asio/AsioAbi.hpp"
#include "backend/asio/AsioComApartment.hpp"
#include "backend/asio/AsioSampleConversion.hpp"
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
#include <objbase.h>
#include <ranges>
#include <stdexcept>
#include <string>
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
} // namespace

struct AsioBackend::Impl {
    static std::atomic<Impl*> active;
    IAsioDriver* driver{nullptr};
    // Driver creation, init, start/stop, buffer disposal, and Release all run on the control thread that owns this
    // apartment. Passing a raw apartment-bound COM pointer from a helper STA to this thread leaves several drivers
    // running after a reset but with no callbacks.
    AsioComApartment apartment;
    bool initialized{false};
    bool buffersCreated{false};
    std::vector<AsioBufferInfo> buffers;
    std::vector<AsioChannelInfo> inputInfo, outputInfo;
    std::vector<float> captureScratch, renderScratch;
    long inputChannels{0}, outputChannels{0}, bufferFrames{0};
    long inputLatency{0}, outputLatency{0};
    double sampleRate{0.0};
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
    void openDriver(const std::string& requestedId) {
        const auto id = clsidFromText(requestedId.empty() ? firstAsioClsid() : requestedId);
        if (!apartment.start())
            throw std::runtime_error("ASIO COM apartment initialization failed");
        HRESULT result = E_FAIL;
        bool driverInitialized = false;
        apartment.invoke([&] {
            void* object = nullptr;
            result = CoCreateInstance(id, nullptr, CLSCTX_INPROC_SERVER, id, &object);
            driver = static_cast<IAsioDriver*>(object);
            driverInitialized = SUCCEEDED(result) && driver && driver->init(GetDesktopWindow()) != 0;
        });
        if (!driverInitialized) {
            if (driver) {
                apartment.invoke([this] { driver->Release(); });
                driver = nullptr;
            }
            apartment.reset();
            if (SUCCEEDED(result))
                throw std::runtime_error("ASIO driver init failed");
            char code[48]{};
            std::snprintf(code, sizeof(code), " (0x%08lX)", static_cast<unsigned long>(result));
            throw std::runtime_error(std::string("ASIO driver activation failed") + code);
        }
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
                    AsioSampleConversion::read(
                        buffers[static_cast<std::size_t>(ch)].buffers[index],
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
                AsioSampleConversion::write(
                    buffers[bi].buffers[index], outputInfo[static_cast<std::size_t>(ch)].type, f,
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
            try {
                apartment.invoke([this] {
                    if (buffersCreated) {
                        driver->disposeBuffers();
                        buffersCreated = false;
                    }
                    if (initialized) {
                        driver->Release();
                        initialized = false;
                    }
                });
            } catch (...) {
                buffersCreated = false;
                initialized = false;
            }
            driver = nullptr;
        }
        apartment.reset();
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
    AudioDeviceCapabilities caps;
    double currentRate = 0;
    temp.apartment.invoke([&] {
        checkAsio(temp.driver->getChannels(&in, &out), "ASIO getChannels failed");
        checkAsio(temp.driver->getBufferSize(&min, &max, &pref, &gran),
                  "ASIO getBufferSize failed");
        checkAsio(temp.driver->getSampleRate(&currentRate), "ASIO getSampleRate failed");
        if (!(currentRate > 0))
            throw std::runtime_error("ASIO driver reported an invalid sample rate");
        caps.defaultSampleRateHz = static_cast<std::uint32_t>(std::llround(currentRate));
        caps.sampleRatesHz.clear();
        if (currentRate > 0)
            caps.sampleRatesHz.push_back(static_cast<std::uint32_t>(std::llround(currentRate)));
    });
    caps.minPeriodFrames = static_cast<std::uint32_t>(std::max(1L, min));
    caps.maxPeriodFrames = static_cast<std::uint32_t>(std::max(min, max));
    caps.defaultPeriodFrames = static_cast<std::uint32_t>(std::clamp(pref, min, max));
    caps.fundamentalPeriodFrames = gran > 0 ? static_cast<std::uint32_t>(gran) : 1U;
    if (gran == -1) {
        for (long frames = 1; frames <= max && frames > 0; frames *= 2)
            if (frames >= min)
                caps.periodFrames.push_back(static_cast<std::uint32_t>(frames));
    } else if (gran == 0) {
        // ASIO reports zero granularity when every integer buffer size in the range is valid. An
        // empty explicit list preserves that driver contract without manufacturing UI choices.
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
    long min = 0, max = 0, pref = 0, gran = 0;
    impl_->apartment.invoke([&] {
        checkAsio(impl_->driver->getChannels(&impl_->inputChannels, &impl_->outputChannels),
                  "ASIO getChannels failed");
        checkAsio(impl_->driver->getBufferSize(&min, &max, &pref, &gran),
                  "ASIO getBufferSize failed");
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
            if (!AsioSampleConversion::isSupported(info.type))
                throw std::runtime_error("ASIO input channel uses an unsupported sample format");
        }
        for (long ch = 0; ch < outUse; ++ch) {
            const auto i = static_cast<std::size_t>(inUse + ch);
            impl_->buffers[i] = {0, ch, {nullptr, nullptr}};
            auto& info = impl_->outputInfo[static_cast<std::size_t>(ch)];
            info.channel = ch;
            info.isInput = 0;
            checkAsio(impl_->driver->getChannelInfo(&info), "ASIO output channel info failed");
            if (!AsioSampleConversion::isSupported(info.type))
                throw std::runtime_error("ASIO output channel uses an unsupported sample format");
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
    });
    const auto inUse = impl_->inputChannels;
    const auto outUse = impl_->outputChannels;
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
    impl_->apartment.invoke(
        [this] { checkAsio(impl_->driver->start(), "ASIO start failed"); });
}
void AsioBackend::stop() noexcept {
    if (impl_->driver && impl_->running.exchange(false, std::memory_order_acq_rel)) {
        try {
            impl_->apartment.invoke([this] { (void)impl_->driver->stop(); });
        } catch (...) {
        }
    }
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
