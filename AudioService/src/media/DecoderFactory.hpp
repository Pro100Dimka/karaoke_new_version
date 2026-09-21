#pragma once
#include "media/IAudioDecoder.hpp"
#include <memory>
std::unique_ptr<IAudioDecoder> createDefaultAudioDecoder();
