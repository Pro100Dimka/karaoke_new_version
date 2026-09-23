#pragma once

#ifdef _WIN32
#include "backend/asio/AsioAbi.hpp"

namespace AsioSampleConversion {
[[nodiscard]] bool isSupported(AsioSampleType type) noexcept;
[[nodiscard]] float read(const void* base, AsioSampleType type, long frame) noexcept;
void write(void* base, AsioSampleType type, long frame, float sample) noexcept;
} // namespace AsioSampleConversion
#endif
