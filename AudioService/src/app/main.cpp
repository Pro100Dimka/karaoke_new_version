#include "app/AudioService.hpp"
#include "backend/BackendSelection.hpp"
#include "ipc/ControlServer.hpp"
#include <cstdlib>
#include <exception>
#include <iostream>
#include <string>

namespace {
std::string audioEndpoint() {
#ifdef _WIN32
    char* value = nullptr;
    std::size_t length = 0;
    if (_dupenv_s(&value, &length, "AD_VOICE_AUDIO_ENDPOINT") != 0 || value == nullptr)
        return {};
    std::string endpoint{value};
    std::free(value);
    return endpoint;
#else
    const auto* value = std::getenv("AD_VOICE_AUDIO_ENDPOINT");
    return value == nullptr ? std::string{} : std::string{value};
#endif
}
} // namespace

int main() {
    try {
#ifdef _WIN32
        auto backend = createAudioBackend(BackendKind::WasapiShared);
#else
        auto backend = createAudioBackend(BackendKind::Fake);
#endif
        AudioService service{std::move(backend)};
        service.start();
        ControlServer server{service, audioEndpoint()};
        server.serve();
        return 0;
    } catch (const std::exception& e) {
        std::cerr << "AudioService failed: " << e.what() << '\n';
        return 1;
    }
}
