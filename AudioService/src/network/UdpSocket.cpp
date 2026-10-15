#include "network/UdpSocket.hpp"
#include "realtime/RealtimeInstrumentation.hpp"

#include <cstring>
#include <stdexcept>

#ifdef _WIN32
#ifndef WIN32_LEAN_AND_MEAN
#define WIN32_LEAN_AND_MEAN
#endif
#include <winsock2.h>
#include <ws2tcpip.h>
namespace {
struct WinsockInit {
    WinsockInit() {
        WSADATA data{};
        if (WSAStartup(MAKEWORD(2, 2), &data) != 0)
            throw std::runtime_error("WSAStartup failed");
    }
    ~WinsockInit() {
        WSACleanup();
    }
};
WinsockInit winsock;
} // namespace
#else
#include <arpa/inet.h>
#include <netdb.h>
#include <sys/socket.h>
#include <sys/select.h>
#include <sys/time.h>
#include <unistd.h>
#endif

namespace {
/** IPv4 address of `host` (a literal, or a name resolved once). */
[[nodiscard]] bool resolveIpv4(const std::string& host, std::uint16_t port,
                               sockaddr_in& address) noexcept {
    address = {};
    address.sin_family = AF_INET;
    address.sin_port = htons(port);
    if (inet_pton(AF_INET, host.c_str(), &address.sin_addr) == 1)
        return true;
    addrinfo hints{};
    hints.ai_family = AF_INET;
    hints.ai_socktype = SOCK_DGRAM;
    addrinfo* result = nullptr;
    const auto service = std::to_string(port);
    if (getaddrinfo(host.c_str(), service.c_str(), &hints, &result) != 0 || result == nullptr)
        return false;
    std::memcpy(&address, result->ai_addr, sizeof(address));
    freeaddrinfo(result);
    return true;
}
} // namespace

UdpSocket::UdpSocket() = default;
UdpSocket::~UdpSocket() {
    close();
}
std::uint64_t UdpSocket::endpointIdentity(const std::string& host, std::uint16_t port) noexcept {
    sockaddr_in address{};
    return resolveIpv4(host, port, address)
               ? (static_cast<std::uint64_t>(address.sin_addr.s_addr) << 16U) | port
               : 0U;
}
void UdpSocket::bind(std::uint16_t port) {
    RealtimeInstrumentation::reportNetworkIo();
    close();
#ifdef _WIN32
    auto s = ::socket(AF_INET, SOCK_DGRAM, IPPROTO_UDP);
    if (s == INVALID_SOCKET)
        throw std::runtime_error("UDP socket failed");
    socket_ = static_cast<std::uintptr_t>(s);
#else
    socket_ = ::socket(AF_INET, SOCK_DGRAM, 0);
    if (socket_ < 0)
        throw std::runtime_error("UDP socket failed");
#endif
    sockaddr_in addr{};
    addr.sin_family = AF_INET;
    addr.sin_addr.s_addr = htonl(INADDR_ANY);
    addr.sin_port = htons(port);
#ifdef _WIN32
    if (::bind(static_cast<SOCKET>(socket_), reinterpret_cast<sockaddr*>(&addr), sizeof(addr)) ==
        SOCKET_ERROR)
        throw std::runtime_error("UDP bind failed");
#else
    if (::bind(socket_, reinterpret_cast<sockaddr*>(&addr), sizeof(addr)) != 0)
        throw std::runtime_error("UDP bind failed");
#endif
}
void UdpSocket::connect(const std::string& host, std::uint16_t port, std::uint16_t localPort) {
    RealtimeInstrumentation::reportNetworkIo();
#ifdef _WIN32
    if (socket_ == ~std::uintptr_t{0}) {
        auto s = ::socket(AF_INET, SOCK_DGRAM, IPPROTO_UDP);
        if (s == INVALID_SOCKET)
            throw std::runtime_error("UDP socket failed");
        socket_ = static_cast<std::uintptr_t>(s);
    }
#else
    if (socket_ < 0) {
        socket_ = ::socket(AF_INET, SOCK_DGRAM, 0);
        if (socket_ < 0)
            throw std::runtime_error("UDP socket failed");
    }
#endif
    if (localPort != 0) {
        sockaddr_in local{};
        local.sin_family = AF_INET;
        local.sin_addr.s_addr = htonl(INADDR_ANY);
        local.sin_port = htons(localPort);
#ifdef _WIN32
        if (::bind(static_cast<SOCKET>(socket_), reinterpret_cast<sockaddr*>(&local),
                   sizeof(local)) == SOCKET_ERROR)
            throw std::runtime_error("UDP bind before connect failed");
#else
        if (::bind(socket_, reinterpret_cast<sockaddr*>(&local), sizeof(local)) != 0)
            throw std::runtime_error("UDP bind before connect failed");
#endif
    }
    // Keep the socket unconnected: room audio must receive both relay fallback packets and direct
    // peer packets on the same NAT-mapped source port. send() retains the old default-destination
    // API.
    defaultHost_ = host;
    defaultPort_ = port;
    sockaddr_in resolved{};
    defaultAddress_ = resolveIpv4(host, port, resolved) ? resolved.sin_addr.s_addr : 0U;
}
void UdpSocket::setReceiveTimeoutMs(std::uint32_t timeoutMs) {
    receiveTimeoutMs_.store(timeoutMs, std::memory_order_relaxed);
}
bool UdpSocket::send(std::span<const std::byte> bytes) noexcept {
    return sendTo(defaultHost_, defaultPort_, bytes);
}
bool UdpSocket::sendTo(const std::string& host, std::uint16_t port,
                       std::span<const std::byte> bytes) noexcept {
    RealtimeInstrumentation::reportNetworkIo();
    if (host.empty() || port == 0)
        return false;
    sockaddr_in address{};
    if (!resolveIpv4(host, port, address))
        return false;
#ifdef _WIN32
    if (socket_ == ~std::uintptr_t{0})
        return false;
    return ::sendto(static_cast<SOCKET>(socket_), reinterpret_cast<const char*>(bytes.data()),
                    static_cast<int>(bytes.size()), 0, reinterpret_cast<const sockaddr*>(&address),
                    sizeof(address)) == static_cast<int>(bytes.size());
#else
    if (socket_ < 0)
        return false;
    return ::sendto(socket_, bytes.data(), bytes.size(), 0,
                    reinterpret_cast<const sockaddr*>(&address),
                    sizeof(address)) == static_cast<ssize_t>(bytes.size());
#endif
}
std::size_t UdpSocket::receive(std::span<std::byte> bytes) noexcept {
    RealtimeInstrumentation::reportNetworkIo();
    // Readiness timeout leaves an arriving datagram queued. Canceling a short blocking
    // recvfrom with SO_RCVTIMEO lost paced datagrams on the Windows receive boundary.
    const auto timeoutMs = receiveTimeoutMs_.load(std::memory_order_relaxed);
    if (timeoutMs != 0 && !hasPendingDatagram(timeoutMs)) {
        lastFromDefault_ = false;
        lastSourceIdentity_ = 0;
        return 0;
    }
    sockaddr_in from{};
#ifdef _WIN32
    if (socket_ == ~std::uintptr_t{0})
        return 0;
    int fromLength = sizeof(from);
    const auto count = ::recvfrom(
        static_cast<SOCKET>(socket_), reinterpret_cast<char*>(bytes.data()),
        static_cast<int>(bytes.size()), 0, reinterpret_cast<sockaddr*>(&from), &fromLength);
#else
    if (socket_ < 0)
        return 0;
    socklen_t fromLength = sizeof(from);
    const auto count = ::recvfrom(socket_, bytes.data(), bytes.size(), 0,
                                  reinterpret_cast<sockaddr*>(&from), &fromLength);
#endif
    lastFromDefault_ = count > 0 && defaultAddress_ != 0 && from.sin_addr.s_addr == defaultAddress_ &&
                       from.sin_port == htons(defaultPort_);
    lastSourceIdentity_ = count > 0
                              ? (static_cast<std::uint64_t>(from.sin_addr.s_addr) << 16U) |
                                    ntohs(from.sin_port)
                              : 0U;
    return count > 0 ? static_cast<std::size_t>(count) : 0;
}
bool UdpSocket::hasPendingDatagram(std::uint32_t timeoutMs) const noexcept {
    RealtimeInstrumentation::reportNetworkIo();
    fd_set readable;
    FD_ZERO(&readable);
    timeval timeout{};
    timeout.tv_sec = static_cast<decltype(timeout.tv_sec)>(timeoutMs / 1'000U);
    timeout.tv_usec = static_cast<decltype(timeout.tv_usec)>((timeoutMs % 1'000U) * 1'000U);
#ifdef _WIN32
    if (socket_ == ~std::uintptr_t{0})
        return false;
    FD_SET(static_cast<SOCKET>(socket_), &readable);
    return ::select(0, &readable, nullptr, nullptr, &timeout) > 0;
#else
    if (socket_ < 0)
        return false;
    FD_SET(socket_, &readable);
    return ::select(socket_ + 1, &readable, nullptr, nullptr, &timeout) > 0;
#endif
}
std::uint16_t UdpSocket::localPort() const noexcept {
    sockaddr_in address{};
#ifdef _WIN32
    if (socket_ == ~std::uintptr_t{0})
        return 0;
    int length = sizeof(address);
    if (::getsockname(static_cast<SOCKET>(socket_), reinterpret_cast<sockaddr*>(&address),
                      &length) == SOCKET_ERROR)
        return 0;
#else
    if (socket_ < 0)
        return 0;
    socklen_t length = sizeof(address);
    if (::getsockname(socket_, reinterpret_cast<sockaddr*>(&address), &length) != 0)
        return 0;
#endif
    return ntohs(address.sin_port);
}
void UdpSocket::close() noexcept {
    RealtimeInstrumentation::reportNetworkIo();
    receiveTimeoutMs_.store(0, std::memory_order_relaxed);
#ifdef _WIN32
    if (socket_ != ~std::uintptr_t{0}) {
        closesocket(static_cast<SOCKET>(socket_));
        socket_ = ~std::uintptr_t{0};
    }
#else
    if (socket_ >= 0) {
        ::close(socket_);
        socket_ = -1;
    }
#endif
    defaultHost_.clear();
    defaultPort_ = 0;
    defaultAddress_ = 0;
}
