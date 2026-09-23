#ifdef _WIN32
#include "backend/asio/AsioSampleConversion.hpp"

#include <algorithm>
#include <bit>
#include <cmath>
#include <cstddef>
#include <cstdint>
#include <limits>

namespace {
std::uint64_t loadUnsigned(const std::byte* bytes, unsigned width, bool littleEndian) noexcept {
    std::uint64_t value = 0;
    for (unsigned index = 0; index < width; ++index) {
        const auto source = littleEndian ? index : width - index - 1U;
        value |= static_cast<std::uint64_t>(std::to_integer<unsigned char>(bytes[source]))
                 << (index * 8U);
    }
    return value;
}

void storeUnsigned(std::byte* bytes, unsigned width, bool littleEndian,
                   std::uint64_t value) noexcept {
    for (unsigned index = 0; index < width; ++index) {
        const auto destination = littleEndian ? index : width - index - 1U;
        bytes[destination] = static_cast<std::byte>((value >> (index * 8U)) & 0xffU);
    }
}

std::int64_t signExtend(std::uint64_t value, unsigned bits) noexcept {
    if (bits == 64U)
        return std::bit_cast<std::int64_t>(value);
    const auto sign = std::uint64_t{1} << (bits - 1U);
    const auto mask = (std::uint64_t{1} << bits) - 1U;
    value &= mask;
    if ((value & sign) != 0U)
        value |= ~mask;
    return static_cast<std::int64_t>(value);
}

float readInteger(const std::byte* bytes, unsigned storageBytes, unsigned validBits,
                  bool littleEndian) noexcept {
    const auto value = signExtend(loadUnsigned(bytes, storageBytes, littleEndian), validBits);
    const auto scale = static_cast<double>(std::uint64_t{1} << (validBits - 1U));
    return static_cast<float>(static_cast<double>(value) / scale);
}

void writeInteger(std::byte* bytes, unsigned storageBytes, unsigned validBits, bool littleEndian,
                  float sample) noexcept {
    const auto clamped = std::clamp(sample, -1.0F, 1.0F);
    const auto negativeScale = static_cast<double>(std::uint64_t{1} << (validBits - 1U));
    const auto positiveScale = negativeScale - 1.0;
    const auto scaled = static_cast<double>(clamped) * (clamped < 0.0F ? negativeScale : positiveScale);
    const auto value = static_cast<std::int64_t>(std::llround(scaled));
    storeUnsigned(bytes, storageBytes, littleEndian, static_cast<std::uint64_t>(value));
}

float readFloat32(const std::byte* bytes, bool littleEndian) noexcept {
    return std::bit_cast<float>(static_cast<std::uint32_t>(loadUnsigned(bytes, 4U, littleEndian)));
}

float readFloat64(const std::byte* bytes, bool littleEndian) noexcept {
    return static_cast<float>(std::bit_cast<double>(loadUnsigned(bytes, 8U, littleEndian)));
}

void writeFloat32(std::byte* bytes, bool littleEndian, float sample) noexcept {
    storeUnsigned(bytes, 4U, littleEndian, std::bit_cast<std::uint32_t>(sample));
}

void writeFloat64(std::byte* bytes, bool littleEndian, float sample) noexcept {
    storeUnsigned(bytes, 8U, littleEndian,
                  std::bit_cast<std::uint64_t>(static_cast<double>(sample)));
}
} // namespace

namespace AsioSampleConversion {
bool isSupported(AsioSampleType type) noexcept {
    switch (type) {
    case AsioInt16Msb:
    case AsioInt24Msb:
    case AsioInt32Msb:
    case AsioFloat32Msb:
    case AsioFloat64Msb:
    case AsioInt16Lsb:
    case AsioInt24Lsb:
    case AsioInt32Lsb:
    case AsioFloat32Lsb:
    case AsioFloat64Lsb:
    case AsioInt32Lsb16:
    case AsioInt32Lsb18:
    case AsioInt32Lsb20:
    case AsioInt32Lsb24:
        return true;
    default:
        return false;
    }
}

float read(const void* base, AsioSampleType type, long frame) noexcept {
    const auto* bytes = static_cast<const std::byte*>(base);
    switch (type) {
    case AsioInt16Msb:
        return readInteger(bytes + static_cast<std::size_t>(frame) * 2U, 2U, 16U, false);
    case AsioInt24Msb:
        return readInteger(bytes + static_cast<std::size_t>(frame) * 3U, 3U, 24U, false);
    case AsioInt32Msb:
        return readInteger(bytes + static_cast<std::size_t>(frame) * 4U, 4U, 32U, false);
    case AsioFloat32Msb:
        return readFloat32(bytes + static_cast<std::size_t>(frame) * 4U, false);
    case AsioFloat64Msb:
        return readFloat64(bytes + static_cast<std::size_t>(frame) * 8U, false);
    case AsioInt16Lsb:
        return readInteger(bytes + static_cast<std::size_t>(frame) * 2U, 2U, 16U, true);
    case AsioInt24Lsb:
        return readInteger(bytes + static_cast<std::size_t>(frame) * 3U, 3U, 24U, true);
    case AsioInt32Lsb:
        return readInteger(bytes + static_cast<std::size_t>(frame) * 4U, 4U, 32U, true);
    case AsioFloat32Lsb:
        return readFloat32(bytes + static_cast<std::size_t>(frame) * 4U, true);
    case AsioFloat64Lsb:
        return readFloat64(bytes + static_cast<std::size_t>(frame) * 8U, true);
    case AsioInt32Lsb16:
        return readInteger(bytes + static_cast<std::size_t>(frame) * 4U, 4U, 16U, true);
    case AsioInt32Lsb18:
        return readInteger(bytes + static_cast<std::size_t>(frame) * 4U, 4U, 18U, true);
    case AsioInt32Lsb20:
        return readInteger(bytes + static_cast<std::size_t>(frame) * 4U, 4U, 20U, true);
    case AsioInt32Lsb24:
        return readInteger(bytes + static_cast<std::size_t>(frame) * 4U, 4U, 24U, true);
    default:
        return 0.0F;
    }
}

void write(void* base, AsioSampleType type, long frame, float sample) noexcept {
    auto* bytes = static_cast<std::byte*>(base);
    switch (type) {
    case AsioInt16Msb:
        return writeInteger(bytes + static_cast<std::size_t>(frame) * 2U, 2U, 16U, false, sample);
    case AsioInt24Msb:
        return writeInteger(bytes + static_cast<std::size_t>(frame) * 3U, 3U, 24U, false, sample);
    case AsioInt32Msb:
        return writeInteger(bytes + static_cast<std::size_t>(frame) * 4U, 4U, 32U, false, sample);
    case AsioFloat32Msb:
        return writeFloat32(bytes + static_cast<std::size_t>(frame) * 4U, false, sample);
    case AsioFloat64Msb:
        return writeFloat64(bytes + static_cast<std::size_t>(frame) * 8U, false, sample);
    case AsioInt16Lsb:
        return writeInteger(bytes + static_cast<std::size_t>(frame) * 2U, 2U, 16U, true, sample);
    case AsioInt24Lsb:
        return writeInteger(bytes + static_cast<std::size_t>(frame) * 3U, 3U, 24U, true, sample);
    case AsioInt32Lsb:
        return writeInteger(bytes + static_cast<std::size_t>(frame) * 4U, 4U, 32U, true, sample);
    case AsioFloat32Lsb:
        return writeFloat32(bytes + static_cast<std::size_t>(frame) * 4U, true, sample);
    case AsioFloat64Lsb:
        return writeFloat64(bytes + static_cast<std::size_t>(frame) * 8U, true, sample);
    case AsioInt32Lsb16:
        return writeInteger(bytes + static_cast<std::size_t>(frame) * 4U, 4U, 16U, true, sample);
    case AsioInt32Lsb18:
        return writeInteger(bytes + static_cast<std::size_t>(frame) * 4U, 4U, 18U, true, sample);
    case AsioInt32Lsb20:
        return writeInteger(bytes + static_cast<std::size_t>(frame) * 4U, 4U, 20U, true, sample);
    case AsioInt32Lsb24:
        return writeInteger(bytes + static_cast<std::size_t>(frame) * 4U, 4U, 24U, true, sample);
    default:
        return;
    }
}
} // namespace AsioSampleConversion
#endif
