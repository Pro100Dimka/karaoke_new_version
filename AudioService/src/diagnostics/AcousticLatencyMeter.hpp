#pragma once

#include "common/Types.hpp"

#include <atomic>
#include <cstdint>
#include <optional>
#include <span>
#include <vector>

/**
 * Measures the round-trip latency the audio devices do not report. It plays a few quiet chirps and
 * finds them again in the microphone signal (a speaker, or headphones, held to the microphone).
 * Comparing the device capture time of the chirp with its reported presentation time gives the
 * hidden part of the path: USB/driver buffers, converters, and anything else the drivers omit.
 *
 * Threads: start()/poll() on the control thread, render() on the render thread, capture() on the
 * capture thread. Buffers are allocated in prepare(); the realtime calls never allocate or lock.
 */
class AcousticLatencyMeter {
  public:
    struct Result {
        MonotonicTicks hiddenLatencyNs{0};
        double confidence{0.0}; // 0..1: how clearly all chirps were found at their spacing
    };
    enum class State : std::uint32_t { Idle, Playing, Recorded, Done, Failed };

    void prepare(std::uint32_t renderRateHz, std::uint32_t captureRateHz);
    /** Arms a measurement; false while another one is running. */
    [[nodiscard]] bool start() noexcept;
    void render(std::span<float> output, std::uint32_t frames, std::uint32_t channels,
                MonotonicTicks presentationTicks) noexcept;
    void capture(std::span<const float> interleaved, std::uint32_t frames, std::uint32_t channels,
                 MonotonicTicks captureTicks) noexcept;
    /** Finishes a recorded measurement (correlation runs here, on the calling thread). */
    [[nodiscard]] State poll(Result& result);
    /** The last completed measurement (control thread, after poll). */
    [[nodiscard]] Result lastResult() const noexcept { return result_; }

    /** One chirp at `rateHz`, analytic so render and capture rates can differ. */
    [[nodiscard]] static std::vector<float> chirp(std::uint32_t rateHz);
    /** Offset (frames) of the chirp train in `recorded`, or nullopt when it is not clearly there. */
    [[nodiscard]] static std::optional<std::pair<std::uint32_t, double>>
    locate(std::span<const float> recorded, std::span<const float> chirp, std::uint32_t rateHz);

  private:
    std::vector<float> renderProbe_;
    std::vector<float> captureChirp_;
    std::vector<float> recorded_;
    std::uint32_t renderRateHz_{0};
    std::uint32_t captureRateHz_{0};
    std::atomic<State> state_{State::Idle};
    std::uint32_t renderPosition_{0};                    // render thread
    std::atomic<MonotonicTicks> probePresentedAt_{0};    // written by render
    std::uint32_t recordedFrames_{0};                    // capture thread
    MonotonicTicks recordStartTicks_{0};                 // capture thread, read after Recorded
    Result result_{};
};
