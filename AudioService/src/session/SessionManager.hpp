#pragma once

#include "backend/IAudioBackend.hpp"
#include "common/Types.hpp"
#include "diagnostics/TraceBuffer.hpp"
#include "realtime/RealtimeEngine.hpp"
#include "session/SessionState.hpp"

#include <memory>
#include <optional>

class SessionManager {
  public:
    SessionManager(std::unique_ptr<IAudioBackend> backend, RealtimeEngine& engine,
                   TraceBuffer& trace);
    void replaceBackend(std::unique_ptr<IAudioBackend> backend);
    RuntimeConfiguration prepare(RequestedConfiguration requested);
    void start();
    void stop() noexcept;
    RuntimeConfiguration reconfigure(RequestedConfiguration requested);
    bool openBackendControlPanel(const RequestedConfiguration& requested);
    bool recover();
    void suspend() noexcept;
    bool resume();
    [[nodiscard]] SessionState state() const noexcept {
        return state_;
    }
    [[nodiscard]] GenerationId generationId() const noexcept {
        return generationId_;
    }
    [[nodiscard]] const RequestedConfiguration& requested() const noexcept {
        return requested_;
    }
    [[nodiscard]] const RequestedConfiguration& selected() const noexcept {
        return selected_;
    }
    [[nodiscard]] const RuntimeConfiguration& runtime() const noexcept {
        return runtime_;
    }
    [[nodiscard]] const FinalSessionPlan& plan() const noexcept {
        return plan_;
    }
    [[nodiscard]] const std::optional<AudioDeviceCapabilities>& capabilities() const noexcept {
        return capabilities_;
    }
    [[nodiscard]] BackendSnapshot backendSnapshot() const noexcept {
        return backend_->snapshot();
    }
    [[nodiscard]] std::string_view backendName() const noexcept {
        return backend_->name();
    }

  private:
    RuntimeConfiguration prepare(RequestedConfiguration requested,
                                 bool reuseNegotiatedCapabilities);
    FinalSessionPlan buildPlan(const RuntimeConfiguration& runtime) const;
    RequestedConfiguration chooseSupported(RequestedConfiguration requested,
                                           const AudioDeviceCapabilities& capabilities) const;
    void setState(SessionState state) noexcept;
    void invalidateGeneration() noexcept;

    std::unique_ptr<IAudioBackend> backend_;
    RealtimeEngine& engine_;
    TraceBuffer& trace_;
    SessionState state_{SessionState::Idle};
    GenerationId generationId_{0};
    RequestedConfiguration requested_{};
    RequestedConfiguration selected_{};
    RuntimeConfiguration runtime_{};
    FinalSessionPlan plan_{};
    std::optional<AudioDeviceCapabilities> capabilities_;
    bool wasRunningBeforeSuspend_{false};
};
