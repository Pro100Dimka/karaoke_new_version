#pragma once

#include "common/Types.hpp"

#include <string_view>

class IAudioCallback {
  public:
    virtual ~IAudioCallback() = default;
    virtual void onCapture(GenerationId generation, const BackendAudioBuffer& buffer) noexcept = 0;
    virtual void onRender(GenerationId generation, const BackendAudioBuffer& buffer) noexcept = 0;
    virtual void onBackendEvent(GenerationId generation, BackendEventType event,
                                std::int32_t code) noexcept = 0;
};

struct BackendSnapshot {
    bool open{false};
    bool running{false};
    std::uint32_t renderPaddingFrames{0};
    std::uint64_t xruns{0};
    std::uint64_t deadlineMisses{0};
    bool mmcssActive{false};
};

class IAudioBackend {
  public:
    virtual ~IAudioBackend() = default;
    [[nodiscard]] virtual std::string_view name() const noexcept = 0;
    virtual AudioDeviceCapabilities queryCapabilities(const RequestedConfiguration& requested) = 0;
    virtual RuntimeConfiguration open(const RequestedConfiguration& requested) = 0;
    virtual void start(IAudioCallback& callback, GenerationId generation) = 0;
    virtual void stop() noexcept = 0;
    virtual void close() noexcept = 0;
    [[nodiscard]] virtual BackendSnapshot snapshot() const noexcept = 0;
};
