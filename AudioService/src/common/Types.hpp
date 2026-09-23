#pragma once

#include <algorithm>
#include <array>
#include <chrono>
#include <compare>
#include <cstdint>
#include <ostream>
#include <string>
#include <string_view>
#include <vector>

template <typename Tag> class StrongUnsigned64 {
  public:
    constexpr StrongUnsigned64() noexcept = default;
    explicit constexpr StrongUnsigned64(std::uint64_t value) noexcept : value_(value) {}

    [[nodiscard]] constexpr std::uint64_t value() const noexcept {
        return value_;
    }

    constexpr StrongUnsigned64& operator++() noexcept {
        ++value_;
        return *this;
    }

    constexpr StrongUnsigned64& operator+=(std::uint64_t amount) noexcept {
        value_ += amount;
        return *this;
    }

    friend constexpr StrongUnsigned64 operator+(StrongUnsigned64 value,
                                                std::uint64_t amount) noexcept {
        value += amount;
        return value;
    }

    friend constexpr std::uint64_t operator-(StrongUnsigned64 left,
                                             StrongUnsigned64 right) noexcept {
        return left.value_ - right.value_;
    }

    friend constexpr auto operator<=>(StrongUnsigned64, StrongUnsigned64) noexcept = default;

  private:
    std::uint64_t value_{0};
};

template <typename Tag>
std::ostream& operator<<(std::ostream& stream, StrongUnsigned64<Tag> value) {
    return stream << value.value();
}

struct GenerationTag;
struct SourceGenerationTag;
struct SessionFrameTag;
struct SequenceNumberTag;

using GenerationId = StrongUnsigned64<GenerationTag>;
using SourceGenerationId = StrongUnsigned64<SourceGenerationTag>;
using SessionFrame = StrongUnsigned64<SessionFrameTag>;
using SequenceNumber = StrongUnsigned64<SequenceNumberTag>;
using MonotonicTicks = std::int64_t;

constexpr std::uint32_t MaxAudioChannels = 8;
constexpr std::uint32_t MaxBlockFrames = 4096;
constexpr std::uint32_t ControlProtocolVersion = 1;

enum class BackendKind { Fake, WasapiShared, WasapiExclusive, Asio, Count };
enum class Direction { Input, Output };
enum class ClockRelationship { SameDomain, Independent };
enum class AudioSampleFormat { Float32, Int16, Int24, Int32, Unknown };

enum class FailureCategory {
    None,
    Configuration,
    Backend,
    Device,
    Realtime,
    Recording,
    Network,
    Dsp,
    Ipc,
    Media,
    Unknown
};

enum class FailureSeverity { Recoverable, SessionFatal, ServiceFatal };

enum class BackendEventType {
    None,
    DeviceLost,
    DeviceInvalidated,
    DataDiscontinuity,
    TimestampError,
    CaptureOverrun,
    RenderUnderrun,
    DriverReset,
    SampleRateChanged
};

struct FailureInfo {
    FailureCategory category{FailureCategory::None};
    FailureSeverity severity{FailureSeverity::Recoverable};
    std::int32_t code{0};
    std::string message;
};

struct DeviceInfo {
    std::string id;
    std::string name;
    BackendKind backend{BackendKind::Fake};
    Direction direction{Direction::Input};
    std::uint32_t channels{0};
    std::string driverVersion;
    bool isDefault{false};
    bool enabled{true};
};

struct AudioDeviceCapabilities {
    std::vector<std::uint32_t> sampleRatesHz{44100, 48000};
    // The format currently selected by the OS/driver. Unsupported saved preferences fall back to
    // this exact rate rather than silently choosing an arbitrary nearby value.
    std::uint32_t defaultSampleRateHz{48000};
    std::vector<AudioSampleFormat> formats{AudioSampleFormat::Float32};
    std::uint32_t minPeriodFrames{64};
    std::uint32_t maxPeriodFrames{2048};
    std::uint32_t defaultPeriodFrames{480};
    std::uint32_t fundamentalPeriodFrames{1};
    // Exact buffer sizes reported or derived from the device API. An empty list means that every
    // fundamental step in the min/max interval is accepted.
    std::vector<std::uint32_t> periodFrames{};
    std::uint32_t inputChannels{2};
    std::uint32_t outputChannels{2};
};

struct RequestedConfiguration {
    std::string inputDeviceId;
    std::string outputDeviceId;
    BackendKind backend{BackendKind::Fake};
    std::uint32_t sampleRateHz{48000};
    std::uint32_t periodFrames{128};
    std::uint32_t inputChannels{1};
    std::uint32_t outputChannels{2};
};

struct RuntimeConfiguration {
    std::uint32_t inputSampleRateHz{0};
    std::uint32_t outputSampleRateHz{0};
    std::uint32_t inputPeriodFrames{0};
    std::uint32_t outputPeriodFrames{0};
    std::uint32_t inputEndpointBufferFrames{0};
    std::uint32_t outputEndpointBufferFrames{0};
    std::uint32_t inputChannels{0};
    std::uint32_t outputChannels{0};
    AudioSampleFormat inputFormat{AudioSampleFormat::Unknown};
    AudioSampleFormat outputFormat{AudioSampleFormat::Unknown};
    ClockRelationship clockRelationship{ClockRelationship::SameDomain};
    std::uint32_t inputLatencyFrames{0};
    std::uint32_t outputLatencyFrames{0};
};

struct FinalSessionPlan {
    std::uint32_t inputSampleRateHz{0};
    std::uint32_t internalSampleRateHz{0};
    std::uint32_t maximumBlockFrames{0};
    std::uint32_t inputChannels{0};
    std::uint32_t outputChannels{0};
    bool needsInputResampling{false};
    bool independentClocks{false};
    std::uint32_t clockBridgeCapacityFrames{0};
    std::uint32_t clockBridgeTargetFrames{0};
};

struct BackendAudioBuffer {
    const float* input{nullptr};
    float* output{nullptr};
    std::uint32_t frames{0};
    std::uint32_t channels{0};
    std::int64_t devicePosition{0};
    MonotonicTicks timestamp{0};
    std::uint32_t flags{0};
};

inline MonotonicTicks monotonicTicksNow() noexcept {
    return std::chrono::duration_cast<std::chrono::nanoseconds>(
               std::chrono::steady_clock::now().time_since_epoch())
        .count();
}

inline std::uint32_t nearestSupported(std::uint32_t requested,
                                      const std::vector<std::uint32_t>& supported,
                                      std::uint32_t fallback) {
    if (supported.empty())
        return fallback;
    return *std::min_element(supported.begin(), supported.end(), [requested](auto a, auto b) {
        const auto da = a > requested ? a - requested : requested - a;
        const auto db = b > requested ? b - requested : requested - b;
        return da < db;
    });
}
