#ifdef _WIN32
#include "backend/wasapi/SystemVolumeFollower.hpp"
#include "common/WindowsText.hpp"

#include <algorithm>
#include <atomic>
#include <cmath>
#include <endpointvolume.h>
#include <mmdeviceapi.h>
#include <wrl/client.h>

using Microsoft::WRL::ComPtr;

namespace {
// Receives Windows volume notifications for one endpoint and hands the new gain to the sink.
class VolumeCallback final : public IAudioEndpointVolumeCallback {
  public:
    VolumeCallback(IAudioEndpointVolume* volume, std::function<void(float)> sink)
        : volume_(volume), sink_(std::move(sink)) {}

    void publish() const noexcept {
        float decibels = 0.0F;
        BOOL muted = FALSE;
        if (FAILED(volume_->GetMasterVolumeLevel(&decibels)) || FAILED(volume_->GetMute(&muted)))
            return;
        sink_(SystemVolumeFollower::gainFor(decibels, muted != FALSE));
    }

    HRESULT STDMETHODCALLTYPE OnNotify(PAUDIO_VOLUME_NOTIFICATION_DATA) override {
        publish();
        return S_OK;
    }
    ULONG STDMETHODCALLTYPE AddRef() override { return ++references_; }
    ULONG STDMETHODCALLTYPE Release() override {
        const auto left = --references_;
        if (left == 0)
            delete this;
        return left;
    }
    HRESULT STDMETHODCALLTYPE QueryInterface(REFIID id, void** object) override {
        if (object == nullptr)
            return E_POINTER;
        if (id == __uuidof(IUnknown) || id == __uuidof(IAudioEndpointVolumeCallback)) {
            *object = static_cast<IAudioEndpointVolumeCallback*>(this);
            AddRef();
            return S_OK;
        }
        *object = nullptr;
        return E_NOINTERFACE;
    }

  private:
    ComPtr<IAudioEndpointVolume> volume_;
    std::function<void(float)> sink_;
    std::atomic<ULONG> references_{1};
};
} // namespace

struct SystemVolumeFollower::Impl {
    ComPtr<IAudioEndpointVolume> volume;
    ComPtr<VolumeCallback> callback;
};

SystemVolumeFollower::SystemVolumeFollower(std::function<void(float)> sink)
    : sink_(std::move(sink)), impl_(std::make_unique<Impl>()) {}

SystemVolumeFollower::~SystemVolumeFollower() {
    stop();
}

float SystemVolumeFollower::gainFor(float volumeDb, bool muted) noexcept {
    return muted ? 0.0F : std::pow(10.0F, std::min(0.0F, volumeDb) / 20.0F);
}

void SystemVolumeFollower::stop() noexcept {
    if (impl_->volume && impl_->callback)
        impl_->volume->UnregisterControlChangeNotify(impl_->callback.Get());
    impl_->callback.Reset();
    impl_->volume.Reset();
    sink_(1.0F);
}

void SystemVolumeFollower::follow(const std::string& endpointId, Stream stream) noexcept {
    stop();
    if (stream == Stream::MixedByWindows)
        return;
    // The control thread keeps its apartment for the life of the service (an existing one of either
    // kind serves as well), so the registered notification stays valid.
    (void)CoInitializeEx(nullptr, COINIT_MULTITHREADED);
    ComPtr<IMMDeviceEnumerator> enumerator;
    ComPtr<IMMDevice> device;
    if (FAILED(CoCreateInstance(__uuidof(MMDeviceEnumerator), nullptr, CLSCTX_ALL,
                                IID_PPV_ARGS(&enumerator))))
        return;
    try {
        const auto found = endpointId.empty()
            ? enumerator->GetDefaultAudioEndpoint(eRender, eConsole, &device)
            : enumerator->GetDevice(widen(endpointId).c_str(), &device);
        if (FAILED(found) || FAILED(device->Activate(__uuidof(IAudioEndpointVolume), CLSCTX_ALL,
                                                     nullptr, &impl_->volume)))
            return;
    } catch (const std::exception&) {
        return; // an unreadable id: the stream keeps its full level
    }
    // Volume and mute applied by the device itself already reach this stream.
    DWORD hardware = 0;
    if (SUCCEEDED(impl_->volume->QueryHardwareSupport(&hardware)) &&
        (hardware & ENDPOINT_HARDWARE_SUPPORT_VOLUME) != 0 &&
        (hardware & ENDPOINT_HARDWARE_SUPPORT_MUTE) != 0) {
        impl_->volume.Reset();
        return;
    }
    impl_->callback.Attach(new VolumeCallback(impl_->volume.Get(), sink_));
    if (FAILED(impl_->volume->RegisterControlChangeNotify(impl_->callback.Get()))) {
        impl_->callback.Reset();
        impl_->volume.Reset();
        return;
    }
    impl_->callback->publish();
}
#endif
