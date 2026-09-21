#include "backend/BackendSelection.hpp"
#include "backend/fake/FakeAudioBackend.hpp"
#ifdef _WIN32
#include "backend/wasapi/WasapiBackend.hpp"
#if AUDIOSERVICE_ENABLE_ASIO
#include "backend/asio/AsioBackend.hpp"
#endif
#endif
#include <stdexcept>
std::unique_ptr<IAudioBackend> createAudioBackend(BackendKind kind) {
    switch (kind) {
    case BackendKind::Fake:
        return std::make_unique<FakeAudioBackend>();
#ifdef _WIN32
    case BackendKind::WasapiShared:
        return std::make_unique<WasapiBackend>(WasapiMode::Shared);
    case BackendKind::WasapiExclusive:
        return std::make_unique<WasapiBackend>(WasapiMode::Exclusive);
#if AUDIOSERVICE_ENABLE_ASIO
    case BackendKind::Asio:
        return std::make_unique<AsioBackend>();
#endif
#endif
    default:
        throw std::runtime_error("requested audio backend is unavailable in this build");
    }
}
