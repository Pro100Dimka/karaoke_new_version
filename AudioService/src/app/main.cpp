#include "app/AudioService.hpp"
#include "backend/BackendSelection.hpp"
#include "ipc/ControlEndpoint.hpp"
#include "ipc/ControlServer.hpp"
#include "network/NetworkTestRunner.hpp"
#include <cstdlib>
#include <exception>
#include <iostream>
#include <string>
#include <string_view>
#include <vector>

int main(int argc, char** argv) {
    try {
        std::vector<std::string_view> arguments;
        arguments.reserve(static_cast<std::size_t>(std::max(0, argc - 1)));
        for (int index = 1; index < argc; ++index)
            arguments.emplace_back(argv[index]);
        const auto networkTestExit = runNetworkTestCommand(arguments, std::cout, std::cerr);
        if (networkTestExit >= 0)
            return networkTestExit;
#ifdef _WIN32
        auto backend = createAudioBackend(BackendKind::WasapiShared);
#else
        auto backend = createAudioBackend(BackendKind::Fake);
#endif
        AudioService service{std::move(backend)};
        service.start();
        ControlServer server{service, controlEndpoint()};
        server.serve();
        return 0;
    } catch (const std::exception& e) {
        std::cerr << "AudioService failed: " << e.what() << '\n';
        return 1;
    }
}
