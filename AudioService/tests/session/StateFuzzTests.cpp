#include "TestHarness.hpp"
#include "app/AudioService.hpp"
#include "backend/fake/FakeAudioBackend.hpp"

#include <array>
#include <cstdint>
#include <memory>
#include <string_view>

namespace Tests {
namespace {
std::uint32_t nextRandom(std::uint32_t& state) noexcept {
    state ^= state << 13U;
    state ^= state >> 17U;
    state ^= state << 5U;
    return state;
}
} // namespace

void seededStateFuzzPreservesSessionInvariants() {
    auto backend = std::make_unique<FakeAudioBackend>();
    AudioService service{std::move(backend)};
    service.start();

    constexpr std::array commands{
        std::string_view{"1|PrepareSession|backend=fake|rate=48000|period=128"},
        std::string_view{"1|StartSession"},
        std::string_view{"1|StopSession"},
        std::string_view{"1|Reconfigure|backend=fake|rate=44100|period=144"},
        std::string_view{"1|SuspendSession"},
        std::string_view{"1|ResumeSession"},
        std::string_view{"1|RecoverSession"},
        std::string_view{"1|SetMonitoring|enabled=1"},
        std::string_view{"1|SetMonitoring|enabled=0"},
        std::string_view{"1|GetDiagnostics"},
    };

    constexpr std::uint32_t Seed = 0x5A17C3E1U;
    std::uint32_t random = Seed;
    auto previousGeneration = service.session().generationId();
    bool valid = true;

    for (std::size_t step = 0; step < 2'000; ++step) {
        const auto command = commands[nextRandom(random) % commands.size()];
        (void)service.handleLine(command);

        const auto state = service.session().state();
        const auto generation = service.session().generationId();
        valid = valid &&
                static_cast<std::size_t>(state) < static_cast<std::size_t>(SessionState::Count) &&
                generation >= previousGeneration;
        previousGeneration = generation;
    }

    expect(valid, "seeded state fuzz preserves state and generation invariants");
}
} // namespace Tests
