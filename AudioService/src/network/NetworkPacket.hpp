#pragma once

#include <array>
#include <cstddef>
#include <cstdint>
#include <span>

constexpr std::uint32_t AudioPacketMagic = 0x32445541U;
constexpr std::uint16_t AudioPacketVersion = 1;
constexpr std::size_t AudioPacketHeaderBytes = 36;

struct AudioPacketHeader {
    std::uint32_t sequence{0};
    std::uint32_t participantKey{0};
    std::uint64_t sessionToken{0};
    std::uint64_t timestampFrame{0};
    std::uint16_t channels{0};
    std::uint16_t frames{0};
};

struct AudioTimelineAlignment {
    std::uint32_t silenceFrames{0};
    std::uint32_t skipFrames{0};
};

[[nodiscard]] inline AudioTimelineAlignment
alignAudioPacketTimeline(std::uint64_t remoteTimestampFrame, std::uint64_t localTimestampFrame,
                         std::uint32_t playoutDelayFrames, std::uint32_t packetFrames) noexcept {
    const auto target = remoteTimestampFrame + playoutDelayFrames;
    if (target > localTimestampFrame) {
        const auto difference = target - localTimestampFrame;
        return {static_cast<std::uint32_t>(
                    difference > UINT32_MAX ? UINT32_MAX : difference),
                0};
    }
    const auto difference = localTimestampFrame - target;
    return {0, static_cast<std::uint32_t>(difference > packetFrames ? packetFrames : difference)};
}

namespace AudioPacketWire {
template <typename T>
inline void write(std::span<std::byte> bytes, std::size_t offset, T value) noexcept {
    for (std::size_t index = 0; index < sizeof(T); ++index)
        bytes[offset + index] = std::byte{static_cast<unsigned char>(value >> (index * 8U))};
}

template <typename T>
[[nodiscard]] inline T read(std::span<const std::byte> bytes, std::size_t offset) noexcept {
    T value{0};
    for (std::size_t index = 0; index < sizeof(T); ++index)
        value |= static_cast<T>(std::to_integer<unsigned char>(bytes[offset + index])) <<
                 (index * 8U);
    return value;
}
} // namespace AudioPacketWire

[[nodiscard]] inline std::array<std::byte, AudioPacketHeaderBytes>
encodeAudioPacketHeader(const AudioPacketHeader& header) noexcept {
    std::array<std::byte, AudioPacketHeaderBytes> bytes{};
    AudioPacketWire::write<std::uint32_t>(bytes, 0, AudioPacketMagic);
    AudioPacketWire::write<std::uint16_t>(bytes, 4, AudioPacketVersion);
    AudioPacketWire::write<std::uint16_t>(bytes, 6,
                                          static_cast<std::uint16_t>(AudioPacketHeaderBytes));
    AudioPacketWire::write<std::uint32_t>(bytes, 8, header.sequence);
    AudioPacketWire::write<std::uint32_t>(bytes, 12, header.participantKey);
    AudioPacketWire::write<std::uint64_t>(bytes, 16, header.sessionToken);
    AudioPacketWire::write<std::uint64_t>(bytes, 24, header.timestampFrame);
    AudioPacketWire::write<std::uint16_t>(bytes, 32, header.channels);
    AudioPacketWire::write<std::uint16_t>(bytes, 34, header.frames);
    return bytes;
}

[[nodiscard]] inline bool decodeAudioPacketHeader(std::span<const std::byte> bytes,
                                                  AudioPacketHeader& header) noexcept {
    if (bytes.size() < AudioPacketHeaderBytes ||
        AudioPacketWire::read<std::uint32_t>(bytes, 0) != AudioPacketMagic ||
        AudioPacketWire::read<std::uint16_t>(bytes, 4) != AudioPacketVersion ||
        AudioPacketWire::read<std::uint16_t>(bytes, 6) != AudioPacketHeaderBytes)
        return false;
    header.sequence = AudioPacketWire::read<std::uint32_t>(bytes, 8);
    header.participantKey = AudioPacketWire::read<std::uint32_t>(bytes, 12);
    header.sessionToken = AudioPacketWire::read<std::uint64_t>(bytes, 16);
    header.timestampFrame = AudioPacketWire::read<std::uint64_t>(bytes, 24);
    header.channels = AudioPacketWire::read<std::uint16_t>(bytes, 32);
    header.frames = AudioPacketWire::read<std::uint16_t>(bytes, 34);
    return true;
}
