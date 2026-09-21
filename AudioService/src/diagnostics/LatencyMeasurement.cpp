#include "diagnostics/LatencyMeasurement.hpp"
#include <algorithm>
#include <cmath>
std::vector<float> makeLatencyImpulse(std::uint32_t frames, std::uint32_t impulseFrame) {
    std::vector<float> out(frames, 0.0F);
    if (impulseFrame < frames)
        out[impulseFrame] = 1.0F;
    return out;
}
LatencyMeasurementResult measureImpulseLatency(std::span<const float> reference,
                                               std::span<const float> captured,
                                               std::uint32_t maxLagFrames) {
    if (reference.empty() || captured.empty())
        return {};
    float best = 0.0F;
    std::uint32_t bestLag = 0;
    const auto maxLag =
        std::min<std::uint32_t>(maxLagFrames, static_cast<std::uint32_t>(captured.size() - 1U));
    for (std::uint32_t lag = 0; lag <= maxLag; ++lag) {
        double sum = 0.0;
        const auto count = std::min(reference.size(), captured.size() - lag);
        for (std::size_t i = 0; i < count; ++i)
            sum += static_cast<double>(reference[i]) * captured[i + lag];
        const auto score = static_cast<float>(std::abs(sum));
        if (score > best) {
            best = score;
            bestLag = lag;
        }
    }
    return {best > 0.05F, bestLag, best};
}
