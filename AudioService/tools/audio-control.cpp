#include "ipc/ControlEndpoint.hpp"
#include "ipc/ControlProtocol.hpp"
#include <array>
#include <iostream>
#include <string>
#include <string_view>
#ifdef _WIN32
#ifndef WIN32_LEAN_AND_MEAN
#define WIN32_LEAN_AND_MEAN
#endif
#include <windows.h>
#else
#include <cerrno>
#include <cstring>
#include <sys/socket.h>
#include <sys/un.h>
#include <unistd.h>
#endif

namespace {
std::string_view commandAlias(std::string_view command) noexcept {
    constexpr std::array aliases{
        std::pair{"audio-dump", "GetDiagnostics"}, std::pair{"state", "GetServiceState"},
        std::pair{"devices", "GetDevices"}, std::pair{"shutdown", "ShutdownService"}};
    for (const auto& [name, target] : aliases)
        if (command == name)
            return target;
    return command;
}
template <typename Read> int printReply(Read read) {
    std::array<char, 4096> chunk{};
    std::string reply;
    for (;;) {
        const auto count = read(chunk.data(), chunk.size());
        if (count < 0) {
            std::cerr << "Cannot read AudioService reply\n";
            return 1;
        }
        if (count == 0)
            break;
        if (reply.size() + static_cast<std::size_t>(count) > (1U << 20U)) {
            std::cerr << "AudioService reply is too large\n";
            return 1;
        }
        reply.append(chunk.data(), static_cast<std::size_t>(count));
    }
    if (reply.size() < 3 || reply.back() != '\n' || reply.find('|') == std::string::npos) {
        std::cerr << "AudioService reply is empty or incomplete\n";
        return 1;
    }
    std::cout << reply;
    return std::cout && reply.starts_with("0|") ? 0 : 1;
}
} // namespace
int main(int argc, char** argv) {
    if (argc < 2) {
        std::cerr << "Usage: AudioControl <Command> [key=value ...]\n";
        return 2;
    }
    std::string line =
        std::to_string(ControlProtocolVersion) + "|" + std::string(commandAlias(argv[1]));
    for (int index = 2; index < argc; ++index)
        line += "|" + std::string(argv[index]);
    if (line.size() > MaxControlRequestBytes) {
        std::cerr << "AudioService request is too large\n";
        return 2;
    }
    line += '\n';
    const auto endpoint = controlEndpoint();
#ifdef _WIN32
    const std::wstring pipeName(endpoint.begin(), endpoint.end());
    const auto pipe = CreateFileW(pipeName.c_str(), GENERIC_READ | GENERIC_WRITE, 0, nullptr,
                                  OPEN_EXISTING, 0, nullptr);
    if (pipe == INVALID_HANDLE_VALUE) {
        std::cerr << "Cannot connect to AudioService\n";
        return 1;
    }
    const std::unique_ptr<void, decltype(&CloseHandle)> owner{pipe, CloseHandle};
    DWORD written = 0;
    if (!WriteFile(pipe, line.data(), static_cast<DWORD>(line.size()), &written, nullptr) ||
        written != line.size()) {
        std::cerr << "Cannot send AudioService request\n";
        return 1;
    }
    return printReply([pipe](char* buffer, std::size_t size) -> std::ptrdiff_t {
        DWORD read = 0;
        if (ReadFile(pipe, buffer, static_cast<DWORD>(size), &read, nullptr))
            return read;
        return GetLastError() == ERROR_BROKEN_PIPE ? 0 : -1;
    });
#else
    sockaddr_un address{};
    address.sun_family = AF_UNIX;
    if (endpoint.size() >= sizeof(address.sun_path)) {
        std::cerr << "AudioService endpoint is too long\n";
        return 1;
    }
    std::memcpy(address.sun_path, endpoint.c_str(), endpoint.size() + 1);
    struct Socket {
        int value{::socket(AF_UNIX, SOCK_STREAM, 0)};
        ~Socket() {
            if (value >= 0)
                ::close(value);
        }
    } socket;
    if (socket.value < 0 ||
        ::connect(socket.value, reinterpret_cast<sockaddr*>(&address), sizeof(address)) != 0) {
        std::cerr << "Cannot connect to AudioService\n";
        return 1;
    }
    std::size_t offset = 0;
    while (offset < line.size()) {
        const auto written =
            ::send(socket.value, line.data() + offset, line.size() - offset, MSG_NOSIGNAL);
        if (written < 0 && errno == EINTR)
            continue;
        if (written <= 0) {
            std::cerr << "Cannot send AudioService request\n";
            return 1;
        }
        offset += static_cast<std::size_t>(written);
    }
    return printReply([&](char* buffer, std::size_t size) {
        ssize_t count;
        do {
            count = ::read(socket.value, buffer, size);
        } while (count < 0 && errno == EINTR);
        return count;
    });
#endif
}
