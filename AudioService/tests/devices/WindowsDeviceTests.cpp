#include "TestHarness.hpp"
#ifdef _WIN32
#include "devices/DeviceManager.hpp"
#include "app/AudioService.hpp"
#include "backend/fake/FakeAudioBackend.hpp"
#include <mmdeviceapi.h>
#include <thread>
#include <limits>

struct AudioServiceTestAccess {
    static DeviceManager& devices(AudioService& service) { return service.devices_; }
};

struct DeviceManagerTestAccess {
    static bool start(DeviceManager& manager, IMMDeviceEnumerator* enumerator) {
        return manager.startNotifications(enumerator);
    }
};
namespace {
struct UnavailableNotifications : IMMDeviceEnumerator {
    ULONG references{1};
    HRESULT STDMETHODCALLTYPE QueryInterface(REFIID, void** result) override {
        *result = nullptr;
        return E_NOINTERFACE;
    }
    ULONG STDMETHODCALLTYPE AddRef() override {
        return ++references;
    }
    ULONG STDMETHODCALLTYPE Release() override {
        return --references;
    }
    HRESULT STDMETHODCALLTYPE EnumAudioEndpoints(EDataFlow, DWORD, IMMDeviceCollection**) override {
        return E_NOTIMPL;
    }
    HRESULT STDMETHODCALLTYPE GetDefaultAudioEndpoint(EDataFlow, ERole, IMMDevice**) override {
        return E_NOTIMPL;
    }
    HRESULT STDMETHODCALLTYPE GetDevice(LPCWSTR, IMMDevice**) override {
        return E_NOTIMPL;
    }
    HRESULT STDMETHODCALLTYPE
    RegisterEndpointNotificationCallback(IMMNotificationClient*) override {
        return E_FAIL;
    }
    HRESULT STDMETHODCALLTYPE
    UnregisterEndpointNotificationCallback(IMMNotificationClient*) override {
        return S_OK;
    }
};

struct CapturedNotifications final : UnavailableNotifications {
    IMMNotificationClient* client{nullptr};
    HRESULT STDMETHODCALLTYPE RegisterEndpointNotificationCallback(IMMNotificationClient* value) override {
        client = value;
        client->AddRef();
        return S_OK;
    }
    HRESULT STDMETHODCALLTYPE UnregisterEndpointNotificationCallback(IMMNotificationClient* value) override {
        if (value == client) { client->Release(); client = nullptr; }
        return S_OK;
    }
};
} // namespace
#endif
namespace Tests {
void asioSystemVolumeFollowsTheNewWindowsDefault() {
#ifdef _WIN32
    CapturedNotifications enumerator;
    AudioService service(std::make_unique<FakeAudioBackend>());
    service.start();
    RequestedConfiguration requested;
    requested.backend = BackendKind::Asio;
    service.session().prepare(requested);
    service.session().start();
    auto& devices = AudioServiceTestAccess::devices(service);
    devices.stopNotifications();
    devices.setGeneration(service.session().generationId());
    require(DeviceManagerTestAccess::start(devices, &enumerator) && enumerator.client,
            "the device manager subscribes to a controllable endpoint notification source");
    const auto generation = service.session().generationId();
    for (const auto flow : {eCapture, eRender}) {
        service.realtime().setSystemGain(std::numeric_limits<float>::quiet_NaN());
        enumerator.client->OnDefaultDeviceChanged(flow, eConsole, L"new-default");
        (void)service.handleLine("1|GetDiagnostics");
        expect(std::isfinite(service.realtime().systemGain()) == (flow == eRender),
               "only a new default output rebinds ASIO system-volume following");
        expect(service.session().generationId() == generation && service.session().state() == SessionState::Running,
               "Windows volume following never reopens the ASIO driver");
    }
    service.shutdown();
#endif
}

void deviceNotificationFailureReleasesComBeforeRetry() {
#ifdef _WIN32
    bool balanced = true;
    std::thread worker([&] {
        DeviceManager manager;
        UnavailableNotifications enumerator;
        for (int retry = 0; retry < 3; ++retry) {
            const auto started = DeviceManagerTestAccess::start(manager, &enumerator);
            APTTYPE apartment;
            APTTYPEQUALIFIER qualifier;
            balanced = balanced && !started && enumerator.references == 1 &&
                       CoGetApartmentType(&apartment, &qualifier) == CO_E_NOTINITIALIZED;
        }
        manager.stopNotifications();
    });
    worker.join();
    expect(balanced,
           "notification failure rolls back COM and enumerator ownership before every retry");
#endif
}
} // namespace Tests
