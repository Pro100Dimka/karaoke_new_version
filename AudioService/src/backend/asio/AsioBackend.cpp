#ifdef _WIN32
#include "backend/asio/AsioBackend.hpp"
#include "backend/asio/AsioAbi.hpp"
#include "backend/asio/AsioComApartment.hpp"
#include "backend/asio/AsioNegotiation.hpp"
#include "backend/asio/AsioSampleConversion.hpp"
#ifndef WIN32_LEAN_AND_MEAN
#define WIN32_LEAN_AND_MEAN
#endif
#ifndef NOMINMAX
#define NOMINMAX
#endif
#include <algorithm>
#include <array>
#include <atomic>
#include <cmath>
#include <cstdio>
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
    explicit Impl(DriverFactory factory = {}) : driverFactory(std::move(factory)) {}
    ~Impl() {
        closeAll();
    }
    DriverFactory driverFactory;
    static std::atomic<Impl*> active;
    static std::atomic<unsigned> readers;
    static std::atomic<bool> draining;
    struct CallbackScope {
        Impl* self;
        CallbackScope() noexcept {
            readers.fetch_add(1);
            self = active.load();
        }
        ~CallbackScope() {
            if (readers.fetch_sub(1) == 1 && draining.load())
                readers.notify_all();
        }
    };
    IAsioDriver* driver{nullptr};
    // Driver lifecycle operations run on their dedicated STA owner.
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
        const CallbackScope scope;
        if (scope.self)
            scope.self->process(index, direct);
    }
    static void sampleRateChanged(AsioSampleRate) {
        const CallbackScope scope;
        if (auto* self = scope.self; self && self->running.load(std::memory_order_acquire)) {
            if (self->callback)
                self->callback->onBackendEvent(self->generation,
                                               BackendEventType::SampleRateChanged, 0);
        }
    }
    static long asioMessage(long selector, long value, void*, double*) {
        const CallbackScope scope;
        auto* self = scope.self;
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
            if (self->running.load(std::memory_order_acquire) && self->callback)
                self->callback->onBackendEvent(self->generation, BackendEventType::DriverReset, 0);
            return 1;
        case AsioBufferSizeChange:
        case AsioResyncRequest:
            if (self->running.load(std::memory_order_acquire) && self->callback)
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
        if (!apartment.start())
            throw std::runtime_error("ASIO COM apartment initialization failed");
        HRESULT result = E_FAIL;
        bool driverInitialized = false;
        apartment.invoke([&] {
            void* object = nullptr;
            if (driverFactory) {
                driver = driverFactory(requestedId);
                result = driver ? S_OK : E_FAIL;
            } else {
                const auto id = clsidFromText(requestedId.empty() ? firstAsioClsid() : requestedId);
                result = CoCreateInstance(id, nullptr, CLSCTX_INPROC_SERVER, id, &object);
                driver = static_cast<IAsioDriver*>(object);
            }
            driverInitialized =
                SUCCEEDED(result) && driver && driver->init(GetDesktopWindow()) != 0;
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
        const auto presentation = monotonicTicksNow() + static_cast<MonotonicTicks>(
            static_cast<double>(std::max(0L, outputLatency)) * 1'000'000'000.0 / sampleRate);
        for (long offset = 0; offset < bufferFrames;) {
            const auto frames = std::min<long>(MaxBlockFrames, bufferFrames - offset);
            const auto framePosition = static_cast<std::int64_t>(asioInt64Value(position)) + offset;
            const auto timestamp = static_cast<MonotonicTicks>(asioInt64Value(stamp)) +
                                   static_cast<MonotonicTicks>(static_cast<double>(offset) *
                                                               1'000'000'000.0 / sampleRate);
            for (long f = 0; f < frames; ++f) {
                for (long ch = 0; ch < inputChannels; ++ch)
                    captureScratch[static_cast<std::size_t>(f) *
                                       static_cast<std::size_t>(inputChannels) +
                                   static_cast<std::size_t>(ch)] =
                        AsioSampleConversion::read(
                            buffers[static_cast<std::size_t>(ch)].buffers[index],
                            inputInfo[static_cast<std::size_t>(ch)].type, offset + f);
            }
            callback->onCapture(generation,
                                {captureScratch.data(), nullptr, static_cast<std::uint32_t>(frames),
                                 static_cast<std::uint32_t>(inputChannels), framePosition,
                                 timestamp, 0});
            callback->onRender(generation,
                               {nullptr, renderScratch.data(), static_cast<std::uint32_t>(frames),
                                static_cast<std::uint32_t>(outputChannels), framePosition,
                                timestamp, 0, presentation + static_cast<MonotonicTicks>(
                                    static_cast<double>(offset) * 1'000'000'000.0 / sampleRate)});
            for (long f = 0; f < frames; ++f) {
                for (long ch = 0; ch < outputChannels; ++ch) {
                    const auto bi = static_cast<std::size_t>(inputChannels + ch);
                    AsioSampleConversion::write(
                        buffers[bi].buffers[index], outputInfo[static_cast<std::size_t>(ch)].type,
                        offset + f,
                        renderScratch[static_cast<std::size_t>(f) *
                                          static_cast<std::size_t>(outputChannels) +
                                      static_cast<std::size_t>(ch)]);
                }
            }
            offset += frames;
        }
        (void)driver->outputReady();
    }
    void publish() {
        auto* expected = static_cast<Impl*>(nullptr);
        if (!active.compare_exchange_strong(expected, this) && expected != this)
            throw std::runtime_error("Another ASIO stream is already open in this process");
    }
    void stopAll() noexcept {
        const auto wasRunning = running.exchange(false, std::memory_order_acq_rel);
        auto* expected = this;
        const bool owned = active.compare_exchange_strong(expected, nullptr);
        if (driver && wasRunning) {
            try {
                apartment.invoke([this] { (void)driver->stop(); });
            } catch (...) {
            }
        }
        if (owned) {
            draining.store(true);
            for (auto count = readers.load(); count != 0; count = readers.load())
                readers.wait(count);
            draining.store(false);
        }
        callback = nullptr;
    }
    void closeAll() noexcept {
        stopAll();
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
    }
};
std::atomic<AsioBackend::Impl*> AsioBackend::Impl::active{nullptr};
std::atomic<unsigned> AsioBackend::Impl::readers{0};
std::atomic<bool> AsioBackend::Impl::draining{false};

AsioBackend::AsioBackend(DriverFactory factory)
    : impl_(std::make_unique<Impl>(std::move(factory))) {}
AsioBackend::~AsioBackend() = default;
AudioDeviceCapabilities AsioBackend::queryCapabilities(const RequestedConfiguration& requested) {
    Impl temp(impl_->driverFactory);
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
        caps.defaultSampleRateHz = AsioNegotiation::sampleRate(currentRate);
        caps.sampleRatesHz = {caps.defaultSampleRateHz};
        // ASIO has a rate predicate, not an enumeration. Probe the requested rate and common PCM
        // rates; the driver's current rate remains the fallback even if it is outside this list.
        const std::array candidates{requested.sampleRateHz,
                                    8000U,
                                    11025U,
                                    16000U,
                                    22050U,
                                    24000U,
                                    32000U,
                                    44100U,
                                    48000U,
                                    88200U,
                                    96000U,
                                    176400U,
                                    192000U,
                                    352800U,
                                    384000U};
        for (const auto rate : candidates)
            if (rate && std::ranges::find(caps.sampleRatesHz, rate) == caps.sampleRatesHz.end() &&
                asioSucceeded(temp.driver->canSampleRate(rate)))
                caps.sampleRatesHz.push_back(rate);
    });
    const AsioNegotiation::Periods periods{min, max, pref, gran};
    periods.validate();
    caps.minPeriodFrames = static_cast<std::uint32_t>(min);
    caps.maxPeriodFrames = static_cast<std::uint32_t>(max);
    caps.defaultPeriodFrames = periods.select(0);
    caps.fundamentalPeriodFrames = gran > 0 ? static_cast<std::uint32_t>(gran) : 1U;
    caps.periodFrames = periods.explicitSizes();
    caps.inputChannels = static_cast<std::uint32_t>(std::max(0L, in));
    caps.outputChannels = static_cast<std::uint32_t>(std::max(0L, out));
    temp.closeAll();
    return caps;
}
RuntimeConfiguration AsioBackend::open(const RequestedConfiguration& requested) {
    impl_->closeAll();
    try {
        impl_->openDriver(!requested.outputDeviceId.empty() ? requested.outputDeviceId
                                                            : requested.inputDeviceId);
        long min = 0, max = 0, pref = 0, gran = 0;
        impl_->apartment.invoke([&] {
            double current = 0;
            checkAsio(impl_->driver->getSampleRate(&current), "ASIO getSampleRate failed");
            if (requested.sampleRateHz &&
                AsioNegotiation::sampleRate(current) != requested.sampleRateHz &&
                asioSucceeded(impl_->driver->canSampleRate(requested.sampleRateHz)))
                checkAsio(impl_->driver->setSampleRate(requested.sampleRateHz),
                          "ASIO setSampleRate failed");
            checkAsio(impl_->driver->getSampleRate(&impl_->sampleRate),
                      "ASIO getSampleRate failed");
            (void)AsioNegotiation::sampleRate(impl_->sampleRate);
            checkAsio(impl_->driver->getChannels(&impl_->inputChannels, &impl_->outputChannels),
                      "ASIO getChannels failed");
            checkAsio(impl_->driver->getBufferSize(&min, &max, &pref, &gran),
                      "ASIO getBufferSize failed");
            impl_->bufferFrames = static_cast<long>(
                AsioNegotiation::Periods{min, max, pref, gran}.select(requested.periodFrames));
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
                    throw std::runtime_error(
                        "ASIO input channel uses an unsupported sample format");
            }
            for (long ch = 0; ch < outUse; ++ch) {
                const auto i = static_cast<std::size_t>(inUse + ch);
                impl_->buffers[i] = {0, ch, {nullptr, nullptr}};
                auto& info = impl_->outputInfo[static_cast<std::size_t>(ch)];
                info.channel = ch;
                info.isInput = 0;
                checkAsio(impl_->driver->getChannelInfo(&info), "ASIO output channel info failed");
                if (!AsioSampleConversion::isSupported(info.type))
                    throw std::runtime_error(
                        "ASIO output channel uses an unsupported sample format");
            }
            impl_->callbacks = {&Impl::bufferSwitch, &Impl::sampleRateChanged, &Impl::asioMessage,
                                &Impl::bufferSwitchTimeInfo};
            impl_->publish();
            checkAsio(impl_->driver->createBuffers(impl_->buffers.data(),
                                                   static_cast<long>(impl_->buffers.size()),
                                                   impl_->bufferFrames, &impl_->callbacks),
                      "ASIO createBuffers failed");
            impl_->buffersCreated = true;
            impl_->inputLatency = impl_->outputLatency = 0;
            if (!asioSucceeded(
                    impl_->driver->getLatencies(&impl_->inputLatency, &impl_->outputLatency)))
                impl_->inputLatency = impl_->outputLatency = 0;
        });
        const auto inUse = impl_->inputChannels;
        const auto outUse = impl_->outputChannels;
        const auto scratchFrames =
            static_cast<std::size_t>(std::min<long>(impl_->bufferFrames, MaxBlockFrames));
        impl_->captureScratch.assign(scratchFrames * static_cast<std::size_t>(inUse), 0.0F);
        impl_->renderScratch.assign(scratchFrames * static_cast<std::size_t>(outUse), 0.0F);
        return {AsioNegotiation::sampleRate(impl_->sampleRate),
                AsioNegotiation::sampleRate(impl_->sampleRate),
                static_cast<std::uint32_t>(impl_->bufferFrames),
                static_cast<std::uint32_t>(impl_->bufferFrames),
                static_cast<std::uint32_t>(impl_->bufferFrames) * 2U,
                static_cast<std::uint32_t>(impl_->bufferFrames) * 2U,
                static_cast<std::uint32_t>(inUse),
                static_cast<std::uint32_t>(outUse),
                AudioSampleFormat::Float32,
                AudioSampleFormat::Float32,
                ClockRelationship::SameDomain,
                static_cast<std::uint32_t>(std::max(0L, impl_->inputLatency)),
                static_cast<std::uint32_t>(std::max(0L, impl_->outputLatency))};
    } catch (...) {
        impl_->closeAll();
        throw;
    }
}
void AsioBackend::start(IAudioCallback& callback, GenerationId generation) {
    if (impl_->running.load(std::memory_order_acquire))
        throw std::logic_error("ASIO backend is already started");
    if (!impl_->driver || !impl_->buffersCreated)
        throw std::logic_error("ASIO backend is not open");
    impl_->publish();
    impl_->callback = &callback;
    impl_->generation = generation;
    impl_->running.store(true, std::memory_order_release);
    try {
        impl_->apartment.invoke([this] { checkAsio(impl_->driver->start(), "ASIO start failed"); });
    } catch (...) {
        impl_->stopAll();
        throw;
    }
}
void AsioBackend::stop() noexcept {
    impl_->stopAll();
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
