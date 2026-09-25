#include "TestHarness.hpp"
#ifdef _WIN32
#include "devices/DeviceManager.hpp"
#include <mmdeviceapi.h>
#include <thread>

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
} // namespace
#endif
namespace Tests {
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
