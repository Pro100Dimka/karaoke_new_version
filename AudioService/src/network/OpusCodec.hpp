#pragma once

#include <cstddef>
#include <cstdint>
#include <memory>
#include <span>
#include <vector>

struct OpusEncoder;
struct OpusDecoder;

// Encodes the one local outbound voice stream with Opus (VoIP-tuned, in-band FEC enabled so a
// receiver can often reconstruct one lost frame from data carried in the next packet). One instance
// per NetworkAudioEngine: there is only ever one local participant.
class OpusVoiceEncoder {
  public:
    OpusVoiceEncoder(std::uint32_t sampleRateHz, std::uint32_t channels);
    ~OpusVoiceEncoder();
    OpusVoiceEncoder(const OpusVoiceEncoder&) = delete;
    OpusVoiceEncoder& operator=(const OpusVoiceEncoder&) = delete;

    // frames is samples-per-channel and must be a valid Opus frame duration for sampleRateHz
    // (2.5/5/10/20/40/60 ms). Returns an empty vector if libopus rejects the input.
    [[nodiscard]] std::vector<std::byte> encode(std::span<const float> samples,
                                                std::uint32_t frames) noexcept;

  private:
    struct Deleter {
        void operator()(OpusEncoder* value) const noexcept;
    };
    std::unique_ptr<OpusEncoder, Deleter> encoder_;
    std::uint32_t channels_;
};

// Decodes one remote participant's inbound voice stream. Opus decoders carry state across frames to
// conceal loss plausibly, so every participant must own its own instance -- sharing one across
// participants would corrupt everyone's audio.
class OpusVoiceDecoder {
  public:
    OpusVoiceDecoder(std::uint32_t sampleRateHz, std::uint32_t channels);
    ~OpusVoiceDecoder();
    OpusVoiceDecoder(const OpusVoiceDecoder&) = delete;
    OpusVoiceDecoder& operator=(const OpusVoiceDecoder&) = delete;

    // Decodes a received packet. Returns an empty vector if libopus rejects the payload.
    [[nodiscard]] std::vector<float> decode(std::span<const std::byte> payload,
                                            std::uint32_t frames) noexcept;
    // Asks the decoder to synthesize a plausible continuation for a frame that was never received,
    // using Opus's built-in packet-loss concealment instead of silence.
    [[nodiscard]] std::vector<float> conceal(std::uint32_t frames) noexcept;

  private:
    struct Deleter {
        void operator()(OpusDecoder* value) const noexcept;
    };
    std::unique_ptr<OpusDecoder, Deleter> decoder_;
    std::uint32_t channels_;
};
