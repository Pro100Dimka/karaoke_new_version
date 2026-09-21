#pragma once
#include <array>
#include <cstddef>
#include <string_view>

enum class SessionState {
    Idle,
    Opening,
    Prepared,
    Starting,
    Running,
    Stopping,
    Recovering,
    Suspended,
    Failed,
    Count
};
inline std::string_view sessionStateName(SessionState state) noexcept {
    constexpr std::array names{
        std::string_view{"Idle"},       std::string_view{"Opening"},   std::string_view{"Prepared"},
        std::string_view{"Starting"},   std::string_view{"Running"},   std::string_view{"Stopping"},
        std::string_view{"Recovering"}, std::string_view{"Suspended"}, std::string_view{"Failed"}};
    static_assert(names.size() == static_cast<std::size_t>(SessionState::Count));
    const auto index = static_cast<std::size_t>(state);
    return index < names.size() ? names[index] : std::string_view{"Unknown"};
}
