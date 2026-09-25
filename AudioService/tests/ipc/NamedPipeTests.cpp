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
    HANDLE connect() {
        const auto deadline = std::chrono::steady_clock::now() + 2s;
        do {
            const auto handle =
                CreateFileA(name.c_str(), GENERIC_READ | GENERIC_WRITE | READ_CONTROL, 0, nullptr,
                            OPEN_EXISTING, 0, nullptr);
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
#endif
namespace Tests {
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
        const auto validClock = reply.starts_with(clockPrefix) && clockEnd != std::string::npos &&
            clockEnd > clockPrefix.size() &&
            reply.find_first_not_of("0123456789", clockPrefix.size()) == clockEnd;
        expect(validClock && reply.substr(clockEnd) == expected.substr(expected.find('\n')),
               "all multiline response bytes survive server close and fragmented reads");
        CloseHandle(client);
    }
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
