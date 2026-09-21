#ifdef _WIN32

#ifndef WIN32_LEAN_AND_MEAN
#define WIN32_LEAN_AND_MEAN
#endif
#ifndef NOMINMAX
#define NOMINMAX
#endif

// Keep the Windows SDK include order used by the Core Audio samples.
// mmdeviceapi.h establishes the property-system types required by
// functiondiscoverykeys_devpkey.h.
#include <windows.h>
#include <mmdeviceapi.h>
#include <functiondiscoverykeys_devpkey.h>
#include <audioclient.h>
#include <propsys.h>
#include <wrl/client.h>

#include "devices/DeviceManager.hpp"
#include "realtime/RealtimeInstrumentation.hpp"

#include <array>
#include <atomic>
#include <mutex>
#include <new>
#include <optional>
#include <string>
#include <vector>

using Microsoft::WRL::ComPtr;
namespace {
std::string narrow(const wchar_t* text) {
    if (text == nullptr)
        return {};
    const auto count = WideCharToMultiByte(CP_UTF8, 0, text, -1, nullptr, 0, nullptr, nullptr);
    if (count <= 0)
        return {};
    std::string out(static_cast<std::size_t>(count), '\0');
    WideCharToMultiByte(CP_UTF8, 0, text, -1, out.data(), count, nullptr, nullptr);
    out.resize(static_cast<std::size_t>(count - 1));
    return out;
}
Direction directionFor(EDataFlow flow) noexcept {
    return flow == eRender ? Direction::Output : Direction::Input;
}
void enumerateFlow(IMMDeviceEnumerator* enumerator, EDataFlow flow, Direction direction,
                   std::vector<DeviceInfo>& out) {
    ComPtr<IMMDeviceCollection> collection;
    if (FAILED(enumerator->EnumAudioEndpoints(
            flow, DEVICE_STATE_ACTIVE | DEVICE_STATE_DISABLED | DEVICE_STATE_UNPLUGGED,
            &collection)))
        return;
    ComPtr<IMMDevice> defaultDevice;
    LPWSTR defaultId = nullptr;
    if (SUCCEEDED(enumerator->GetDefaultAudioEndpoint(flow, eConsole, &defaultDevice)) &&
        defaultDevice)
        (void)defaultDevice->GetId(&defaultId);
    UINT count = 0;
    (void)collection->GetCount(&count);
    for (UINT index = 0; index < count; ++index) {
        ComPtr<IMMDevice> device;
        if (FAILED(collection->Item(index, &device)))
            continue;
        LPWSTR id = nullptr;
        if (FAILED(device->GetId(&id)))
            continue;
        DWORD state = 0;
        (void)device->GetState(&state);
        ComPtr<IPropertyStore> properties;
        std::string name;
        if (SUCCEEDED(device->OpenPropertyStore(STGM_READ, &properties))) {
            PROPVARIANT value;
            PropVariantInit(&value);
            if (SUCCEEDED(properties->GetValue(PKEY_Device_FriendlyName, &value)) &&
                value.vt == VT_LPWSTR)
                name = narrow(value.pwszVal);
            PropVariantClear(&value);
        }
        std::uint32_t channels = 0;
        ComPtr<IAudioClient> client;
        if (SUCCEEDED(device->Activate(__uuidof(IAudioClient), CLSCTX_ALL, nullptr, &client))) {
            WAVEFORMATEX* format = nullptr;
            if (SUCCEEDED(client->GetMixFormat(&format)) && format != nullptr) {
                channels = format->nChannels;
                CoTaskMemFree(format);
            }
        }
        out.push_back({narrow(id),
                       name,
                       BackendKind::WasapiShared,
                       direction,
                       channels,
                       {},
                       defaultId != nullptr && wcscmp(defaultId, id) == 0,
                       (state & DEVICE_STATE_ACTIVE) != 0});
        CoTaskMemFree(id);
    }
    if (defaultId != nullptr)
        CoTaskMemFree(defaultId);
}
void enumerateAsio(std::vector<DeviceInfo>& out) {
    HKEY root = nullptr;
    if (RegOpenKeyExW(HKEY_LOCAL_MACHINE, L"SOFTWARE\\ASIO", 0, KEY_READ, &root) != ERROR_SUCCESS)
        return;
    DWORD index = 0;
    wchar_t name[256]{};
    DWORD nameChars = 256;
    while (RegEnumKeyExW(root, index++, name, &nameChars, nullptr, nullptr, nullptr, nullptr) ==
           ERROR_SUCCESS) {
        HKEY key = nullptr;
        if (RegOpenKeyExW(root, name, 0, KEY_READ, &key) == ERROR_SUCCESS) {
            wchar_t clsid[128]{};
            DWORD bytes = sizeof(clsid);
            std::string id;
            if (RegQueryValueExW(key, L"CLSID", nullptr, nullptr, reinterpret_cast<BYTE*>(clsid),
                                 &bytes) == ERROR_SUCCESS)
                id = narrow(clsid);
            const auto display = narrow(name);
            out.push_back({id, display, BackendKind::Asio, Direction::Input, 0, {}, false, true});
            out.push_back({id, display, BackendKind::Asio, Direction::Output, 0, {}, false, true});
            RegCloseKey(key);
        }
        nameChars = 256;
    }
    RegCloseKey(root);
}
} // namespace

struct DeviceManager::Impl {
    static constexpr std::size_t QueueCapacity = 64;

    class NotificationClient final : public IMMNotificationClient {
      public:
        explicit NotificationClient(Impl& owner) : owner_(owner) {}
        ULONG STDMETHODCALLTYPE AddRef() override {
            return refs_.fetch_add(1, std::memory_order_relaxed) + 1U;
        }
        ULONG STDMETHODCALLTYPE Release() override {
            const auto refs = refs_.fetch_sub(1, std::memory_order_acq_rel) - 1U;
            if (refs == 0)
                delete this;
            return refs;
        }
        HRESULT STDMETHODCALLTYPE QueryInterface(REFIID iid, void** object) override {
            if (object == nullptr)
                return E_POINTER;
            if (iid == __uuidof(IUnknown) || iid == __uuidof(IMMNotificationClient)) {
                *object = static_cast<IMMNotificationClient*>(this);
                AddRef();
                return S_OK;
            }
            *object = nullptr;
            return E_NOINTERFACE;
        }
        HRESULT STDMETHODCALLTYPE OnDeviceStateChanged(LPCWSTR id, DWORD state) override {
            owner_.push({(state & DEVICE_STATE_ACTIVE) != 0 ? DeviceEventType::Enabled
                                                            : DeviceEventType::Disabled,
                         Direction::Input, narrow(id),
                         owner_.generation.load(std::memory_order_acquire)});
            return S_OK;
        }
        HRESULT STDMETHODCALLTYPE OnDeviceAdded(LPCWSTR id) override {
            owner_.push({DeviceEventType::Added, Direction::Input, narrow(id),
                         owner_.generation.load(std::memory_order_acquire)});
            return S_OK;
        }
        HRESULT STDMETHODCALLTYPE OnDeviceRemoved(LPCWSTR id) override {
            owner_.push({DeviceEventType::Removed, Direction::Input, narrow(id),
                         owner_.generation.load(std::memory_order_acquire)});
            return S_OK;
        }
        HRESULT STDMETHODCALLTYPE OnDefaultDeviceChanged(EDataFlow flow, ERole,
                                                         LPCWSTR id) override {
            owner_.push({DeviceEventType::DefaultChanged, directionFor(flow), narrow(id),
                         owner_.generation.load(std::memory_order_acquire)});
            return S_OK;
        }
        HRESULT STDMETHODCALLTYPE OnPropertyValueChanged(LPCWSTR id, const PROPERTYKEY) override {
            owner_.push({DeviceEventType::PropertyChanged, Direction::Input, narrow(id),
                         owner_.generation.load(std::memory_order_acquire)});
            return S_OK;
        }

      private:
        std::atomic<ULONG> refs_{1};
        Impl& owner_;
    };

    void push(DeviceEvent event) noexcept {
        try {
            std::lock_guard lock(queueMutex);
            if (count == QueueCapacity) {
                head = (head + 1U) % QueueCapacity;
                --count;
                ++dropped;
            }
            queue[(head + count) % QueueCapacity] = std::move(event);
            ++count;
        } catch (...) {
            ++dropped;
        }
    }
    bool pop(DeviceEvent& event) noexcept {
        std::lock_guard lock(queueMutex);
        if (count == 0)
            return false;
        event = std::move(*queue[head]);
        queue[head].reset();
        head = (head + 1U) % QueueCapacity;
        --count;
        return true;
    }

    std::atomic<GenerationId> generation{GenerationId{0}};
    std::array<std::optional<DeviceEvent>, QueueCapacity> queue{};
    std::size_t head{0};
    std::size_t count{0};
    std::uint64_t dropped{0};
    RealtimeMutex queueMutex;
    ComPtr<IMMDeviceEnumerator> enumerator;
    NotificationClient* client{nullptr};
    bool comInitialized{false};
};

DeviceManager::DeviceManager() : impl_(std::make_unique<Impl>()) {}
DeviceManager::~DeviceManager() {
    stopNotifications();
}

std::vector<DeviceInfo> DeviceManager::enumerate() {
    const auto init = CoInitializeEx(nullptr, COINIT_MULTITHREADED);
    const bool uninit = SUCCEEDED(init);
    std::vector<DeviceInfo> out;
    ComPtr<IMMDeviceEnumerator> enumerator;
    if (SUCCEEDED(CoCreateInstance(__uuidof(MMDeviceEnumerator), nullptr, CLSCTX_ALL,
                                   IID_PPV_ARGS(&enumerator)))) {
        enumerateFlow(enumerator.Get(), eCapture, Direction::Input, out);
        enumerateFlow(enumerator.Get(), eRender, Direction::Output, out);
    }
    enumerateAsio(out);
    if (uninit)
        CoUninitialize();
    return out;
}

bool DeviceManager::startNotifications() noexcept {
    if (impl_->client != nullptr)
        return true;
    const auto hr = CoInitializeEx(nullptr, COINIT_MULTITHREADED);
    if (SUCCEEDED(hr))
        impl_->comInitialized = true;
    else if (hr != RPC_E_CHANGED_MODE)
        return false;
    if (FAILED(CoCreateInstance(__uuidof(MMDeviceEnumerator), nullptr, CLSCTX_ALL,
                                IID_PPV_ARGS(&impl_->enumerator))))
        return false;
    impl_->client = new (std::nothrow) Impl::NotificationClient(*impl_);
    if (impl_->client == nullptr)
        return false;
    if (FAILED(impl_->enumerator->RegisterEndpointNotificationCallback(impl_->client))) {
        impl_->client->Release();
        impl_->client = nullptr;
        return false;
    }
    return true;
}
void DeviceManager::stopNotifications() noexcept {
    if (!impl_)
        return;
    if (impl_->enumerator && impl_->client)
        (void)impl_->enumerator->UnregisterEndpointNotificationCallback(impl_->client);
    if (impl_->client) {
        impl_->client->Release();
        impl_->client = nullptr;
    }
    impl_->enumerator.Reset();
    if (impl_->comInitialized) {
        CoUninitialize();
        impl_->comInitialized = false;
    }
}
void DeviceManager::setGeneration(GenerationId generationId) noexcept {
    impl_->generation.store(generationId, std::memory_order_release);
}
bool DeviceManager::popEvent(DeviceEvent& event) noexcept {
    return impl_->pop(event);
}
#endif
