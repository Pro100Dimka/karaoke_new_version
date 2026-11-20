#include "TestHarness.hpp"
#include "media/DecoderFactory.hpp"
#include "media/MediaSource.hpp"
#include "media/RateTransposeProcessor.hpp"

#include <algorithm>
#include <array>
#include <chrono>
#include <fstream>

namespace {
constexpr std::uint32_t Channels = 2;
constexpr std::uint32_t BlockFrames = 1024;

std::filesystem::path mp3Fixture(std::uint32_t rate) {
    return std::filesystem::path{__FILE__}.parent_path() / "fixtures" /
           ("seek-" + std::to_string(rate) + ".mp3");
}

std::vector<float> decodeAll(IAudioDecoder& decoder) {
    std::vector<float> result;
    std::array<float, BlockFrames * Channels> block{};
    while (const auto frames = decoder.read(block, BlockFrames)) {
        Tests::require(frames <= BlockFrames, "MP3 reads stay inside the supplied buffer");
        result.insert(result.end(), block.begin(), block.begin() + frames * Channels);
    }
    return result;
}

bool closeSamples(std::span<const float> first, std::span<const float> second, float tolerance) {
    return first.size() == second.size() &&
           std::equal(first.begin(), first.end(), second.begin(), [=](float a, float b) {
               return std::isfinite(a) && std::isfinite(b) && std::abs(a - b) <= tolerance;
           });
}
} // namespace

namespace Tests {
void mp3DecoderPreservesGaplessFramesAndIndependentPcm() {
    for (const auto rate : {44100U, 48000U}) {
        auto decoder = createDefaultAudioDecoder();
        const auto path = mp3Fixture(rate);
        const auto format = decoder->open(path.string());
        require(format.sampleRateHz == rate && format.channels == Channels &&
                    format.totalFrames == rate * 2U,
                "MP3 metadata excludes encoder delay and final padding");
        const auto decoded = decodeAll(*decoder);
        require(decoded.size() == format.totalFrames * Channels,
                "MP3 decoding returns exactly the original source duration");
        auto referencePath = path;
        referencePath.replace_extension(".reference.f32");
        std::ifstream reference(referencePath, std::ios::binary);
        std::array<float, 64 * Channels> expected{};
        for (const auto frame : {0U, 1U, 529U, 1152U, rate + 17U, rate * 2U - 64U}) {
            reference.read(reinterpret_cast<char*>(expected.data()), sizeof(expected));
            require(static_cast<bool>(reference), "independent MP3 PCM fixture is complete");
            expect(closeSamples(std::span{decoded}.subspan(frame * Channels, expected.size()),
                                expected, 0.00002F),
                   "MP3 first, middle and last samples align with FFmpeg's gapless decode");
        }
    }
}

void mp3DecoderSeeksMatchSequentialPcm() {
    for (const auto rate : {44100U, 48000U}) {
        auto decoder = createDefaultAudioDecoder();
        const auto format = decoder->open(mp3Fixture(rate).string());
        const auto decoded = decodeAll(*decoder);
        std::array<float, BlockFrames * Channels> output{};
        const std::array<std::uint64_t, 13> positions{
            rate + 17U, 1U, 529U, 1151U, 1152U, 1153U, rate - 1U,
            format.totalFrames - 1025U, format.totalFrames - 29U, format.totalFrames - 1U,
            format.totalFrames, 0U, rate + 137U,
        };
        for (const auto frame : positions) {
            decoder->seek(frame);
            const auto wanted = static_cast<std::uint32_t>(
                std::min<std::uint64_t>(BlockFrames, format.totalFrames - frame));
            const auto read = decoder->read(output, BlockFrames);
            require(read == wanted, "MP3 seek preserves the exact frame count including EOF");
            expect(closeSamples(std::span{output}.first(read * Channels),
                                std::span{decoded}.subspan(frame * Channels, read * Channels), 0.0F),
                   "MP3 indexed seeks return the identical decoded samples at the requested frame");
        }
        decoder->seek(0);
        output.fill(-99.0F);
        expect(decoder->read(std::span{output}.first(6), BlockFrames) == 3 && output[6] == -99.0F,
               "MP3 read honors a smaller output span without overwriting its end");
    }
}

void mp3DecoderSupportsUnicodeCancelCloseAndReopen() {
    for (const auto url : {"https://example.test/radio.mp3", "http://example.test/live.flac"})
        expect(!createLocalCompressedDecoder(url), "network streams keep the platform decoder");
    const auto path = tempRoot / std::filesystem::path{u8"Небо в огне.MP3"};
    std::filesystem::copy_file(mp3Fixture(44100), path);
    const auto utf8 = path.u8string();
    const std::string name{utf8.begin(), utf8.end()};
    auto decoder = createDefaultAudioDecoder();
    decoder->open(name);
    struct Step {
        void (*action)(IAudioDecoder&, const std::string&);
        std::uint32_t frames;
        const char* message;
    };
    const std::array steps{
        Step{[](IAudioDecoder& audio, const std::string&) { audio.cancel(); }, 0,
             "cancel stops local MP3 reads"},
        Step{[](IAudioDecoder& audio, const std::string&) { audio.seek(0); }, 16,
             "seeking resumes a cancelled MP3 at the requested frame"},
        Step{[](IAudioDecoder& audio, const std::string&) { audio.close(); }, 0,
             "a closed MP3 has no stale PCM"},
        Step{[](IAudioDecoder& audio, const std::string& file) { audio.open(file); }, 16,
             "a closed decoder reopens a Unicode MP3 without inheriting cancellation"},
    };
    std::array<float, 32> output{};
    for (const auto& step : steps) {
        step.action(*decoder, name);
        expect(decoder->read(output, 16) == step.frames, step.message);
    }
}

void mp3DecoderRejectsInvalidAndTruncatedInputs() {
    const auto truncated = tempRoot / "truncated.mp3";
    std::filesystem::copy_file(mp3Fixture(44100), truncated);
    std::filesystem::resize_file(truncated, std::filesystem::file_size(truncated) / 2);
    const auto invalid = tempRoot / "invalid.mp3";
    std::ofstream(invalid, std::ios::binary) << "this is not MP3 audio";
    for (const auto& path : {invalid, truncated}) {
        auto decoder = createDefaultAudioDecoder();
        bool rejected = false;
        try {
            decoder->open(path.string());
            (void)decodeAll(*decoder);
        } catch (const std::runtime_error&) {
            rejected = true;
        }
        expect(rejected, "invalid or truncated MP3 must fail instead of ending a song early");
        decoder->close();
        expect(decoder->open(mp3Fixture(48000).string()).totalFrames == 96000,
               "a rejected MP3 does not poison the next valid load");
    }
}

void mp3MediaSourceAppliesRateAndPitchAfterAccurateSeek() {
    const auto path = mp3Fixture(44100);
    auto decoder = createDefaultAudioDecoder();
    const auto format = decoder->open(path.string());
    const auto decoded = decodeAll(*decoder);
    constexpr std::uint32_t OutputRate = 48000;
    constexpr std::uint32_t SeekFrame = 12345;
    constexpr std::uint32_t RenderFrames = 4096;
    for (const auto rate : {0.5F, 1.0F, 1.5F}) {
        for (const auto pitch : {-12.0F, 0.0F, 12.0F}) {
            MediaSource source{createDefaultAudioDecoder()};
            source.prepareOutput(OutputRate, Channels, 32768);
            source.setRate(rate);
            source.setTranspose(pitch);
            source.load(path.string());
            require(source.waitUntilReady() == PlaybackState::Ready, "MP3 source preloads for karaoke");
            source.seek(SeekFrame);
            require(source.waitUntilReady() == PlaybackState::Ready, "MP3 source preloads after seek");
            const auto deadline = std::chrono::steady_clock::now() + std::chrono::seconds(3);
            while (source.snapshot().bufferFillFrames < RenderFrames &&
                   std::chrono::steady_clock::now() < deadline)
                std::this_thread::yield();
            require(source.snapshot().bufferFillFrames >= RenderFrames,
                    "MP3 worker fills the requested test block before realtime rendering");
            source.play();
            std::array<float, RenderFrames * Channels> actual{};
            require(source.render(actual, RenderFrames) == RenderFrames,
                    "MP3 karaoke renders the complete requested block at every supported transform");

            RateTransposeProcessor processor;
            processor.prepare(format.sampleRateHz, OutputRate, Channels, 8192);
            processor.setRate(rate);
            processor.setTranspose(pitch);
            std::vector<float> expected(processor.maximumOutputFrames() * Channels);
            const auto count = processor.process(
                std::span{decoded}.subspan(SeekFrame * Channels, 8192 * Channels), 8192, expected);
            require(count >= RenderFrames, "reference processor produces enough transformed PCM");
            expect(closeSamples(actual, std::span{expected}.first(actual.size()), 0.000001F),
                   "tempo and key changes use the same exact post-seek samples as uncompressed PCM");
            source.unload();
        }
    }
}
} // namespace Tests
