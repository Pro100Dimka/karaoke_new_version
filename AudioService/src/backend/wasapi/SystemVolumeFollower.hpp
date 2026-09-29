#pragma once
#ifdef _WIN32

#include <functional>
#include <memory>
#include <string>

/**
 * Follows the Windows volume and mute of one output endpoint, so this app is exactly as loud as
 * every other app on the same device. Only streams that Windows does not attenuate itself need it:
 * exclusive mode on an endpoint with software volume, and ASIO (following the default output).
 * Shared streams, and endpoints whose volume is applied in hardware, keep a gain of 1.
 *
 * Threads: follow()/stop() on the control thread; `sink` is called there and on the Windows
 * notification thread with the new linear gain, which must only be stored (e.g. in an atomic).
 */
class SystemVolumeFollower {
  public:
    enum class Stream { MixedByWindows, BypassesWindows };

    explicit SystemVolumeFollower(std::function<void(float)> sink);
    ~SystemVolumeFollower();
    SystemVolumeFollower(const SystemVolumeFollower&) = delete;
    SystemVolumeFollower& operator=(const SystemVolumeFollower&) = delete;

    /** `endpointId` empty = the Windows default output. */
    void follow(const std::string& endpointId, Stream stream) noexcept;
    void stop() noexcept;

    /** Linear gain for a Windows volume in dB, or 0 when muted. */
    [[nodiscard]] static float gainFor(float volumeDb, bool muted) noexcept;

  private:
    struct Impl;
    std::function<void(float)> sink_;
    std::unique_ptr<Impl> impl_;
};

#endif
