#pragma once
#include <algorithm>
#include <bit>
#include <cmath>
#include <cstdint>
#include <limits>
#include <stdexcept>
#include <vector>

namespace AsioNegotiation {
inline std::uint32_t sampleRate(double value) {
    if (!std::isfinite(value) || value < 1 ||
        value > static_cast<double>(std::numeric_limits<std::uint32_t>::max()))
        throw std::runtime_error("ASIO driver reported an invalid sample rate");
    return static_cast<std::uint32_t>(std::llround(value));
}

struct Periods {
    long minimum, maximum, preferred, granularity;

    void validate() const {
        if (minimum <= 0 || maximum < minimum || preferred < minimum || preferred > maximum ||
            granularity < -1)
            throw std::runtime_error("ASIO driver reported invalid buffer constraints");
        if (granularity == -1 && std::bit_ceil(static_cast<std::uint32_t>(minimum)) >
                                     static_cast<std::uint32_t>(maximum))
            throw std::runtime_error("ASIO driver has no valid power-of-two buffer size");
    }

    [[nodiscard]] std::uint32_t select(std::uint32_t requested) const {
        validate();
        const auto min = static_cast<std::uint32_t>(minimum);
        const auto max = static_cast<std::uint32_t>(maximum);
        const auto wanted =
            std::clamp(requested ? requested : static_cast<std::uint32_t>(preferred), min, max);
        if (granularity == -1) {
            const auto rounded = std::bit_ceil(wanted);
            return rounded <= max ? rounded : std::bit_floor(max);
        }
        if (granularity == 0)
            return wanted;
        const auto step = static_cast<std::uint32_t>(granularity);
        const auto last = min + ((max - min) / step) * step;
        const auto steps = (static_cast<std::uint64_t>(wanted - min) + step - 1) / step;
        return static_cast<std::uint32_t>(std::min<std::uint64_t>(last, min + steps * step));
    }

    [[nodiscard]] std::vector<std::uint32_t> explicitSizes() const {
        validate();
        std::vector<std::uint32_t> sizes;
        // Linear ranges are represented exactly by min/max/fundamental, without an unbounded list.
        if (granularity == -1) {
            for (std::uint64_t size = std::bit_ceil(static_cast<std::uint32_t>(minimum));
                 size <= static_cast<std::uint32_t>(maximum); size *= 2)
                sizes.push_back(static_cast<std::uint32_t>(size));
        }
        return sizes;
    }
};
} // namespace AsioNegotiation
