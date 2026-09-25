#pragma once
#ifdef _WIN32
#include "backend/IAudioBackend.hpp"
#include <functional>
#include <memory>
struct IAsioDriver;
class AsioBackend final : public IAudioBackend {
  public:
    using DriverFactory = std::function<IAsioDriver*(const std::string&)>;
    explicit AsioBackend(DriverFactory driverFactory = {});
    ~AsioBackend() override;
    [[nodiscard]] std::string_view name() const noexcept override {
        return "ASIO";
    }
    AudioDeviceCapabilities queryCapabilities(const RequestedConfiguration& requested) override;
    RuntimeConfiguration open(const RequestedConfiguration& requested) override;
    void start(IAudioCallback& callback, GenerationId generation) override;
    void stop() noexcept override;
    void close() noexcept override;
    [[nodiscard]] BackendSnapshot snapshot() const noexcept override;

  private:
    struct Impl;
    std::unique_ptr<Impl> impl_;
};
#endif
