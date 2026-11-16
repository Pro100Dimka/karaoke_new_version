#include "TestHarness.hpp"
#ifdef _WIN32
#include "app/AudioService.hpp"
#include "backend/fake/FakeAudioBackend.hpp"
#include "ipc/ControlServer.hpp"
#include <aclapi.h>
#include <array>
#include <chrono>
#include <future>
#include <thread>
#include <windows.h>

namespace {
using namespace std::chrono_literals;
struct RunningPipe {
    AudioService service{std::make_unique<FakeAudioBackend>()};
    std::string name = R"(\\.\pipe\ADVoice.Test.)" + std::to_string(GetCurrentProcessId());
    ControlServer server{service, name};
    std::promise<void> completion;
    std::future<void> done = completion.get_future();
    std::thread thread{[this] {
        try {
            server.serve();
            completion.set_value();
        } catch (...) {
            completion.set_exception(std::current_exception());
        }
    }};
    HANDLE connect(std::string_view suffix = {}) {
        const auto endpoint = name + std::string{suffix};
        const auto deadline = std::chrono::steady_clock::now() + 2s;
        do {
            const auto handle =
                CreateFileA(endpoint.c_str(), GENERIC_READ | GENERIC_WRITE | READ_CONTROL, 0,
                            nullptr, OPEN_EXISTING, 0, nullptr);
            if (handle != INVALID_HANDLE_VALUE)
                return handle;
            std::this_thread::sleep_for(1ms);
        } while (std::chrono::steady_clock::now() < deadline);
        return INVALID_HANDLE_VALUE;
    }
    ~RunningPipe() {
        server.stop();
        if (done.wait_for(100ms) != std::future_status::ready)
            CancelSynchronousIo(thread.native_handle());
        thread.join();
    }
};

bool waitForReply(HANDLE client) {
    const auto deadline = std::chrono::steady_clock::now() + 2s;
    do {
        DWORD available = 0;
        if (!PeekNamedPipe(client, nullptr, 0, nullptr, &available, nullptr))
            return false;
        if (available != 0)
            return true;
        std::this_thread::sleep_for(1ms);
    } while (std::chrono::steady_clock::now() < deadline);
    return false;
}
} // namespace
#else
#include "app/AudioService.hpp"
#include "backend/fake/FakeAudioBackend.hpp"
#include "ipc/ControlServer.hpp"
#include <array>
#include <chrono>
#include <cstdlib>
#include <cstring>
#include <future>
#include <poll.h>
#include <sys/socket.h>
#include <sys/un.h>
#include <thread>
#include <unistd.h>

namespace {
using namespace std::chrono_literals;
struct RunningUnix {
    AudioService service{std::make_unique<FakeAudioBackend>()};
    std::string name = std::string{std::getenv("TMPDIR") ? std::getenv("TMPDIR") : "/tmp"} +
                       "/control-test-" + std::to_string(::getpid());
    ControlServer server{service, name};
    std::promise<void> completion;
    std::future<void> done = completion.get_future();
    std::vector<int> clients;
    std::thread thread{[this] {
        try {
            server.serve();
            completion.set_value();
        } catch (...) {
            completion.set_exception(std::current_exception());
        }
    }};
    int connect() {
        const auto deadline = std::chrono::steady_clock::now() + 2s;
        do {
            const int client = ::socket(AF_UNIX, SOCK_STREAM, 0);
            sockaddr_un address{};
            address.sun_family = AF_UNIX;
            std::strncpy(address.sun_path, name.c_str(), sizeof(address.sun_path) - 1);
            if (client >= 0 && ::connect(client, reinterpret_cast<sockaddr*>(&address),
                                         sizeof(address)) == 0) {
                clients.push_back(client);
                return client;
            }
            if (client >= 0)
                ::close(client);
            std::this_thread::sleep_for(1ms);
        } while (std::chrono::steady_clock::now() < deadline);
        return -1;
    }
    ~RunningUnix() {
        server.stop();
        for (const int client : clients)
            ::shutdown(client, SHUT_RDWR);
        // Wake the old blocking implementation only after the assertion has failed.
        if (done.wait_for(100ms) != std::future_status::ready) {
            const int wake = connect();
            if (wake >= 0) {
                constexpr std::string_view request = "1|ShutdownService\n";
                ::send(wake, request.data(), request.size(), MSG_NOSIGNAL);
            }
        }
        thread.join();
        for (const int client : clients)
            ::close(client);
    }
};
} // namespace
#endif
namespace Tests {
void controlNotificationsPreserveCommandsAndReconnect() {
#ifdef _WIN32
    RunningPipe pipe;
    for (unsigned connection = 0; connection < 2; ++connection) {
        const auto client = pipe.connect(".events");
        expect(client != INVALID_HANDLE_VALUE, "notification subscriber connects");
        if (client == INVALID_HANDLE_VALUE)
            return;
        DWORD readMode = PIPE_READMODE_MESSAGE;
        if (!SetNamedPipeHandleState(client, &readMode, nullptr, nullptr)) {
            expect(false, "the subscriber reads one notification message at a time");
            CloseHandle(client);
            return;
        }
        constexpr std::string_view request = "1|GetPlaybackSnapshot|intervalMs=16\n";
        DWORD transferred = 0;
        expect(WriteFile(client, request.data(), static_cast<DWORD>(request.size()), &transferred,
                         nullptr) != FALSE,
               "notification subscription is written once");
        for (unsigned frame = 0; frame < 3; ++frame) {
            expect(waitForReply(client), "snapshots arrive without another request");
            std::array<char, 65536> response{};
            DWORD read = 0;
            if (!waitForReply(client))
                break;
            expect(ReadFile(client, response.data(), static_cast<DWORD>(response.size()), &read,
                            nullptr) != FALSE &&
                       read > 4,
                   "notification is a bounded complete frame");
            if (read <= 4)
                break;
            const auto* bytes = reinterpret_cast<const unsigned char*>(response.data());
            const auto length = static_cast<std::uint32_t>(bytes[0]) |
                                (static_cast<std::uint32_t>(bytes[1]) << 8) |
                                (static_cast<std::uint32_t>(bytes[2]) << 16) |
                                (static_cast<std::uint32_t>(bytes[3]) << 24);
            expect(length == read - 4 && std::string_view{response.data() + 4, length}.find(
                                             "PlaybackPositionFrames:") != std::string_view::npos,
                   "length framing preserves the multiline native snapshot");
        }
        const auto commandClient = pipe.connect();
        expect(commandClient != INVALID_HANDLE_VALUE, "notifications leave control available");
        if (commandClient != INVALID_HANDLE_VALUE) {
            constexpr std::string_view command = "1|GetClock\n";
            expect(WriteFile(commandClient, command.data(), static_cast<DWORD>(command.size()),
                             &transferred, nullptr) != FALSE &&
                       waitForReply(commandClient),
                   "a command finishes while notifications remain connected");
            CloseHandle(commandClient);
        }
        CloseHandle(client);
    }
    pipe.server.stop();
    expect(pipe.done.wait_for(300ms) == std::future_status::ready,
           "stop cancels notification listeners without client cooperation");
#endif
}

void controlPipeRestrictsItsAccessDescriptor() {
#ifdef _WIN32
    RunningPipe pipe;
    const auto client = pipe.connect();
    expect(client != INVALID_HANDLE_VALUE, "current user can open the control pipe");
    if (client == INVALID_HANDLE_VALUE)
        return;
    PACL acl = nullptr;
    PSECURITY_DESCRIPTOR descriptor = nullptr;
    const auto status = GetSecurityInfo(client, SE_KERNEL_OBJECT, DACL_SECURITY_INFORMATION,
                                        nullptr, nullptr, &acl, nullptr, &descriptor);
    expect(status == ERROR_SUCCESS && acl, "control pipe has an explicit access list");
    if (acl) {
        for (DWORD index = 0; index < acl->AceCount; ++index) {
            void* raw = nullptr;
            if (!GetAce(acl, index, &raw))
                continue;
            const auto* ace = static_cast<ACCESS_ALLOWED_ACE*>(raw);
            if (ace->Header.AceType != ACCESS_ALLOWED_ACE_TYPE)
                continue;
            auto* sid = const_cast<DWORD*>(&ace->SidStart);
            expect(!IsWellKnownSid(sid, WinWorldSid) && !IsWellKnownSid(sid, WinAnonymousSid),
                   "unrelated users cannot connect and read the control pipe");
        }
    }
    if (descriptor)
        LocalFree(descriptor);
    CloseHandle(client);
#endif
}

void controlPipePreservesRepliesAfterServerClose() {
#ifdef _WIN32
    RunningPipe pipe;
    std::vector<HANDLE> clients;
    constexpr std::string_view request = "1|GetDiagnostics\n";
    const auto expected = serializeControlResponse(pipe.service.handleLine(request));
    for (unsigned attempt = 0; attempt < 8; ++attempt) {
        const auto client = pipe.connect();
        expect(client != INVALID_HANDLE_VALUE,
               "closed server instances do not block subsequent clients");
        if (client == INVALID_HANDLE_VALUE)
            break;
        clients.push_back(client);
        DWORD written = 0;
        expect(WriteFile(client, request.data(), static_cast<DWORD>(request.size()), &written,
                         nullptr) != FALSE,
               "diagnostics request is written");
        expect(waitForReply(client), "diagnostics response is queued");
    }
    pipe.server.stop();
    expect(pipe.done.wait_for(300ms) == std::future_status::ready,
           "server closes without waiting for reply consumption");
    for (const auto client : clients) {
        std::string reply;
        std::array<char, 17> chunk{};
        DWORD read = 0;
        while (ReadFile(client, chunk.data(), static_cast<DWORD>(chunk.size()), &read, nullptr) &&
               read)
            reply.append(chunk.data(), read);
        constexpr std::string_view clockPrefix = "0|MonotonicTicks: ";
        const auto clockEnd = reply.find('\n');
        const auto validClock =
            reply.starts_with(clockPrefix) && clockEnd != std::string::npos &&
            clockEnd > clockPrefix.size() &&
            reply.find_first_not_of("0123456789", clockPrefix.size()) == clockEnd;
        expect(validClock && reply.substr(clockEnd) == expected.substr(expected.find('\n')),
               "all multiline response bytes survive server close and fragmented reads");
        CloseHandle(client);
    }
#else
    RunningUnix pipe;
    const int client = pipe.connect();
    require(client >= 0, "Unix control client connects");
    for (const std::string_view fragment : {"1|Get", "Clock"}) {
        require(::send(client, fragment.data(), fragment.size(), MSG_NOSIGNAL) ==
                    static_cast<ssize_t>(fragment.size()),
                "command fragment is sent");
        pollfd readable{client, POLLIN, 0};
        require(::poll(&readable, 1, 30) == 0,
                "the server waits for the complete newline-terminated command");
    }
    require(::send(client, "\n", 1, MSG_NOSIGNAL) == 1, "command terminator is sent");
    pollfd readable{client, POLLIN, 0};
    require(::poll(&readable, 1, 2000) == 1, "complete command receives a reply");
    std::string reply;
    std::array<char, 17> chunk{};
    ssize_t count = 0;
    while ((count = ::read(client, chunk.data(), chunk.size())) > 0)
        reply.append(chunk.data(), static_cast<std::size_t>(count));
    expect(reply.starts_with("0|") && reply.back() == '\n',
           "fragmented requests preserve the complete successful reply");
#endif
}

void controlPipeStopCancelsIdleAndStalledClients() {
#ifdef _WIN32
    for (int phase = 0; phase < 3; ++phase) {
        RunningPipe pipe;
        HANDLE client = INVALID_HANDLE_VALUE;
        if (phase != 0) {
            client = pipe.connect();
            expect(client != INVALID_HANDLE_VALUE, "test client connects");
            if (phase == 2 && client != INVALID_HANDLE_VALUE) {
                constexpr std::string_view request = "1|GetServiceState\n";
                DWORD written = 0;
                expect(WriteFile(client, request.data(), static_cast<DWORD>(request.size()),
                                 &written, nullptr) != FALSE,
                       "test request is written");
                expect(waitForReply(client), "server wrote response without client consuming it");
            }
        } else {
            const auto deadline = std::chrono::steady_clock::now() + 2s;
            while (!WaitNamedPipeA(pipe.name.c_str(), 1) &&
                   std::chrono::steady_clock::now() < deadline)
                std::this_thread::sleep_for(1ms);
        }
        pipe.server.stop();
        expect(pipe.done.wait_for(300ms) == std::future_status::ready,
               "stop cancels accept, request read, and response drain without client cooperation");
        if (client != INVALID_HANDLE_VALUE)
            CloseHandle(client);
    }
#else
    for (const bool stalled : {false, true}) {
        RunningUnix pipe;
        if (stalled) {
            require(pipe.connect() >= 0, "silent Unix client connects");
            std::this_thread::sleep_for(30ms);
        } else {
            const auto deadline = std::chrono::steady_clock::now() + 2s;
            while (::access(pipe.name.c_str(), F_OK) != 0 &&
                   std::chrono::steady_clock::now() < deadline)
                std::this_thread::sleep_for(1ms);
            require(::access(pipe.name.c_str(), F_OK) == 0, "control socket is listening");
        }
        pipe.server.stop();
        expect(pipe.done.wait_for(300ms) == std::future_status::ready,
               "stop interrupts Unix accept and a silent client's read");
    }
#endif
}

void controlPipeExpiresUnresponsiveClients() {
#ifdef _WIN32
    for (const bool requestSent : {false, true}) {
        RunningPipe pipe;
        const auto client = pipe.connect();
        expect(client != INVALID_HANDLE_VALUE, "unresponsive client connects");
        if (client == INVALID_HANDLE_VALUE)
            continue;
        if (requestSent) {
            constexpr std::string_view request = "1|GetServiceState\n";
            DWORD written = 0;
            expect(WriteFile(client, request.data(), static_cast<DWORD>(request.size()), &written,
                             nullptr) != FALSE,
                   "unresponsive client writes request");
            expect(waitForReply(client), "unresponsive client has unread response");
        }
        const auto next = pipe.connect();
        expect(next != INVALID_HANDLE_VALUE,
               "another client connects after the previous client deadline");
        if (next != INVALID_HANDLE_VALUE) {
            constexpr std::string_view request = "1|GetServiceState\n";
            DWORD written = 0;
            expect(WriteFile(next, request.data(), static_cast<DWORD>(request.size()), &written,
                             nullptr) != FALSE,
                   "next client writes request");
            expect(waitForReply(next), "server continues to serve subsequent clients");
            std::array<char, 128> reply{};
            DWORD read = 0;
            if (waitForReply(next))
                expect(ReadFile(next, reply.data(), static_cast<DWORD>(reply.size()), &read,
                                nullptr) != FALSE &&
                           read > 0,
                       "next response can be consumed");
            CloseHandle(next);
        }
        CloseHandle(client);
    }
#endif
}
} // namespace Tests
