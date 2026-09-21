#include "ipc/ControlProtocol.hpp"
#include <iostream>
#include <string>
#include <string_view>
namespace {
std::string_view commandAlias(std::string_view command) noexcept {
    if (command == "audio-dump")
        return "GetDiagnostics";
    if (command == "state")
        return "GetServiceState";
    if (command == "devices")
        return "GetDevices";
    if (command == "shutdown")
        return "ShutdownService";
    return command;
}
} // namespace
#ifdef _WIN32
#ifndef WIN32_LEAN_AND_MEAN
#define WIN32_LEAN_AND_MEAN
#endif
#include <windows.h>
int main(int argc, char** argv) {
    if (argc < 2) {
        std::cerr << "Usage: AudioControl <Command> [key=value ...]\n";
        return 2;
    }
    std::string line =
        std::to_string(ControlProtocolVersion) + "|" + std::string(commandAlias(argv[1]));
    for (int i = 2; i < argc; ++i)
        line += "|" + std::string(argv[i]);
    line += '\n';
    const auto pipe =
        CreateFileW(L"\\\\.\\pipe\\ADVoice.AudioService.v1", GENERIC_READ | GENERIC_WRITE, 0,
                    nullptr, OPEN_EXISTING, 0, nullptr);
    if (pipe == INVALID_HANDLE_VALUE) {
        std::cerr << "Cannot connect to AudioService\n";
        return 1;
    }
    DWORD written = 0;
    WriteFile(pipe, line.data(), static_cast<DWORD>(line.size()), &written, nullptr);
    char buffer[16384]{};
    DWORD read = 0;
    ReadFile(pipe, buffer, sizeof(buffer) - 1, &read, nullptr);
    CloseHandle(pipe);
    std::cout.write(buffer, read);
    return 0;
}
#else
#include <cstring>
#include <sys/socket.h>
#include <sys/un.h>
#include <unistd.h>
int main(int argc, char** argv) {
    if (argc < 2) {
        std::cerr << "Usage: AudioControl <Command> [key=value ...]\n";
        return 2;
    }
    std::string line =
        std::to_string(ControlProtocolVersion) + "|" + std::string(commandAlias(argv[1]));
    for (int i = 2; i < argc; ++i)
        line += "|" + std::string(argv[i]);
    line += '\n';
    const auto fd = ::socket(AF_UNIX, SOCK_STREAM, 0);
    sockaddr_un addr{};
    addr.sun_family = AF_UNIX;
    std::strncpy(addr.sun_path, "/tmp/advoice-audioservice.sock", sizeof(addr.sun_path) - 1);
    if (::connect(fd, reinterpret_cast<sockaddr*>(&addr), sizeof(addr)) != 0) {
        std::cerr << "Cannot connect to AudioService\n";
        return 1;
    }
    (void)::write(fd, line.data(), line.size());
    char buffer[16384]{};
    const auto n = ::read(fd, buffer, sizeof(buffer) - 1);
    ::close(fd);
    if (n > 0)
        std::cout.write(buffer, n);
    return 0;
}
#endif
