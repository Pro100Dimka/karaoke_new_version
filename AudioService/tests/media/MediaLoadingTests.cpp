#include "TestHarness.hpp"
#include "media/MediaSource.hpp"

#include <algorithm>
#include <array>
#include <chrono>
#include <future>
#include <memory>
#include <semaphore>

namespace {
constexpr auto CompletionTimeout = std::chrono::seconds(2);
constexpr auto CommandTimeout = std::chrono::milliseconds(500);
constexpr std::uint32_t Rate = 48'000;

struct TransportChange {
    const char* name;
    void (*apply)(MediaSource&);
    std::uint64_t position{0};
};
constexpr std::array TransportChanges{
    TransportChange{"stop", [](MediaSource& source) { source.stop(); }},
    TransportChange{"seek", [](MediaSource& source) { source.seek(1024); }, 1024},
    TransportChange{"rate", [](MediaSource& source) { source.setRate(0.75F); }},
    TransportChange{"transpose", [](MediaSource& source) { source.setTranspose(2.0F); }},
};

struct DelayedDecode {
    bool open{true};
    bool fail{false};
    std::binary_semaphore entered{0}, proceed{0};
    std::vector<std::string> opened{};
    bool active{false};
};

class DelayedDecoder final : public IAudioDecoder {
  public:
    explicit DelayedDecoder(DelayedDecode& operation) : operation_(operation) {}
    DecodedAudioFormat open(const std::string& path) override {
        path_ = path;
        position_ = 0;
        operation_.opened.push_back(path);
        operation_.active = true;
        if (path == "old" && operation_.open)
            delayOnce();
        return {Rate, 1, path == "new" ? 8192U : 4096U};
    }
    std::uint32_t read(std::span<float> output, std::uint32_t maxFrames) override {
        if (path_ == "old" && !operation_.open)
            delayOnce();
        const auto total = path_ == "new" ? 8192U : 4096U;
        const auto frames = std::min({maxFrames, total - position_,
                                      static_cast<std::uint32_t>(output.size())});
        std::fill_n(output.data(), frames, path_ == "new" ? 0.75F : 0.25F);
        position_ += frames;
        return frames;
    }
    void seek(std::uint64_t frame) override { position_ = static_cast<std::uint32_t>(frame); }
    void cancel() noexcept override {} // Represents an open/read the platform cannot interrupt.
    void close() noexcept override { operation_.active = false; }

  private:
    void delayOnce() {
        if (delayed_)
            return;
        delayed_ = true;
        operation_.entered.release();
        if (!operation_.proceed.try_acquire_for(CompletionTimeout))
            throw std::runtime_error("test decoder was not released");
        if (operation_.fail)
            throw std::runtime_error("superseded decoder failed");
    }
    DelayedDecode& operation_;
    std::string path_;
    std::uint32_t position_{0};
    bool delayed_{false};
};

bool awaitReady(MediaSource& source) {
    auto ready = std::async(std::launch::async, [&] { return source.waitUntilReady(); });
    const auto completed = ready.wait_for(CompletionTimeout) == std::future_status::ready;
    if (!completed)
        source.unload();
    return ready.get() == PlaybackState::Ready && completed;
}
} // namespace

namespace Tests {
void transportChangesDuringMediaOpenStillPrepareTheDecoder() {
    for (const auto& change : TransportChanges) {
        DelayedDecode operation;
        MediaSource source{std::make_unique<DelayedDecoder>(operation)};
        source.prepareOutput(Rate, 1, 4096);
        source.load("old");
        require(operation.entered.try_acquire_for(CompletionTimeout), change.name);
        change.apply(source);
        expect(source.snapshot().state == PlaybackState::Loading,
               "transport changes cannot mark an unopened decoder ready");
        operation.proceed.release();
        require(awaitReady(source), std::string(change.name) + ": source finishes opening");
        const auto loaded = source.snapshot();
        expect(loaded.totalSourceFrames == 4096 && loaded.bufferFillFrames > 0 &&
                   loaded.sourcePositionFrames == change.position,
               std::string(change.name) + ": format and decoded PCM retain the latest transport");
        source.play();
        std::array<float, 128> output{};
        expect(source.render(output, 128) == 128,
               std::string(change.name) + ": prepared media supplies the first playback block");
    }
}

void transportChangesDuringFailedMediaOpenRetainTheFailure() {
    for (const auto& change : TransportChanges) {
        DelayedDecode operation{.fail = true};
        MediaSource source{std::make_unique<DelayedDecoder>(operation)};
        source.prepareOutput(Rate, 1, 4096);
        source.load("old");
        require(operation.entered.try_acquire_for(CompletionTimeout), change.name);
        change.apply(source);
        operation.proceed.release();
        auto waiting = std::async(std::launch::async, [&] { return source.waitUntilReady(); });
        const auto completed = waiting.wait_for(CompletionTimeout) == std::future_status::ready;
        if (!completed)
            source.unload();
        expect(waiting.get() == PlaybackState::Failed && completed,
               std::string(change.name) + ": a failed current source cannot stay Loading forever");
        if (completed)
            expect(source.snapshot().failureCode == MediaFailureCode::DecoderError,
                   "transport changes preserve the current load's decoder error");
        source.load("new");
        require(awaitReady(source), "a valid replacement recovers after the failed open");
    }
}

void transportChangesDuringFailedLoudnessScanStillSeekTheSource() {
    for (const auto& change : TransportChanges) {
        DelayedDecode operation{.open = false, .fail = true};
        MediaSource source{std::make_unique<DelayedDecoder>(operation), true};
        source.prepareOutput(Rate, 1, 4096);
        source.load("old");
        require(operation.entered.try_acquire_for(CompletionTimeout), change.name);
        change.apply(source);
        operation.proceed.release();
        const auto ready = awaitReady(source);
        expect(ready, std::string(change.name) + ": a retired scan error cannot cancel the pending seek");
        if (!ready)
            continue;
        const auto loaded = source.snapshot();
        expect(loaded.failureCode == MediaFailureCode::None && loaded.bufferFillFrames > 0 &&
                   loaded.sourcePositionFrames == change.position,
               "transport replaces the retired scan while retaining the prepared decoder and format");
    }
}

void queuedMediaLoadKeepsTransportChanges() {
    DelayedDecode operation;
    MediaSource source{std::make_unique<DelayedDecoder>(operation)};
    source.prepareOutput(Rate, 1, 4096);
    source.load("old");
    require(operation.entered.try_acquire_for(CompletionTimeout), "old decoder starts opening");
    auto replacement = std::async(std::launch::async, [&] { source.load("new"); });
    const auto accepted = replacement.wait_for(CommandTimeout) == std::future_status::ready;
    if (!accepted)
        operation.proceed.release();
    replacement.get();
    source.seek(1024);
    if (accepted)
        operation.proceed.release();
    require(awaitReady(source), "queued media loads after its transport request");
    const auto loaded = source.snapshot();
    expect(loaded.totalSourceFrames == 8192 && loaded.sourcePositionFrames == 1024 &&
               loaded.bufferFillFrames > 0,
           "a seek accepted before open retains both the pending path and its source position");
}

void replacementMediaLoadDoesNotWaitForPreviousDecoder() {
    struct Scenario {
        const char* name;
        bool open{true}, fail{false};
    };
    constexpr std::array scenarios{
        Scenario{"blocked open"},
        Scenario{"failed old open", true, true},
        Scenario{"blocked read", false},
    };
    for (const auto& scenario : scenarios) {
        DelayedDecode operation{.open = scenario.open, .fail = scenario.fail};
        MediaSource source{std::make_unique<DelayedDecoder>(operation)};
        source.prepareOutput(Rate, 1, 4096);
        source.load("old");
        require(operation.entered.try_acquire_for(CompletionTimeout), scenario.name);

        auto replacement = std::async(std::launch::async, [&] {
            source.load("middle");
            source.load("new");
        });
        const auto accepted = replacement.wait_for(CommandTimeout) == std::future_status::ready;
        expect(accepted, std::string(scenario.name) + ": replacement load leaves control responsive");
        if (accepted) {
            const auto pending = source.snapshot();
            expect(pending.state == PlaybackState::Loading && pending.bufferFillFrames == 0 &&
                       pending.totalSourceFrames == 0 && pending.loadProgressFrames == 0,
                   "a pending replacement exposes neither stale PCM nor the previous format");
            std::array<float, 128> output;
            output.fill(1.0F);
            expect(source.render(output, 128) == 0 &&
                       std::ranges::all_of(output, [](float sample) { return sample == 0.0F; }),
                   "a replacement cannot render before its decoder is ready");
        }
        operation.proceed.release();
        replacement.get();
        require(awaitReady(source), "the latest replacement becomes ready after old I/O returns");
        expect(source.snapshot().totalSourceFrames == 8192,
               "the latest decoder owns the published format");
        source.play();
        std::array<float, 128> output{};
        expect(source.render(output, 128) == 128 &&
                   std::ranges::all_of(output, [](float sample) { return sample == 0.75F; }),
               "superseded success, failure and PCM cannot contaminate replacement playback");
        source.unload();
        if (accepted)
            expect(operation.opened == std::vector<std::string>{"old", "new"},
                   "pending replacement loads coalesce to the latest path");
        expect(!operation.active, "unload releases the last decoder before returning");
    }
}

void mediaReconfigurationStillWaitsForDecoderQuiescence() {
    DelayedDecode operation;
    MediaSource source{std::make_unique<DelayedDecoder>(operation)};
    source.prepareOutput(Rate, 1, 4096);
    source.load("old");
    require(operation.entered.try_acquire_for(CompletionTimeout), "old decoder starts opening");
    auto reconfigure = std::async(std::launch::async, [&] {
        source.prepareOutput(44'100, 2, 4096);
    });
    expect(reconfigure.wait_for(std::chrono::milliseconds(100)) == std::future_status::timeout,
           "output storage cannot change while the old decoder owns it");
    operation.proceed.release();
    require(reconfigure.wait_for(CompletionTimeout) == std::future_status::ready,
            "reconfiguration completes after the decoder returns");
    reconfigure.get();
    expect(source.snapshot().state == PlaybackState::Ready,
           "reconfiguration restores the loaded source under the new format");
    source.play();
    std::array<float, 256> output{};
    expect(source.render(output, 128) == 128 &&
               std::ranges::all_of(output, [](float sample) { return sample == 0.25F; }),
           "the reconfigured stereo source contains only the reopened decoder's PCM");
}

void unloadingMediaStillDrainsTheDecoder() {
    DelayedDecode operation;
    MediaSource source{std::make_unique<DelayedDecoder>(operation)};
    source.prepareOutput(Rate, 1, 4096);
    source.load("old");
    require(operation.entered.try_acquire_for(CompletionTimeout), "old decoder starts opening");
    auto unloading = std::async(std::launch::async, [&] { source.unload(); });
    expect(unloading.wait_for(std::chrono::milliseconds(100)) == std::future_status::timeout,
           "explicit unload retains its decoder quiescence contract");
    operation.proceed.release();
    require(unloading.wait_for(CompletionTimeout) == std::future_status::ready,
            "unload completes after the decoder returns");
    unloading.get();
    expect(!operation.active && source.snapshot().state == PlaybackState::Empty,
           "unload returns only after releasing the old decoder and clearing playback");
}
} // namespace Tests
