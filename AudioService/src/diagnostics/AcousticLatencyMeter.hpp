#pragma once

#include "common/Types.hpp"

#include <atomic>
#include <array>
#include <cstdint>
#include <optional>
#include <span>
#include <vector>

/**
 * Estimates acoustic delay relative to device timestamps. It plays a few quiet chirps and
 * finds them again in the microphone signal (a speaker, or headphones, held to the microphone).
 * Comparing the device capture time of the chirp with its reported presentation time gives the
 * residual delay, which can include both physical buffering and timestamp error.
 *
 * Threads: start()/poll() on the control thread, render() on the render thread, capture() on the
 * capture thread. Buffers are allocated in prepare(); the realtime calls never allocate or lock.
 */
class AcousticLatencyMeter {
  public:
    // The slowest plausible hidden round trip; later matches are echoes or noise.
    static constexpr double MaxRoundTripSeconds = 0.5;
    // A capture a few milliseconds before the presentation it echoes is timestamp noise, not
    // physics.
    static constexpr MonotonicTicks EarliestPlausibleNs = -5'000'000;

    struct Result {
        MonotonicTicks hiddenLatencyNs{0};
        double confidence{0.0}; // 0..1: how clearly all chirps were found at their spacing
        bool timingInvalid{false};
    };
    enum class State : std::uint32_t { Idle, Playing, Recorded, Done, Failed };

    void prepare(std::uint32_t renderRateHz, std::uint32_t captureRateHz);
    /** Arms a measurement; false while another one is running. */
    [[nodiscard]] bool start() noexcept;
    void render(std::span<float> output, std::uint32_t frames, std::uint32_t channels,
                MonotonicTicks presentationTicks) noexcept;
    void capture(std::span<const float> interleaved, std::uint32_t frames, std::uint32_t channels,
                 MonotonicTicks captureTicks, std::int64_t devicePosition = -1) noexcept;
    /** An invalid backend timestamp or lost packet makes this attempt unusable. */
    void invalidateTiming() noexcept;
    /** Finishes a recorded measurement (correlation runs here, on the calling thread). */
    [[nodiscard]] State poll(Result& result);
    /** The last completed measurement (control thread, after poll). */
    [[nodiscard]] Result lastResult() const noexcept {
        return result_;
    }
    [[nodiscard]] bool acceptsCalibration(MonotonicTicks nanoseconds) const noexcept;

    /** One chirp at `rateHz`, analytic so render and capture rates can differ. */
    [[nodiscard]] static std::vector<float> chirp(std::uint32_t rateHz);
    /** Offset (frames) of the chirp train in `recorded`, or nullopt when it is not clearly there.
     */
    [[nodiscard]] static std::optional<std::pair<std::uint32_t, double>>
    locate(std::span<const float> recorded, std::span<const float> chirp, std::uint32_t rateHz);

  private:
    std::vector<float> renderProbe_;
    std::vector<float> captureChirp_;
    std::vector<float> recorded_;
    std::vector<MonotonicTicks> captureTimes_;
    std::uint32_t renderRateHz_{0};
    std::uint32_t captureRateHz_{0};
    std::atomic<State> state_{State::Idle};
    std::uint32_t renderPosition_{0};                 // render thread
    std::atomic<MonotonicTicks> probePresentedAt_{0}; // written by render
    std::uint32_t recordedFrames_{0};                 // capture thread
    MonotonicTicks recordStartTicks_{0};              // capture thread, read after Recorded
    MonotonicTicks nextCaptureTicks_{0}, nextPresentationTicks_{0};
    std::int64_t nextCapturePosition_{-1};
    std::atomic<bool> invalidTiming_{false};
    Result result_{};
    std::array<Result, 3> recentResults_{};
    std::size_t nextResult_{0};
};
