#pragma once
#include "media/IAudioDecoder.hpp"
#include <memory>
std::unique_ptr<IAudioDecoder> createDefaultAudioDecoder();
std::unique_ptr<IAudioDecoder> createFlacDecoder();
std::unique_ptr<IAudioDecoder> createMp3Decoder();
// Only local compressed files use bundled decoders; URLs keep the streaming platform decoder.
std::unique_ptr<IAudioDecoder> createLocalCompressedDecoder(const std::string& pathOrUrl);
