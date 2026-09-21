#include "media/DecoderFactory.hpp"
#ifdef _WIN32
#include "media/MediaFoundationDecoder.hpp"
#else
#include "media/WavDecoder.hpp"
#endif
std::unique_ptr<IAudioDecoder> createDefaultAudioDecoder() {
#ifdef _WIN32
    return std::make_unique<MediaFoundationDecoder>();
#else
    return std::make_unique<WavDecoder>();
#endif
}
