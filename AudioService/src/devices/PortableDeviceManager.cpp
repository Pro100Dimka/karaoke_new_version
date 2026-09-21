#include "devices/DeviceManager.hpp"

#include <atomic>

struct DeviceManager::Impl {
    std::atomic<GenerationId> generation{GenerationId{0}};
};

DeviceManager::DeviceManager() : impl_(std::make_unique<Impl>()) {}
DeviceManager::~DeviceManager() = default;
std::vector<DeviceInfo> DeviceManager::enumerate() {
    return {
        {"fake-input", "Fake Input", BackendKind::Fake, Direction::Input, 2, "test", true, true},
        {"fake-output", "Fake Output", BackendKind::Fake, Direction::Output, 2, "test", true,
         true}};
}
bool DeviceManager::startNotifications() noexcept {
    return true;
}
void DeviceManager::stopNotifications() noexcept {}
void DeviceManager::setGeneration(GenerationId generationId) noexcept {
    impl_->generation.store(generationId, std::memory_order_release);
}
bool DeviceManager::popEvent(DeviceEvent&) noexcept {
    return false;
}
