#pragma once

#include "common/Types.hpp"

#include <cstdint>
#include <memory>
#include <string>
#include <vector>

enum class DeviceEventType { Added, Removed, Enabled, Disabled, DefaultChanged, PropertyChanged };

struct DeviceEvent {
    DeviceEventType type{DeviceEventType::PropertyChanged};
    Direction direction{Direction::Input};
    std::string deviceId;
    GenerationId generationId{0};
};

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
    struct Impl;
    std::unique_ptr<Impl> impl_;
};
