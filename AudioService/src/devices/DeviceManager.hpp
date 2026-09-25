#pragma once

#include "common/Types.hpp"

#include <cstdint>
#include <memory>
#include <string>
#include <vector>

#ifdef _WIN32
struct IMMDeviceEnumerator;
#endif

enum class DeviceEventType {
    Added,
    Removed,
    Enabled,
    Disabled,
    DefaultChanged,
    PropertyChanged,
    FormatChanged
};

struct DeviceEvent {
    DeviceEventType type{DeviceEventType::PropertyChanged};
    Direction direction{Direction::Input};
    std::string deviceId;
    GenerationId generationId{0};
};

[[nodiscard]] bool deviceEventRequiresRecovery(const DeviceEvent& event,
                                               const RequestedConfiguration& requested) noexcept;

class DeviceManager {
  public:
    DeviceManager();
    ~DeviceManager();
    DeviceManager(const DeviceManager&) = delete;
    DeviceManager& operator=(const DeviceManager&) = delete;

    [[nodiscard]] std::vector<DeviceInfo> enumerate();
    [[nodiscard]] bool startNotifications() noexcept;
    void stopNotifications() noexcept;
    void setGeneration(GenerationId generationId) noexcept;
    [[nodiscard]] bool popEvent(DeviceEvent& event) noexcept;

  private:
#ifdef _WIN32
    friend struct DeviceManagerTestAccess;
    [[nodiscard]] bool startNotifications(IMMDeviceEnumerator* suppliedEnumerator) noexcept;
#endif
    struct Impl;
    std::unique_ptr<Impl> impl_;
};
