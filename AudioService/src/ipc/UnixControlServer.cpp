#include "app/AudioService.hpp"
#include "ipc/ControlServer.hpp"
#include "realtime/RealtimeInstrumentation.hpp"
#ifndef _WIN32
#include <array>
#include <cstring>
#include <stdexcept>
#include <sys/socket.h>
#include <sys/un.h>
#include <unistd.h>
ControlServer::ControlServer(AudioService& service, std::string endpoint)
    : service_(service),
      endpoint_(endpoint.empty() ? "/tmp/advoice-audioservice.sock" : std::move(endpoint)) {}
ControlServer::~ControlServer() {
    stop();
}
void ControlServer::stop() noexcept {
    stop_.store(true, std::memory_order_release);
}
void ControlServer::serve() {
    RealtimeInstrumentation::reportIpc();
    const auto fd = ::socket(AF_UNIX, SOCK_STREAM, 0);
    if (fd < 0)
        throw std::runtime_error("control socket failed");
    ::unlink(endpoint_.c_str());
    sockaddr_un addr{};
    addr.sun_family = AF_UNIX;
    std::strncpy(addr.sun_path, endpoint_.c_str(), sizeof(addr.sun_path) - 1);
    if (::bind(fd, reinterpret_cast<sockaddr*>(&addr), sizeof(addr)) != 0) {
        ::close(fd);
        throw std::runtime_error("control bind failed");
    }
    if (::listen(fd, 4) != 0) {
        ::close(fd);
        throw std::runtime_error("control listen failed");
    }
    while (!stop_.load(std::memory_order_acquire) && !service_.shutdownRequested()) {
        const auto client = ::accept(fd, nullptr, nullptr);
        if (client < 0)
            continue;
        std::array<char, 8192> buffer{};
        const auto n = ::read(client, buffer.data(), buffer.size());
        if (n > 0) {
            auto response = serializeControlResponse(
                service_.handleLine(std::string_view{buffer.data(), static_cast<std::size_t>(n)}));
            (void)::write(client, response.data(), response.size());
        }
        ::close(client);
    }
    ::close(fd);
    ::unlink(endpoint_.c_str());
}
#else
#error UnixControlServer compiled on Windows
#endif
