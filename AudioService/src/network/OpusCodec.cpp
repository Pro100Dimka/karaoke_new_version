#include "network/OpusCodec.hpp"

#include <opus.h>

#include <stdexcept>

namespace {
// The largest a single Opus frame can ever encode to, per the library's own documentation --
// used to size the one-shot scratch buffer for encode().
constexpr int MaxEncodedFrameBytes = 1276;
// Constant bitrate keeps packet sizes predictable for the fixed-size real-time UDP path, and is
// generous enough for clear speech at the project's 5 ms packetization interval.
constexpr opus_int32 VoiceBitrateBps = 32000;
// Told to the encoder so its in-band FEC sizes its redundancy for a plausibly lossy connection
// without doubling bandwidth outright; this is a starting point, not a measured value.
constexpr opus_int32 AssumedPacketLossPercent = 10;

[[nodiscard]] int throwingChannels(std::uint32_t channels) {
    if (channels == 0 || channels > 2)
        throw std::runtime_error("Opus supports only mono or stereo");
    return static_cast<int>(channels);
}
} // namespace

void OpusVoiceEncoder::Deleter::operator()(OpusEncoder* value) const noexcept {
    opus_encoder_destroy(value);
}

OpusVoiceEncoder::OpusVoiceEncoder(std::uint32_t sampleRateHz, std::uint32_t channels)
    : channels_(channels) {
    const auto channelCount = throwingChannels(channels);
    int error = OPUS_OK;
    encoder_.reset(opus_encoder_create(static_cast<opus_int32>(sampleRateHz), channelCount,
                                       OPUS_APPLICATION_VOIP, &error));
    if (error != OPUS_OK || encoder_ == nullptr)
        throw std::runtime_error("Opus encoder creation failed");
    opus_encoder_ctl(encoder_.get(), OPUS_SET_VBR(0));
    opus_encoder_ctl(encoder_.get(), OPUS_SET_BITRATE(VoiceBitrateBps));
    opus_encoder_ctl(encoder_.get(), OPUS_SET_INBAND_FEC(1));
    opus_encoder_ctl(encoder_.get(), OPUS_SET_PACKET_LOSS_PERC(AssumedPacketLossPercent));
}
OpusVoiceEncoder::~OpusVoiceEncoder() = default;

std::vector<std::byte> OpusVoiceEncoder::encode(std::span<const float> samples,
                                                std::uint32_t frames) noexcept {
    if (samples.size() != static_cast<std::size_t>(frames) * channels_)
        return {};
    std::vector<std::byte> bytes(static_cast<std::size_t>(MaxEncodedFrameBytes));
    const auto written =
        opus_encode_float(encoder_.get(), samples.data(), static_cast<int>(frames),
                          reinterpret_cast<unsigned char*>(bytes.data()), MaxEncodedFrameBytes);
    if (written <= 0)
        return {};
    bytes.resize(static_cast<std::size_t>(written));
    return bytes;
}

void OpusVoiceDecoder::Deleter::operator()(OpusDecoder* value) const noexcept {
    opus_decoder_destroy(value);
}

OpusVoiceDecoder::OpusVoiceDecoder(std::uint32_t sampleRateHz, std::uint32_t channels)
    : channels_(channels) {
    const auto channelCount = throwingChannels(channels);
    int error = OPUS_OK;
    decoder_.reset(
        opus_decoder_create(static_cast<opus_int32>(sampleRateHz), channelCount, &error));
    if (error != OPUS_OK || decoder_ == nullptr)
        throw std::runtime_error("Opus decoder creation failed");
}
OpusVoiceDecoder::~OpusVoiceDecoder() = default;

std::vector<float> OpusVoiceDecoder::decode(std::span<const std::byte> payload,
                                            std::uint32_t frames) noexcept {
    if (payload.empty())
        return {};
    std::vector<float> samples(static_cast<std::size_t>(frames) * channels_);
    const auto decoded =
        opus_decode_float(decoder_.get(), reinterpret_cast<const unsigned char*>(payload.data()),
                          static_cast<opus_int32>(payload.size()), samples.data(),
                          static_cast<int>(frames), 0);
    if (decoded <= 0)
        return {};
    samples.resize(static_cast<std::size_t>(decoded) * channels_);
    return samples;
}

std::vector<float> OpusVoiceDecoder::conceal(std::uint32_t frames) noexcept {
    std::vector<float> samples(static_cast<std::size_t>(frames) * channels_);
    const auto decoded = opus_decode_float(decoder_.get(), nullptr, 0, samples.data(),
                                           static_cast<int>(frames), 0);
    if (decoded <= 0)
        return {};
    samples.resize(static_cast<std::size_t>(decoded) * channels_);
    return samples;
}
