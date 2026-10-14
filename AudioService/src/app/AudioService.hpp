#pragma once

#include "analysis/AnalysisEngine.hpp"
#include "analysis/SignalMetrics.hpp"
#include "backend/BackendSelection.hpp"
#include "devices/DeviceManager.hpp"
#include "diagnostics/FailureSnapshot.hpp"
#include "diagnostics/GraphIntrospection.hpp"
#include "diagnostics/LatencyRegistry.hpp"
#include "diagnostics/SongCalibrationPolicy.hpp"
#include "diagnostics/TraceBuffer.hpp"
#include "ipc/ControlProtocol.hpp"
#include "media/MediaController.hpp"
#include "network/NetworkAudioEngine.hpp"
#include "realtime/RealtimeEngine.hpp"
#include "recording/RecordingEngine.hpp"
#include "session/SessionManager.hpp"
#ifdef _WIN32
#include "backend/wasapi/SystemVolumeFollower.hpp"
#endif

#include <map>
#include <atomic>
#include <memory>
#include <optional>
#include <string>

enum class ServiceState { Starting, Running, Stopping, Stopped, Failed, Count };

class AudioService {
  public:
    explicit AudioService(std::unique_ptr<IAudioBackend> backend);
    void start() noexcept;
    void shutdown() noexcept;
    [[nodiscard]] bool shutdownRequested() const noexcept {
        return shutdownRequested_.load(std::memory_order_acquire);
    }
    [[nodiscard]] std::string diagnostics();
    /** Song frame the room hears at `at` (what every participant's timer shows). */
    [[nodiscard]] std::uint64_t roomPlaybackFrame(MonotonicTicks at) const noexcept;
    [[nodiscard]] ControlResponse handle(const ControlRequest& request);
    [[nodiscard]] ControlResponse handleLine(std::string_view line);
    [[nodiscard]] SessionManager& session() noexcept {
        return session_;
    }
    [[nodiscard]] RealtimeEngine& realtime() noexcept {
        return realtime_;
    }
    [[nodiscard]] MediaController& media() noexcept {
        return media_;
    }
    [[nodiscard]] RecordingEngine& recording() noexcept {
        return recording_;
    }
    [[nodiscard]] NetworkAudioEngine& network() noexcept {
        return network_;
    }

  private:
    RequestedConfiguration requestFromControl(const ControlRequest& request) const;
    MediaContext contextFromControl(const ControlRequest& request) const;
    void processPendingBackendEvent();
    void processDeviceEvents();
    void captureFailure(FailureInfo failure);
    void syncDeviceGeneration() noexcept {
        devices_.setGeneration(session_.generationId());
        publishDeviceLatency();
    }
    void publishDeviceLatency() noexcept;
    /** The opened device path an acoustic calibration belongs to; empty while none is open. */
    [[nodiscard]] std::string calibrationFingerprint() const;
    /** Applies the remembered calibration of the device path just opened, before it starts. */
    void applyRememberedCalibration() noexcept;
    /**
     * Takes the hidden delay the passive estimator found from the song itself (speaker heard by the
     * microphone) as this path's calibration, but only while no song plays: a correction never
     * changes the voice timeline mid-performance.
     */
    void adoptPassiveCalibration() noexcept;
    // Where the applied acoustic correction came from (diagnostics "AcousticCalibrationOrigin").
    CalibrationOrigin calibrationOrigin_{CalibrationOrigin::None};
    std::uint64_t adoptedPassiveEstimates_{0};
    MonotonicTicks pendingSongCalibrationNs_{-1};
    // Calibrations measured earlier, per fingerprint, as the app saved them (control thread).
    std::map<std::string, MonotonicTicks, std::less<>> rememberedCalibrations_;
    void followSystemVolume(const RequestedConfiguration& config) noexcept;
    static float floatValue(std::string_view value, float fallback);
    static std::uint64_t uint64Value(std::string_view value, std::uint64_t fallback,
                                     std::uint64_t maximum = UINT64_MAX);
    static std::uint64_t hexUint64Value(std::string_view value, std::uint64_t fallback);
    static bool boolValue(std::string_view value, bool fallback);
    [[nodiscard]] static std::string_view serviceStateName(ServiceState state) noexcept;
    [[nodiscard]] std::optional<ControlResponse>
    handleServiceControl(const ControlRequest& request);
    [[nodiscard]] std::optional<ControlResponse> handleMixerControl(const ControlRequest& request);
    [[nodiscard]] std::optional<ControlResponse>
    handlePlaybackControl(const ControlRequest& request);
    [[nodiscard]] std::optional<ControlResponse>
    handleRecordingControl(const ControlRequest& request);
    [[nodiscard]] std::optional<ControlResponse> handleSignalControl(const ControlRequest& request);
    [[nodiscard]] std::optional<ControlResponse>
    handlePreviewControl(const ControlRequest& request);
    [[nodiscard]] std::optional<ControlResponse> handleRadioControl(const ControlRequest& request);
    [[nodiscard]] std::optional<ControlResponse>
    handleNetworkControl(const ControlRequest& request);

    ServiceState state_{ServiceState::Starting};
    DeviceManager devices_{};
    TraceBuffer trace_{};
    LatencyRegistry latency_{};
    SignalMetrics signal_{};
    AnalysisEngine analysis_{};
    GraphIntrospection graphInfo_{};
    MediaController media_{};
    RecordingEngine recording_{};
    NetworkAudioEngine network_{};
    RealtimeEngine realtime_;
    SessionManager session_;
#ifdef _WIN32
    SystemVolumeFollower systemVolume_{[this](float gain) { realtime_.setSystemGain(gain); }};
#endif
    FailureSnapshot failureSnapshot_{};
    std::atomic<bool> shutdownRequested_{false};
};
