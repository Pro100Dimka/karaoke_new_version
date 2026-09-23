#include "TestHarness.hpp"

#ifdef _WIN32
#include "backend/asio/AsioAbi.hpp"
#include "backend/asio/AsioComApartment.hpp"
#include "backend/asio/AsioSampleConversion.hpp"

#include <array>
#include <cmath>
#include <cstdint>
#include <cstring>
#include <thread>

namespace Tests {
namespace {
void expectNear(float actual, float expected, float tolerance, std::string_view message) {
    expect(std::abs(actual - expected) <= tolerance, message);
}
} // namespace

void asioPackedIntegerFormatsUseTheirValidBitDepth() {
    struct Case {
        AsioSampleType type;
        unsigned bits;
    };
    constexpr std::array cases{
        Case{AsioInt32Lsb16, 16U},
        Case{AsioInt32Lsb18, 18U},
        Case{AsioInt32Lsb20, 20U},
        Case{AsioInt32Lsb24, 24U},
    };

    for (const auto [type, bits] : cases) {
        std::array<std::byte, 4> storage{};
        const auto halfScale = static_cast<std::int32_t>(std::uint32_t{1} << (bits - 2U));
        std::memcpy(storage.data(), &halfScale, sizeof(halfScale));
        expectNear(AsioSampleConversion::read(storage.data(), type, 0), 0.5F, 0.00002F,
                   "ASIO packed integer input must use the format's valid bit depth");

        AsioSampleConversion::write(storage.data(), type, 0, -0.5F);
        std::int32_t encoded{};
        std::memcpy(&encoded, storage.data(), sizeof(encoded));
        const auto expected = -static_cast<std::int32_t>(std::uint32_t{1} << (bits - 2U));
        expect(std::abs(encoded - expected) <= 1,
               "ASIO packed integer output must be right-aligned at the advertised depth");
        expectNear(AsioSampleConversion::read(storage.data(), type, 0), -0.5F, 0.00002F,
                   "ASIO packed integer conversion must round-trip without a level jump");
    }
}

void asioSampleConversionSupportsDriverReportedFormats() {
    constexpr std::array formats{
        AsioInt16Msb,   AsioInt24Msb,   AsioInt32Msb,   AsioFloat32Msb,
        AsioFloat64Msb, AsioInt16Lsb,   AsioInt24Lsb,   AsioInt32Lsb,
        AsioFloat32Lsb, AsioFloat64Lsb, AsioInt32Lsb16, AsioInt32Lsb18,
        AsioInt32Lsb20, AsioInt32Lsb24,
    };
    for (const auto format : formats)
        expect(AsioSampleConversion::isSupported(format),
               "Every standard ASIO sample format exposed by the ABI must be supported");
}

void asioDriverLifecycleStaysInItsCreatingComApartment() {
    AsioComApartment apartment;
    expect(apartment.start(), "ASIO must create a dedicated STA owner");
    expect(!apartment.isCurrentThreadOwner(), "the caller must not impersonate the ASIO STA owner");
    bool operationRanOnOwner = false;
    apartment.invoke([&] { operationRanOnOwner = apartment.isCurrentThreadOwner(); });
    expect(operationRanOnOwner, "ASIO lifecycle operations must execute on their STA owner");
}
} // namespace Tests
#else
namespace Tests {
void asioPackedIntegerFormatsUseTheirValidBitDepth() {}
void asioSampleConversionSupportsDriverReportedFormats() {}
void asioDriverLifecycleStaysInItsCreatingComApartment() {}
} // namespace Tests
#endif
