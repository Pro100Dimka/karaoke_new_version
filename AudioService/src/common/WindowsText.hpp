#pragma once
#ifdef _WIN32

#ifndef WIN32_LEAN_AND_MEAN
#define WIN32_LEAN_AND_MEAN
#endif
#ifndef NOMINMAX
#define NOMINMAX
#endif
#include <windows.h>

#include <stdexcept>
#include <string>

/** UTF-8 text (device ids, file paths) as the UTF-16 Windows APIs take it. */
inline std::wstring widen(const std::string& text) {
    if (text.empty())
        return {};
    const auto count = MultiByteToWideChar(CP_UTF8, 0, text.c_str(), -1, nullptr, 0);
    if (count <= 0)
        throw std::runtime_error("UTF-8 text conversion failed");
    std::wstring out(static_cast<std::size_t>(count), L'\0');
    MultiByteToWideChar(CP_UTF8, 0, text.c_str(), -1, out.data(), count);
    out.resize(static_cast<std::size_t>(count - 1));
    return out;
}

/** UTF-16 text from Windows APIs (e.g. an endpoint id) as UTF-8. */
inline std::string narrowText(const wchar_t* text) {
    if (text == nullptr || *text == L'\0')
        return {};
    const auto count = WideCharToMultiByte(CP_UTF8, 0, text, -1, nullptr, 0, nullptr, nullptr);
    if (count <= 0)
        return {};
    std::string out(static_cast<std::size_t>(count), '\0');
    WideCharToMultiByte(CP_UTF8, 0, text, -1, out.data(), count, nullptr, nullptr);
    out.resize(static_cast<std::size_t>(count - 1));
    return out;
}

#endif
