#ifdef _WIN32
#include "app/AudioService.hpp"
#include "ipc/ControlServer.hpp"
#include "realtime/RealtimeInstrumentation.hpp"
#ifndef WIN32_LEAN_AND_MEAN
#define WIN32_LEAN_AND_MEAN
#endif
#include <aclapi.h>
#include <array>
#include <stdexcept>
#include <windows.h>

namespace {
// Local control frames are at most 4 KiB. A connected client must make progress within this
// deadline; command execution itself is not timed out here.
constexpr DWORD ClientIoTimeoutMs = 1000;
class Handle {
  public:
    explicit Handle(HANDLE value) : value_(value) {}
    ~Handle() {
        if (value_ && value_ != INVALID_HANDLE_VALUE)
            CloseHandle(value_);
    }
    Handle(const Handle&) = delete;
    Handle& operator=(const Handle&) = delete;
    HANDLE get() const noexcept {
        return value_;
    }

  private:
    HANDLE value_;
};

class PipeOperation {
  public:
    PipeOperation(HANDLE pipe, HANDLE stop)
        : pipe_(pipe), stop_(stop), event_(CreateEventW(nullptr, TRUE, FALSE, nullptr)) {
        if (!event_.get())
            throw std::runtime_error("Control pipe event creation failed");
        operation_.hEvent = event_.get();
    }
    OVERLAPPED* begin() noexcept {
        ResetEvent(event_.get());
        operation_ = {};
        operation_.hEvent = event_.get();
        return &operation_;
    }
    bool finish(BOOL immediate, DWORD& bytes, DWORD timeout) noexcept {
        if (immediate)
            return true;
        if (GetLastError() != ERROR_IO_PENDING)
            return false;
        const std::array events{stop_, event_.get()};
        if (WaitForMultipleObjects(static_cast<DWORD>(events.size()), events.data(), FALSE,
                                   timeout) == WAIT_OBJECT_0 + 1)
            return GetOverlappedResult(pipe_, &operation_, &bytes, FALSE) != FALSE;
        CancelIoEx(pipe_, &operation_);
        // The buffer and OVERLAPPED must outlive completion, including cancellation.
        (void)GetOverlappedResult(pipe_, &operation_, &bytes, TRUE);
        return false;
    }

  private:
    HANDLE pipe_;
    HANDLE stop_;
    Handle event_;
    OVERLAPPED operation_{};
};

class PipeSecurity {
  public:
    PipeSecurity() {
        HANDLE rawToken = nullptr;
        if (!OpenProcessToken(GetCurrentProcess(), TOKEN_QUERY, &rawToken))
            throw std::runtime_error("Control pipe token query failed");
        const Handle token{rawToken};
        DWORD size = 0;
        (void)GetTokenInformation(token.get(), TokenUser, nullptr, 0, &size);
        std::vector<std::byte> user(size);
        if (!GetTokenInformation(token.get(), TokenUser, user.data(), size, &size))
            throw std::runtime_error("Control pipe user query failed");
        EXPLICIT_ACCESSW entry{};
        entry.grfAccessPermissions = GENERIC_ALL;
        entry.grfAccessMode = SET_ACCESS;
        entry.Trustee.TrusteeForm = TRUSTEE_IS_SID;
        entry.Trustee.TrusteeType = TRUSTEE_IS_USER;
        entry.Trustee.ptstrName =
            reinterpret_cast<LPWSTR>(reinterpret_cast<TOKEN_USER*>(user.data())->User.Sid);
        PACL acl = nullptr;
        const auto result = SetEntriesInAclW(1, &entry, nullptr, &acl);
        acl_.reset(acl);
        if (result != ERROR_SUCCESS ||
            !InitializeSecurityDescriptor(&descriptor_, SECURITY_DESCRIPTOR_REVISION) ||
            !SetSecurityDescriptorDacl(&descriptor_, TRUE, acl_.get(), FALSE))
            throw std::runtime_error("Control pipe access descriptor failed");
    }
    SECURITY_ATTRIBUTES attributes() noexcept {
        return {sizeof(SECURITY_ATTRIBUTES), &descriptor_, FALSE};
    }

  private:
    std::unique_ptr<ACL, decltype(&LocalFree)> acl_{nullptr, LocalFree};
    SECURITY_DESCRIPTOR descriptor_{};
};
} // namespace

ControlServer::ControlServer(AudioService& service, std::string endpoint)
    : service_(service),
      endpoint_(endpoint.empty() ? R"(\\.\pipe\ADVoice.AudioService.v1)" : std::move(endpoint)),
      stopEvent_(CreateEventW(nullptr, TRUE, FALSE, nullptr)) {
    if (!stopEvent_)
        throw std::runtime_error("Control stop event creation failed");
}
ControlServer::~ControlServer() {
    stop();
    CloseHandle(stopEvent_);
}
void ControlServer::stop() noexcept {
    stop_.store(true, std::memory_order_release);
    SetEvent(stopEvent_);
}
void ControlServer::serve() {
    RealtimeInstrumentation::reportIpc();
    const std::wstring pipeName(endpoint_.begin(), endpoint_.end());
    PipeSecurity security;
    auto attributes = security.attributes();
    while (!stop_.load(std::memory_order_acquire) && !service_.shutdownRequested()) {
        const Handle owner{CreateNamedPipeW(
            pipeName.c_str(), PIPE_ACCESS_DUPLEX | FILE_FLAG_OVERLAPPED,
            PIPE_TYPE_MESSAGE | PIPE_READMODE_MESSAGE | PIPE_WAIT | PIPE_REJECT_REMOTE_CLIENTS, 4,
            65536, static_cast<DWORD>(MaxControlRequestBytes + 2), 1000, &attributes)};
        const auto pipe = owner.get();
        if (pipe == INVALID_HANDLE_VALUE)
            throw std::runtime_error("CreateNamedPipe failed");
        PipeOperation operation{pipe, stopEvent_};
        const auto connect = ConnectNamedPipe(pipe, operation.begin());
        DWORD transferred = 0;
        const auto connected = !connect && GetLastError() == ERROR_PIPE_CONNECTED
                                   ? true
                                   : operation.finish(connect, transferred, INFINITE);
        if (connected && !stop_.load(std::memory_order_acquire)) {
            std::array<char, MaxControlRequestBytes + 2> buffer{};
            DWORD read = 0;
            if (operation.finish(ReadFile(pipe, buffer.data(), static_cast<DWORD>(buffer.size()),
                                          &read, operation.begin()),
                                 read, ClientIoTimeoutMs) &&
                read != 0 && !stop_.load(std::memory_order_acquire)) {
                auto response = serializeControlResponse(
                    service_.handleLine(std::string_view{buffer.data(), read}));
                DWORD written = 0;
                (void)operation.finish(WriteFile(pipe, response.data(),
                                                 static_cast<DWORD>(response.size()), &written,
                                                 operation.begin()),
                                       written, ClientIoTimeoutMs);
            }
        }
        // Closing the server handle preserves queued reply data (FILE_PIPE_CLOSING_STATE).
        // DisconnectNamedPipe would discard it, and FlushFileBuffers waits forever for a reader.
    }
}
#endif
