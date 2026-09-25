#pragma once
#include <cstdlib>
#include <memory>
#include <string>

inline std::string controlEndpoint() {
#ifdef _WIN32
    char* raw = nullptr;
    std::size_t length = 0;
    const auto status = _dupenv_s(&raw, &length, "AD_VOICE_AUDIO_ENDPOINT");
    const std::unique_ptr<char, decltype(&std::free)> value{raw, std::free};
    return status == 0 && value && *value ? std::string{value.get()}
                                          : R"(\\.\pipe\ADVoice.AudioService.v1)";
#else
    const auto* value = std::getenv("AD_VOICE_AUDIO_ENDPOINT");
    return value && *value ? value : "/tmp/advoice-audioservice.sock";
#endif
}
