#pragma once

#include <cstddef>
#include <cstdint>
#include <span>
#include <string>
#include <vector>

class UdpSocket {
  public:
    UdpSocket();
    ~UdpSocket();
    UdpSocket(const UdpSocket&) = delete;
    UdpSocket& operator=(const UdpSocket&) = delete;
    void bind(std::uint16_t port);
    // localPort != 0 binds this socket to it before connecting, so the outbound packet that opens the NAT/firewall
    // mapping and the inbound reply both use the same local port; 0 leaves the local port to the OS as before.
    void connect(const std::string& host, std::uint16_t port, std::uint16_t localPort = 0);
    void setReceiveTimeoutMs(std::uint32_t timeoutMs);
    [[nodiscard]] bool send(std::span<const std::byte> bytes) noexcept;
    [[nodiscard]] std::size_t receive(std::span<std::byte> bytes) noexcept;
    void close() noexcept;

  private:
#ifdef _WIN32
    std::uintptr_t socket_{~std::uintptr_t{0}};
#else
    int socket_{-1};
#endif
};
