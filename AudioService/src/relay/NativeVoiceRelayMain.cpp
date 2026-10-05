#include "relay/NativeVoiceRelay.hpp"

#include <array>
#include <atomic>
#include <charconv>
#include <chrono>
#include <cstddef>
#include <cstdint>
#include <cstdlib>
#include <iostream>
#include <iomanip>
#include <latch>
#include <mutex>
#include <optional>
#include <span>
#include <sstream>
#include <stdexcept>
#include <string>
#include <string_view>
#include <thread>
#include <vector>

#ifdef _WIN32
#ifndef WIN32_LEAN_AND_MEAN
#define WIN32_LEAN_AND_MEAN
#endif
#include <winsock2.h>
#include <ws2tcpip.h>
#include <avrt.h>
using NativeSocket = SOCKET;
constexpr NativeSocket InvalidSocket = INVALID_SOCKET;
#else
#include <arpa/inet.h>
#include <netinet/in.h>
#include <sys/socket.h>
#include <sys/time.h>
#include <unistd.h>
#include <pthread.h>
#include <sched.h>
using NativeSocket = int;
constexpr NativeSocket InvalidSocket = -1;
#endif

namespace {
constexpr std::size_t MaximumDatagramBytes = 65'535;

double monotonicSeconds() noexcept {
    return std::chrono::duration<double>(std::chrono::steady_clock::now().time_since_epoch())
        .count();
}

double wallSeconds() noexcept {
    return std::chrono::duration<double>(std::chrono::system_clock::now().time_since_epoch())
        .count();
}

void closeSocket(NativeSocket socket) noexcept {
#ifdef _WIN32
    closesocket(socket);
#else
    close(socket);
#endif
}

class RelaySocket {
  public:
    explicit RelaySocket(std::uint16_t port) {
#ifdef _WIN32
        WSADATA data{};
        if (WSAStartup(MAKEWORD(2, 2), &data) != 0)
            throw std::runtime_error("WSAStartup failed");
#endif
        socket_ = ::socket(AF_INET, SOCK_DGRAM, IPPROTO_UDP);
        if (socket_ == InvalidSocket)
            throw std::runtime_error("UDP socket failed");
        sockaddr_in address{};
        address.sin_family = AF_INET;
        address.sin_addr.s_addr = htonl(INADDR_ANY);
        address.sin_port = htons(port);
        if (::bind(socket_, reinterpret_cast<const sockaddr*>(&address), sizeof(address)) != 0)
            throw std::runtime_error("UDP bind failed");
#ifdef _WIN32
        const DWORD timeout = 1;
        setsockopt(socket_, SOL_SOCKET, SO_RCVTIMEO, reinterpret_cast<const char*>(&timeout),
                   sizeof(timeout));
#else
        const timeval timeout{0, 1'000};
        setsockopt(socket_, SOL_SOCKET, SO_RCVTIMEO, &timeout, sizeof(timeout));
#endif
    }

    ~RelaySocket() {
        if (socket_ != InvalidSocket)
            closeSocket(socket_);
#ifdef _WIN32
        WSACleanup();
#endif
    }

    std::size_t receive(std::span<std::byte> bytes, RelayEndpoint& endpoint) noexcept {
        sockaddr_in source{};
#ifdef _WIN32
        int sourceBytes = sizeof(source);
        const auto count = recvfrom(socket_, reinterpret_cast<char*>(bytes.data()),
                                    static_cast<int>(bytes.size()), 0,
                                    reinterpret_cast<sockaddr*>(&source), &sourceBytes);
#else
        socklen_t sourceBytes = sizeof(source);
        const auto count = recvfrom(socket_, bytes.data(), bytes.size(), 0,
                                    reinterpret_cast<sockaddr*>(&source), &sourceBytes);
#endif
        if (count <= 0)
            return 0;
        std::array<char, INET_ADDRSTRLEN> host{};
        if (inet_ntop(AF_INET, &source.sin_addr, host.data(), host.size()) == nullptr)
            return 0;
        endpoint = {host.data(), ntohs(source.sin_port)};
        return static_cast<std::size_t>(count);
    }

    void send(const RelayDatagram& datagram) noexcept {
        sockaddr_in target{};
        target.sin_family = AF_INET;
        target.sin_port = htons(datagram.target.port);
        if (inet_pton(AF_INET, datagram.target.host.c_str(), &target.sin_addr) != 1)
            return;
#ifdef _WIN32
        (void)sendto(socket_, reinterpret_cast<const char*>(datagram.bytes.data()),
                     static_cast<int>(datagram.bytes.size()), 0,
                     reinterpret_cast<const sockaddr*>(&target), sizeof(target));
#else
        (void)sendto(socket_, datagram.bytes.data(), datagram.bytes.size(), 0,
                     reinterpret_cast<const sockaddr*>(&target), sizeof(target));
#endif
    }

  private:
    NativeSocket socket_{InvalidSocket};
};

std::vector<std::string> fields(std::string_view line) {
    std::vector<std::string> result;
    std::size_t begin = 0;
    while (begin <= line.size()) {
        const auto end = line.find('\t', begin);
        result.emplace_back(line.substr(begin, end == std::string_view::npos ? line.size() - begin
                                                                            : end - begin));
        if (end == std::string_view::npos)
            break;
        begin = end + 1U;
    }
    return result;
}

template <typename Value>
bool number(std::string_view text, Value& value) {
    const auto [end, error] = std::from_chars(text.data(), text.data() + text.size(), value);
    return error == std::errc{} && end == text.data() + text.size();
}

bool applyControl(NativeVoiceRelay& relay, std::string_view line) {
    const auto values = fields(line);
    if (values.empty())
        return true;
    if (values[0] == "EXPECT" && values.size() == 4) {
        std::uint64_t token = 0;
        if (!number(values[3], token))
            return false;
        relay.expect(values[1], values[2], token);
        return true;
    }
    if (values[0] == "FORGET" && values.size() == 2) {
        relay.forget(values[1]);
        return true;
    }
    if (values[0] == "ELIGIBLE" && values.size() >= 2) {
        std::vector<std::string_view> participants;
        participants.reserve(values.size() - 2U);
        for (std::size_t index = 2; index < values.size(); ++index)
            participants.push_back(values[index]);
        relay.setEligibleParticipants(values[1], participants);
        return true;
    }
    if (values[0] == "DEADLINE" && values.size() == 3) {
        double milliseconds = 0.0;
        std::istringstream input(values[2]);
        if (!(input >> milliseconds))
            return false;
        relay.setRoomPlayoutDelay(values[1], milliseconds);
        return true;
    }
    if (values[0] == "GENERATION" && values.size() == 3) {
        std::uint32_t generation = 0;
        if (!number(values[2], generation))
            return false;
        relay.setGeneration(values[1], generation);
        return true;
    }
    if (values[0] == "GAIN" && values.size() == 5) {
        float gain = 0.0F;
        std::istringstream input(values[4]);
        if (!(input >> gain))
            return false;
        relay.setRecipientSourceGain(values[1], values[2], values[3], gain);
        return true;
    }
    return values[0] == "PING";
}

std::optional<std::string> environment(std::string_view name) {
#ifdef _WIN32
    char* value = nullptr;
    std::size_t length = 0;
    if (_dupenv_s(&value, &length, std::string(name).c_str()) != 0 || value == nullptr)
        return std::nullopt;
    std::string result(value);
    std::free(value);
    return result;
#else
    const auto* value = std::getenv(std::string(name).c_str());
    return value == nullptr ? std::nullopt : std::optional<std::string>{value};
#endif
}
} // namespace

int main(int argc, char** argv) {
    try {
        std::uint16_t port = 40'000;
        if (argc == 3 && std::string_view(argv[1]) == "--port") {
            unsigned parsed = 0;
            if (!number(std::string_view(argv[2]), parsed) || parsed == 0 || parsed > 65'535)
                throw std::runtime_error("Invalid relay port");
            port = static_cast<std::uint16_t>(parsed);
        } else if (argc != 1) {
            throw std::runtime_error("Usage: NativeVoiceRelay [--port PORT]");
        }

        auto collectionWindowMilliseconds = 8.0;
        if (const auto configured = environment("AD_VOICE_RELAY_COLLECTION_WINDOW_MS")) {
            std::istringstream input(*configured);
            if (!(input >> collectionWindowMilliseconds) || collectionWindowMilliseconds < 0.0)
                throw std::runtime_error("Invalid AD_VOICE_RELAY_COLLECTION_WINDOW_MS");
        }
        NativeVoiceRelay relay(collectionWindowMilliseconds);
        RelaySocket socket(port);
        std::mutex relayMutex;
        std::atomic running{true};
        std::atomic realtimeScheduling{false};
        std::latch schedulingReady{1};
        std::jthread voice([&] {
#ifdef _WIN32
            DWORD taskIndex = 0;
            const auto realtimeTask = AvSetMmThreadCharacteristicsW(L"Pro Audio", &taskIndex);
            realtimeScheduling.store(realtimeTask != nullptr, std::memory_order_release);
#else
            sched_param scheduling{};
            scheduling.sched_priority = 20;
            realtimeScheduling.store(
                pthread_setschedparam(pthread_self(), SCHED_RR, &scheduling) == 0,
                std::memory_order_release);
#endif
            schedulingReady.count_down();
            std::array<std::byte, MaximumDatagramBytes> buffer{};
            while (running.load(std::memory_order_relaxed)) {
                RelayEndpoint source;
                const auto count = socket.receive(buffer, source);
                std::vector<RelayDatagram> output;
                {
                    std::scoped_lock lock(relayMutex);
                    output = count == 0
                                 ? relay.flush(monotonicSeconds(), wallSeconds())
                                 : relay.receive(std::span(buffer).first(count), std::move(source),
                                                 monotonicSeconds(), wallSeconds());
                }
                for (const auto& datagram : output)
                    socket.send(datagram);
            }
#ifdef _WIN32
            if (realtimeTask != nullptr)
                AvRevertMmThreadCharacteristics(realtimeTask);
#endif
        });
        schedulingReady.wait();
        std::cout << "READY\t" << port << '\n' << std::flush;
        std::string line;
        while (std::getline(std::cin, line)) {
            if (line == "STOP")
                break;
            const auto values = fields(line);
            if (values.size() == 1 && values[0] == "SCHEDULING") {
                std::cout << (realtimeScheduling.load(std::memory_order_acquire)
                                  ? "REALTIME\n" : "NORMAL\n")
                          << std::flush;
                continue;
            }
            if (values.size() == 3 && values[0] == "METRICS") {
                RelayRecipientMetrics metrics;
                {
                    std::scoped_lock lock(relayMutex);
                    metrics = relay.recipientMetrics(values[1], values[2]);
                }
                std::cout << std::setprecision(12)
                          << "{\"packets\":" << metrics.packets
                          << ",\"latest_gap_ms\":" << metrics.latestGapMs
                          << ",\"maximum_gap_ms\":" << metrics.maximumGapMs
                          << ",\"stalls\":" << metrics.stalls
                          << ",\"last_send_monotonic_ms\":"
                          << metrics.lastSendMonotonicMs
                          << ",\"pipeline_position\":" << metrics.pipelinePosition
                          << ",\"pipeline_generation\":" << metrics.pipelineGeneration
                          << ",\"complete_positions\":" << metrics.completePositions
                          << ",\"partial_positions\":" << metrics.partialPositions
                          << ",\"missing_contributions\":" << metrics.missingContributions
                          << ",\"ingress_nonzero_packets\":" << metrics.ingressNonzeroPackets
                          << ",\"ingress_peak\":" << metrics.ingressPeak
                          << ",\"recipient_nonzero_packets\":"
                          << metrics.recipientNonzeroPackets
                          << ",\"recipient_peak\":" << metrics.recipientPeak
                          << "}\n" << std::flush;
                continue;
            }
            if (values.size() == 2 && values[0] == "LEVELS") {
                std::map<std::string, float> levels;
                {
                    std::scoped_lock lock(relayMutex);
                    levels = relay.participantLevels(values[1], monotonicSeconds());
                }
                std::cout << '{';
                auto separator = "";
                for (const auto& [participant, level] : levels) {
                    std::cout << separator << std::quoted(participant) << ':' << level;
                    separator = ",";
                }
                std::cout << "}\n" << std::flush;
                continue;
            }
            bool accepted = false;
            {
                std::scoped_lock lock(relayMutex);
                accepted = applyControl(relay, line);
            }
            std::cout << (accepted ? "OK" : "ERROR") << '\n' << std::flush;
        }
        running.store(false, std::memory_order_relaxed);
        voice.join();
        return 0;
    } catch (const std::exception& error) {
        std::cerr << error.what() << '\n';
        return 1;
    }
}
