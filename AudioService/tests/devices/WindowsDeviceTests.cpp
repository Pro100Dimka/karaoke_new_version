#include "TestHarness.hpp"
#ifdef _WIN32
#include "devices/DeviceManager.hpp"
#include "app/AudioService.hpp"
#include "backend/fake/FakeAudioBackend.hpp"
#include <atomic>
#include <chrono>
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

void recordingFinishRecoveryPreservesDeviceNotifications() {
#ifdef _WIN32
    for (unsigned scenario = 0; scenario < 3; ++scenario) {
        const auto pending = scenario != 0;
        const auto pause = scenario == 2;
        CapturedNotifications enumerator;
        AudioService service{std::make_unique<FakeAudioBackend>()};
        service.start();
        const auto command = [&](const std::string& text) {
            require(service.handleLine("1|" + text).status == ControlStatus::Ok,
                    "device-generation fixture needs a successful recording/session command");
        };
        // The real command must publish the initial generation. Setting it through test access
        // would hide the missing publication when a later recording command reopens the device.
        command("PrepareSession|backend=fake");
        command("StartSession");
        auto& devices = AudioServiceTestAccess::devices(service);
        devices.stopNotifications();
        DeviceEvent oldNotification;
        while (devices.popEvent(oldNotification)) {}
        require(DeviceManagerTestAccess::start(devices, &enumerator) && enumerator.client,
                "recording recovery uses the real notification client with a controllable source");
        require(service.session().runtime().inputChannels != 0 &&
                    deviceEventRequiresRecovery({DeviceEventType::DefaultChanged, Direction::Output,
                                                  "new-default", service.session().generationId()},
                                                service.session().requested()),
                "the fixture follows the default output and rejects genuinely stale generations");
        const auto path = tempRoot / ("finish-device-generation-" + std::to_string(scenario) + ".wav");
        command("PrepareRecording|id=device-generation|tap=performance|path=" + path.string());
        command("StartRecording");
        auto& engine = service.realtime();
        engine.setDspEnabled(false);
        const auto generation = service.session().generationId();
        const auto origin = monotonicTicksNow() - 5'000'000'000LL;
        std::vector<float> input(480, 0.1F), output(960);
        const auto capture = [&](std::uint32_t frame) {
            const auto at = origin + static_cast<MonotonicTicks>(frame) * 1'000'000'000LL / 48'000;
            engine.onCapture(generation, {input.data(), nullptr, 480, 1, frame, at / 100, 0, 0, at});
        };
        for (std::uint32_t frame = 0; frame < 2'400; frame += 480) {
            capture(frame);
            const auto at = origin + static_cast<MonotonicTicks>(frame) * 1'000'000'000LL / 48'000;
            engine.onRender(generation, {nullptr, output.data(), 480, 2, frame,
                                          (at + 10'000'000) / 100, 0, at + 30'000'000});
        }
        if (pending)
            capture(2'400);
        ControlResponse response;
        std::atomic<bool> done{false};
        std::jthread control([&] {
            response = service.handleLine(pause ? "1|PauseRecording" : "1|StopRecording");
            done.store(true, std::memory_order_release);
        });
        if (pending) {
            const auto deadline = std::chrono::steady_clock::now() + std::chrono::seconds(1);
            while (!engine.recordingFinishPending() && !done.load(std::memory_order_acquire) &&
                   std::chrono::steady_clock::now() < deadline)
                std::this_thread::yield();
            require(engine.recordingFinishPending(),
                    "the recording command publishes its boundary before the simulated device loss");
            engine.onBackendEvent(generation, BackendEventType::DeviceLost, -17);
        }
        control.join();
        const auto afterFinish = service.session().generationId();
        require(response.status == ControlStatus::Ok &&
                    service.session().state() == SessionState::Running &&
                    (pending ? afterFinish > generation : afterFinish == generation) &&
                    engine.pendingBackendEvent().sequence == 0,
                "normal finish keeps its generation; fatal finish recovers and consumes its backend event");
        require(enumerator.client->OnDefaultDeviceChanged(eRender, eConsole, L"new-default") == S_OK,
                "the Windows notification client accepts the new default output event");
        command("GetDiagnostics");
        expect(service.session().generationId() > afterFinish &&
                   service.session().state() == SessionState::Running,
               "default-device notifications still recover the session after Stop/Pause reopens it");
        service.shutdown();
    }
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
