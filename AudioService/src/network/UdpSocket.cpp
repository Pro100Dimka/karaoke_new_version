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
#include <sys/time.h>
#include <unistd.h>
#endif

UdpSocket::UdpSocket() = default;
UdpSocket::~UdpSocket() {
    close();
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
    // peer packets on the same NAT-mapped source port. send() retains the old default-destination API.
    defaultHost_ = host;
    defaultPort_ = port;
}
void UdpSocket::setReceiveTimeoutMs(std::uint32_t timeoutMs) {
    RealtimeInstrumentation::reportNetworkIo();
#ifdef _WIN32
    const DWORD value = timeoutMs;
    setsockopt(static_cast<SOCKET>(socket_), SOL_SOCKET, SO_RCVTIMEO,
               reinterpret_cast<const char*>(&value), sizeof(value));
#else
    timeval value{static_cast<time_t>(timeoutMs / 1000U),
                  static_cast<suseconds_t>((timeoutMs % 1000U) * 1000U)};
    setsockopt(socket_, SOL_SOCKET, SO_RCVTIMEO, &value, sizeof(value));
#endif
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
    address.sin_family = AF_INET;
    address.sin_port = htons(port);
    if (inet_pton(AF_INET, host.c_str(), &address.sin_addr) != 1) {
        addrinfo hints{};
        hints.ai_family = AF_INET;
        hints.ai_socktype = SOCK_DGRAM;
        addrinfo* result = nullptr;
        const auto service = std::to_string(port);
        if (getaddrinfo(host.c_str(), service.c_str(), &hints, &result) != 0 || result == nullptr)
            return false;
        std::memcpy(&address, result->ai_addr, sizeof(address));
        freeaddrinfo(result);
    }
#ifdef _WIN32
    if (socket_ == ~std::uintptr_t{0})
        return false;
    return ::sendto(static_cast<SOCKET>(socket_), reinterpret_cast<const char*>(bytes.data()),
                    static_cast<int>(bytes.size()), 0,
                    reinterpret_cast<const sockaddr*>(&address), sizeof(address)) ==
           static_cast<int>(bytes.size());
#else
    if (socket_ < 0)
        return false;
    return ::sendto(socket_, bytes.data(), bytes.size(), 0,
                    reinterpret_cast<const sockaddr*>(&address), sizeof(address)) ==
           static_cast<ssize_t>(bytes.size());
#endif
}
std::size_t UdpSocket::receive(std::span<std::byte> bytes) noexcept {
    RealtimeInstrumentation::reportNetworkIo();
#ifdef _WIN32
    if (socket_ == ~std::uintptr_t{0})
        return 0;
    const auto count = ::recv(static_cast<SOCKET>(socket_), reinterpret_cast<char*>(bytes.data()),
                              static_cast<int>(bytes.size()), 0);
    return count > 0 ? static_cast<std::size_t>(count) : 0;
#else
    if (socket_ < 0)
        return 0;
    const auto count = ::recv(socket_, bytes.data(), bytes.size(), 0);
    return count > 0 ? static_cast<std::size_t>(count) : 0;
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
}
