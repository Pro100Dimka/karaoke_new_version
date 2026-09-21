#include "app/AudioService.hpp"
#include "backend/BackendSelection.hpp"
#include "ipc/ControlServer.hpp"
#include <exception>
#include <iostream>
int main() {
    try {
#ifdef _WIN32
        auto backend = createAudioBackend(BackendKind::WasapiShared);
#else
        auto backend = createAudioBackend(BackendKind::Fake);
#endif
        AudioService service{std::move(backend)};
        service.start();
        ControlServer server{service};
        server.serve();
        return 0;
    } catch (const std::exception& e) {
        std::cerr << "AudioService failed: " << e.what() << '\n';
        return 1;
    }
}
