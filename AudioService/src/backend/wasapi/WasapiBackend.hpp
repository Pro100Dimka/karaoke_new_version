#pragma once
#ifdef _WIN32
#include "backend/IAudioBackend.hpp"
#include <memory>

enum class WasapiMode { Shared, Exclusive };
class WasapiBackend final : public IAudioBackend {
  public:
    explicit WasapiBackend(WasapiMode mode);
    ~WasapiBackend() override;
    // "Exclusive" is a listening-mode choice. Room microphone capture stays shared so another
    // process/communications client cannot make the local singer disappear from the voice relay.
    [[nodiscard]] static constexpr WasapiMode captureModeFor(WasapiMode) noexcept {
        return WasapiMode::Shared;
    }
    [[nodiscard]] std::string_view name() const noexcept override;
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
