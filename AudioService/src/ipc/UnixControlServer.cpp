#include "app/AudioService.hpp"
#include "ipc/ControlServer.hpp"
#include "realtime/RealtimeInstrumentation.hpp"
#ifndef _WIN32
#include <algorithm>
#include <array>
#include <cerrno>
#include <cstring>
#include <fcntl.h>
#include <poll.h>
#include <stdexcept>
#include <sys/socket.h>
#include <sys/un.h>
#include <unistd.h>
namespace {
struct Descriptor {
    int fd;
    std::string_view path{};
    ~Descriptor() {
        if (fd >= 0)
            ::close(fd);
        if (!path.empty())
            ::unlink(path.data());
    }
};
bool nonblocking(int fd) {
    const int flags = ::fcntl(fd, F_GETFL);
    return flags >= 0 && ::fcntl(fd, F_SETFL, flags | O_NONBLOCK) == 0 &&
           ::fcntl(fd, F_SETFD, FD_CLOEXEC) == 0;
}
} // namespace
ControlServer::ControlServer(AudioService& service, std::string endpoint)
    : service_(service),
      endpoint_(endpoint.empty() ? "/tmp/advoice-audioservice.sock" : std::move(endpoint)) {
    std::array<int, 2> wake{};
    if (::pipe(wake.data()) != 0)
        throw std::runtime_error("control wake pipe failed");
    if (!nonblocking(wake[0]) || !nonblocking(wake[1])) {
        ::close(wake[0]);
        ::close(wake[1]);
        throw std::runtime_error("control wake pipe configuration failed");
    }
    stopRead_ = wake[0];
    stopWrite_ = wake[1];
}
ControlServer::~ControlServer() {
    stop();
    ::close(stopRead_);
    ::close(stopWrite_);
}
void ControlServer::stop() noexcept {
    if (stop_.exchange(true, std::memory_order_acq_rel))
        return;
    const char wake = 1;
    while (::write(stopWrite_, &wake, 1) < 0 && errno == EINTR) {
    }
}
void ControlServer::serve() {
    RealtimeInstrumentation::reportIpc();
    const Descriptor listener{::socket(AF_UNIX, SOCK_STREAM, 0)};
    if (listener.fd < 0 || !nonblocking(listener.fd))
        throw std::runtime_error("control socket failed");
    sockaddr_un addr{};
    if (endpoint_.size() >= sizeof(addr.sun_path))
        throw std::runtime_error("control endpoint is too long");
    ::unlink(endpoint_.c_str());
    const Descriptor endpointCleanup{-1, endpoint_};
    addr.sun_family = AF_UNIX;
    std::memcpy(addr.sun_path, endpoint_.c_str(), endpoint_.size() + 1);
    if (::bind(listener.fd, reinterpret_cast<sockaddr*>(&addr), sizeof(addr)) != 0)
        throw std::runtime_error("control bind failed");
    if (::listen(listener.fd, 4) != 0)
        throw std::runtime_error("control listen failed");
    const auto wait = [this](int fd, short events) {
        std::array<pollfd, 2> descriptors{{{fd, events, 0}, {stopRead_, POLLIN, 0}}};
        while (!stop_.load(std::memory_order_acquire) && !service_.shutdownRequested()) {
            const int result = ::poll(descriptors.data(), descriptors.size(), -1);
            if (result < 0 && errno == EINTR)
                continue;
            return result > 0 && descriptors[1].revents == 0 &&
                   (descriptors[0].revents & events) != 0;
        }
        return false;
    };
    while (wait(listener.fd, POLLIN)) {
        const Descriptor client{::accept(listener.fd, nullptr, nullptr)};
        if (client.fd < 0 || !nonblocking(client.fd))
            continue;
        std::string request;
        bool complete = false;
        constexpr std::array retryErrors{EINTR, EAGAIN};
        while (request.size() <= MaxControlRequestBytes && wait(client.fd, POLLIN)) {
            std::array<char, 1024> buffer{};
            const auto count = ::read(client.fd, buffer.data(), buffer.size());
            if (count < 0 && std::ranges::find(retryErrors, errno) != retryErrors.end())
                continue;
            if (count <= 0)
                break;
            const std::string_view fragment{buffer.data(), static_cast<std::size_t>(count)};
            const auto newline = fragment.find('\n');
            request.append(fragment.substr(0, newline == std::string_view::npos ? newline
                                                                               : newline + 1));
            if (newline != std::string_view::npos) {
                complete = request.size() <= MaxControlRequestBytes + 1;
                break;
            }
        }
        if (!complete)
            continue;
        const auto response = serializeControlResponse(service_.handleLine(request));
        std::size_t sent = 0;
        // A shutdown command still receives its reply before the listening loop exits.
        while (sent < response.size() && !stop_.load(std::memory_order_acquire)) {
            const auto written = ::send(client.fd, response.data() + sent, response.size() - sent,
                                        MSG_NOSIGNAL);
            if (written < 0 && errno == EINTR)
                continue;
            if (written < 0 && errno == EAGAIN && wait(client.fd, POLLOUT))
                continue;
            if (written <= 0)
                break;
            sent += static_cast<std::size_t>(written);
        }
    }
}
#else
#error UnixControlServer compiled on Windows
#endif
