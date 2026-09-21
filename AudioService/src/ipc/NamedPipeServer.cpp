#ifdef _WIN32
#include "app/AudioService.hpp"
#include "ipc/ControlServer.hpp"
#include "realtime/RealtimeInstrumentation.hpp"
#ifndef WIN32_LEAN_AND_MEAN
#define WIN32_LEAN_AND_MEAN
#endif
#include <array>
#include <stdexcept>
#include <windows.h>

ControlServer::ControlServer(AudioService& service, std::string endpoint)
    : service_(service),
      endpoint_(endpoint.empty() ? R"(\\.\pipe\ADVoice.AudioService.v1)" : std::move(endpoint)) {}
ControlServer::~ControlServer() {
    stop();
}
void ControlServer::stop() noexcept {
    stop_.store(true, std::memory_order_release);
}
void ControlServer::serve() {
    RealtimeInstrumentation::reportIpc();
    const std::wstring pipeName(endpoint_.begin(), endpoint_.end());
    while (!stop_.load(std::memory_order_acquire) && !service_.shutdownRequested()) {
        const auto pipe = CreateNamedPipeW(pipeName.c_str(), PIPE_ACCESS_DUPLEX,
                                           PIPE_TYPE_MESSAGE | PIPE_READMODE_MESSAGE | PIPE_WAIT, 4,
                                           65536, 65536, 1000, nullptr);
        if (pipe == INVALID_HANDLE_VALUE)
            throw std::runtime_error("CreateNamedPipe failed");
        const auto connected =
            ConnectNamedPipe(pipe, nullptr) != FALSE || GetLastError() == ERROR_PIPE_CONNECTED;
        if (connected) {
            std::array<char, 65536> buffer{};
            DWORD read = 0;
            if (ReadFile(pipe, buffer.data(), static_cast<DWORD>(buffer.size() - 1), &read,
                         nullptr) &&
                read != 0) {
                auto response = serializeControlResponse(
                    service_.handleLine(std::string_view{buffer.data(), read}));
                DWORD written = 0;
                (void)WriteFile(pipe, response.data(), static_cast<DWORD>(response.size()),
                                &written, nullptr);
            }
        }
        FlushFileBuffers(pipe);
        DisconnectNamedPipe(pipe);
        CloseHandle(pipe);
    }
}
#endif
