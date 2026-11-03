#ifdef _WIN32
#include "app/AudioService.hpp"
#include "ipc/ControlServer.hpp"
#include "realtime/RealtimeInstrumentation.hpp"
#ifndef WIN32_LEAN_AND_MEAN
#define WIN32_LEAN_AND_MEAN
#endif
#include <aclapi.h>
#include <algorithm>
#include <array>
#include <charconv>
#include <ranges>
#include <stdexcept>
#include <windows.h>

namespace {
// Local control frames are at most 4 KiB. A connected client must make progress within this
// deadline; command execution itself is not timed out here.
constexpr DWORD ClientIoTimeoutMs = 1000;
ULONGLONG millisecondsNow() noexcept {
    return static_cast<ULONGLONG>(monotonicTicksNow() / 1'000'000);
}
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
    void reset(HANDLE value) noexcept {
        if (value_ && value_ != INVALID_HANDLE_VALUE)
            CloseHandle(value_);
        value_ = value;
    }

  private:
    HANDLE value_;
};

class NotificationPipes;
class PipeOperation {
  public:
    PipeOperation(HANDLE pipe, HANDLE stop)
        : pipe_(pipe), stop_(stop), event_(CreateEventW(nullptr, TRUE, FALSE, nullptr)) {
        if (!event_.get())
            throw std::runtime_error("Control pipe event creation failed");
        operation_.hEvent = event_.get();
    }
    ~PipeOperation() {
        if (!pending_)
            return;
        CancelIoEx(pipe_, &operation_);
        DWORD bytes = 0;
        (void)GetOverlappedResult(pipe_, &operation_, &bytes, TRUE);
    }
    OVERLAPPED* begin() noexcept {
        ResetEvent(event_.get());
        operation_ = {};
        operation_.hEvent = event_.get();
        return &operation_;
    }
    bool finish(BOOL immediate, DWORD& bytes, DWORD timeout, NotificationPipes& notifications);

  private:
    HANDLE pipe_;
    HANDLE stop_;
    Handle event_;
    OVERLAPPED operation_{};
    bool pending_{false};
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

// Owned and pumped by the control thread. Each subscriber has one outstanding write, never a
// queue: after a slow read completes the next sample is current. No audio callback performs IPC.
class NotificationPipes {
  public:
    NotificationPipes(AudioService& service, std::wstring name, SECURITY_ATTRIBUTES& attributes)
        : service_(service), name_(std::move(name)), attributes_(attributes) {
        if (!timer_.get())
            throw std::runtime_error("Notification timer creation failed");
        for (auto& subscriber : subscribers_)
            open(subscriber);
    }
    void update() {
        const auto now = millisecondsNow();
        for (auto& item : subscribers_) {
            DWORD bytes = 0;
            if (item.pending) {
                if (!GetOverlappedResult(item.pipe.get(), &item.operation, &bytes, FALSE)) {
                    if (GetLastError() == ERROR_IO_INCOMPLETE &&
                        (item.phase == Phase::Connecting || now < item.deadline))
                        continue;
                    open(item);
                    continue;
                }
                item.pending = false;
                ResetEvent(item.event.get());
            }
            if (item.phase == Phase::Connecting) {
                item.phase = Phase::Reading;
                item.deadline = now + ClientIoTimeoutMs;
                const auto read =
                    ReadFile(item.pipe.get(), item.request.data(),
                             static_cast<DWORD>(item.request.size()), &bytes, item.begin());
                if (!complete(item, read))
                    continue;
            }
            if (item.phase == Phase::Reading) {
                ControlRequest request;
                const auto parsed = parseControlRequest({item.request.data(), bytes}, request);
                constexpr std::array commands{ControlCommand::GetPlaybackSnapshot,
                                              ControlCommand::GetSpectrum,
                                              ControlCommand::GetInputLevel};
                const auto intervalText = request.value("intervalMs");
                if (intervalText.empty()) {
                    open(item);
                    continue;
                }
                unsigned interval = 0;
                const auto converted = std::from_chars(
                    intervalText.data(), intervalText.data() + intervalText.size(), interval);
                if (!parsed || request.protocolVersion != ControlProtocolVersion ||
                    std::ranges::find(commands, request.command) == commands.end() ||
                    converted.ec != std::errc{} ||
                    converted.ptr != intervalText.data() + intervalText.size() || interval < 16 ||
                    interval > 1000) {
                    open(item);
                    continue;
                }
                item.command = std::move(request);
                item.interval = interval;
                item.phase = Phase::Waiting;
                item.due = now;
            } else if (item.phase == Phase::Writing) {
                item.phase = Phase::Waiting;
            }
            if (item.phase != Phase::Waiting || now < item.due)
                continue;
            const auto payload = std::to_string(monotonicTicksNow()) + '|' +
                                 serializeControlResponse(service_.handle(item.command));
            item.frame.resize(4);
            const auto length = static_cast<std::uint32_t>(payload.size());
            for (unsigned index = 0; index < 4; ++index)
                item.frame[index] = static_cast<char>((length >> (8 * index)) & 0xff);
            item.frame += payload;
            item.phase = Phase::Writing;
            item.due += ((now - item.due) / item.interval + 1) * item.interval;
            item.deadline = now + ClientIoTimeoutMs;
            const auto written =
                WriteFile(item.pipe.get(), item.frame.data(), static_cast<DWORD>(item.frame.size()),
                          &bytes, item.begin());
            if (complete(item, written))
                item.phase = Phase::Waiting;
        }
    }
    DWORD waitMilliseconds() const noexcept {
        DWORD wait = INFINITE;
        const auto now = millisecondsNow();
        for (const auto& item : subscribers_) {
            if (item.phase == Phase::Connecting)
                continue;
            const auto deadline = item.pending ? item.deadline : item.due;
            wait = std::min(wait, static_cast<DWORD>(deadline > now ? deadline - now : 0));
        }
        return wait;
    }
    std::array<HANDLE, 7> events(HANDLE stop, HANDLE control) const noexcept {
        return {stop,
                control,
                subscribers_[0].event.get(),
                subscribers_[1].event.get(),
                subscribers_[2].event.get(),
                subscribers_[3].event.get(),
                timer_.get()};
    }
    void arm(DWORD milliseconds) {
        if (milliseconds == INFINITE) {
            CancelWaitableTimer(timer_.get());
            return;
        }
        LARGE_INTEGER due{};
        due.QuadPart = -std::max<LONGLONG>(1, static_cast<LONGLONG>(milliseconds) * 10'000);
        if (!SetWaitableTimer(timer_.get(), &due, 0, nullptr, nullptr, FALSE))
            throw std::runtime_error("Notification timer scheduling failed");
    }

  private:
    enum class Phase { Connecting, Reading, Waiting, Writing };
    struct Subscriber {
        Handle pipe{INVALID_HANDLE_VALUE};
        Handle event{CreateEventW(nullptr, TRUE, FALSE, nullptr)};
        OVERLAPPED operation{};
        bool pending{false};
        Phase phase{Phase::Connecting};
        ULONGLONG due{0}, deadline{0};
        unsigned interval{0};
        ControlRequest command;
        std::array<char, MaxControlRequestBytes + 2> request{};
        std::string frame;
        OVERLAPPED* begin() noexcept {
            ResetEvent(event.get());
            operation = {};
            operation.hEvent = event.get();
            return &operation;
        }
        void cancel() noexcept {
            if (!pending)
                return;
            CancelIoEx(pipe.get(), &operation);
            DWORD bytes = 0;
            (void)GetOverlappedResult(pipe.get(), &operation, &bytes, TRUE);
            pending = false;
        }
        ~Subscriber() {
            cancel();
        }
    };
    bool complete(Subscriber& item, BOOL immediate) {
        if (immediate) {
            ResetEvent(item.event.get());
            return true;
        }
        if (GetLastError() == ERROR_IO_PENDING) {
            item.pending = true;
        } else {
            open(item);
        }
        return false;
    }
    void open(Subscriber& item) {
        item.cancel();
        item.pipe.reset(INVALID_HANDLE_VALUE);
        item.pipe.reset(CreateNamedPipeW(
            name_.c_str(), PIPE_ACCESS_DUPLEX | FILE_FLAG_OVERLAPPED | firstInstance_,
            PIPE_TYPE_MESSAGE | PIPE_READMODE_MESSAGE | PIPE_WAIT | PIPE_REJECT_REMOTE_CLIENTS,
            static_cast<DWORD>(subscribers_.size()), 4096, static_cast<DWORD>(item.request.size()),
            ClientIoTimeoutMs, &attributes_));
        if (!item.event.get() || item.pipe.get() == INVALID_HANDLE_VALUE)
            throw std::runtime_error("Notification pipe creation failed");
        firstInstance_ = 0;
        item.phase = Phase::Connecting;
        const auto connected = ConnectNamedPipe(item.pipe.get(), item.begin());
        if (!connected && GetLastError() == ERROR_PIPE_CONNECTED) {
            ResetEvent(item.event.get());
            return;
        }
        if (!connected && GetLastError() != ERROR_IO_PENDING)
            throw std::runtime_error("Notification pipe connection failed");
        item.pending = !connected;
    }
    AudioService& service_;
    std::wstring name_;
    SECURITY_ATTRIBUTES& attributes_;
    DWORD firstInstance_{FILE_FLAG_FIRST_PIPE_INSTANCE};
    Handle timer_{CreateWaitableTimerExW(nullptr, nullptr, CREATE_WAITABLE_TIMER_HIGH_RESOLUTION,
                                         TIMER_ALL_ACCESS)};
    std::array<Subscriber, 4> subscribers_;
};

bool PipeOperation::finish(BOOL immediate, DWORD& bytes, DWORD timeout,
                           NotificationPipes& notifications) {
    if (immediate)
        return true;
    if (GetLastError() != ERROR_IO_PENDING)
        return false;
    pending_ = true;
    const auto deadline = timeout == INFINITE ? MAXULONGLONG : millisecondsNow() + timeout;
    for (;;) {
        notifications.update();
        const auto now = millisecondsNow();
        const DWORD remaining = deadline == MAXULONGLONG
                                    ? INFINITE
                                    : static_cast<DWORD>(deadline > now ? deadline - now : 0);
        const auto events = notifications.events(stop_, event_.get());
        notifications.arm(std::min(remaining, notifications.waitMilliseconds()));
        const auto result = WaitForMultipleObjects(static_cast<DWORD>(events.size()), events.data(),
                                                   FALSE, INFINITE);
        if (result == WAIT_OBJECT_0 + 1) {
            pending_ = false;
            return GetOverlappedResult(pipe_, &operation_, &bytes, FALSE) != FALSE;
        }
        if (result == WAIT_OBJECT_0 || result == WAIT_FAILED || millisecondsNow() >= deadline)
            break;
    }
    CancelIoEx(pipe_, &operation_);
    (void)GetOverlappedResult(pipe_, &operation_, &bytes, TRUE);
    pending_ = false;
    return false;
}
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
    NotificationPipes notifications{service_, pipeName + L".events", attributes};
    // The first instance is created as the pipe's first: if another service (started by hand, or by
    // another copy of the app on the same profile) already serves this name, this one fails loudly
    // instead of silently sharing the app's commands with it.
    DWORD firstInstance = FILE_FLAG_FIRST_PIPE_INSTANCE;
    while (!stop_.load(std::memory_order_acquire) && !service_.shutdownRequested()) {
        notifications.update();
        const Handle owner{CreateNamedPipeW(
            pipeName.c_str(), PIPE_ACCESS_DUPLEX | FILE_FLAG_OVERLAPPED | firstInstance,
            PIPE_TYPE_MESSAGE | PIPE_READMODE_MESSAGE | PIPE_WAIT | PIPE_REJECT_REMOTE_CLIENTS, 4,
            65536, static_cast<DWORD>(MaxControlRequestBytes + 2), 1000, &attributes)};
        const auto pipe = owner.get();
        if (pipe == INVALID_HANDLE_VALUE)
            throw std::runtime_error(firstInstance != 0 && GetLastError() == ERROR_ACCESS_DENIED
                                         ? "Another AudioService already serves this control pipe"
                                         : "CreateNamedPipe failed");
        firstInstance = 0;
        PipeOperation operation{pipe, stopEvent_};
        const auto connect = ConnectNamedPipe(pipe, operation.begin());
        DWORD transferred = 0;
        const auto connected =
            !connect && GetLastError() == ERROR_PIPE_CONNECTED
                ? true
                : operation.finish(connect, transferred, INFINITE, notifications);
        if (connected && !stop_.load(std::memory_order_acquire)) {
            std::array<char, MaxControlRequestBytes + 2> buffer{};
            DWORD read = 0;
            if (operation.finish(ReadFile(pipe, buffer.data(), static_cast<DWORD>(buffer.size()),
                                          &read, operation.begin()),
                                 read, ClientIoTimeoutMs, notifications) &&
                read != 0 && !stop_.load(std::memory_order_acquire)) {
                auto response = serializeControlResponse(
                    service_.handleLine(std::string_view{buffer.data(), read}));
                DWORD written = 0;
                (void)operation.finish(WriteFile(pipe, response.data(),
                                                 static_cast<DWORD>(response.size()), &written,
                                                 operation.begin()),
                                       written, ClientIoTimeoutMs, notifications);
            }
        }
        // Closing the server handle preserves queued reply data (FILE_PIPE_CLOSING_STATE).
        // DisconnectNamedPipe would discard it, and FlushFileBuffers waits forever for a reader.
    }
}
#endif
