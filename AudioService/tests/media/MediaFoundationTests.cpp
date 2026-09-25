#include "TestHarness.hpp"
#ifdef _WIN32
#include "media/MediaFoundationDecoder.hpp"
#include <array>
#include <atomic>
#include <chrono>
#include <cstring>
#include <mfapi.h>
#include <mfidl.h>
#include <mfreadwrite.h>
#include <semaphore>
#include <thread>
#include <wrl/client.h>

struct MediaFoundationTestAccess {
    static void attach(MediaFoundationDecoder& decoder, IMFSourceReader* reader) {
        decoder.reader_ = reader;
        decoder.format_ = {48000, 1, 4};
    }
};

namespace {
enum class ReadMode { Samples, Error, Tick, FinalSample, FormatChange, PartialFrame };
struct Reader final : IMFSourceReader {
    ReadMode mode{ReadMode::Samples};
    unsigned calls{0};
    bool blockFlush{false};
    std::atomic<bool> flushing{false}, releasedDuringFlush{false};
    std::binary_semaphore flushEntered{0}, releaseFlush{0};
    HRESULT STDMETHODCALLTYPE QueryInterface(REFIID, void** out) override {
        *out = nullptr;
        return E_NOINTERFACE;
    }
    ULONG STDMETHODCALLTYPE AddRef() override {
        return 1;
    }
    ULONG STDMETHODCALLTYPE Release() override {
        if (flushing.load())
            releasedDuringFlush.store(true);
        return 1;
    }
    HRESULT STDMETHODCALLTYPE GetStreamSelection(DWORD, BOOL*) override {
        return E_NOTIMPL;
    }
    HRESULT STDMETHODCALLTYPE SetStreamSelection(DWORD, BOOL) override {
        return S_OK;
    }
    HRESULT STDMETHODCALLTYPE GetNativeMediaType(DWORD, DWORD, IMFMediaType**) override {
        return E_NOTIMPL;
    }
    HRESULT STDMETHODCALLTYPE GetCurrentMediaType(DWORD, IMFMediaType**) override {
        return E_NOTIMPL;
    }
    HRESULT STDMETHODCALLTYPE SetCurrentMediaType(DWORD, DWORD*, IMFMediaType*) override {
        return S_OK;
    }
    HRESULT STDMETHODCALLTYPE SetCurrentPosition(REFGUID, REFPROPVARIANT) override {
        return S_OK;
    }
    HRESULT STDMETHODCALLTYPE GetServiceForStream(DWORD, REFGUID, REFIID, void**) override {
        return E_NOTIMPL;
    }
    HRESULT STDMETHODCALLTYPE GetPresentationAttribute(DWORD, REFGUID, PROPVARIANT*) override {
        return E_NOTIMPL;
    }
    HRESULT STDMETHODCALLTYPE Flush(DWORD) override {
        if (blockFlush) {
            flushing.store(true);
            flushEntered.release();
            releaseFlush.acquire();
            flushing.store(false);
        }
        return S_OK;
    }
    HRESULT STDMETHODCALLTYPE ReadSample(DWORD, DWORD, DWORD* stream, DWORD* flags,
                                         LONGLONG* timestamp, IMFSample** sample) override {
        *stream = 0;
        *timestamp = 0;
        *sample = nullptr;
        *flags = 0;
        const auto call = calls++;
        if (mode == ReadMode::Error)
            return E_FAIL;
        if (mode == ReadMode::Tick && call == 0) {
            *flags = MF_SOURCE_READERF_STREAMTICK;
            return S_OK;
        }
        if (mode == ReadMode::FormatChange) {
            *flags = MF_SOURCE_READERF_CURRENTMEDIATYPECHANGED;
            return S_OK;
        }
        if (call > (mode == ReadMode::Tick ? 1U : 0U)) {
            *flags = MF_SOURCE_READERF_ENDOFSTREAM;
            return S_OK;
        }
        if (mode == ReadMode::FinalSample)
            *flags = MF_SOURCE_READERF_ENDOFSTREAM;
        using Microsoft::WRL::ComPtr;
        ComPtr<IMFSample> pcm;
        ComPtr<IMFMediaBuffer> buffer;
        const auto bytes = mode == ReadMode::PartialFrame ? 3U : 4U * sizeof(float);
        if (FAILED(MFCreateSample(&pcm)) ||
            FAILED(MFCreateMemoryBuffer(static_cast<DWORD>(bytes), &buffer)))
            return E_FAIL;
        BYTE* data = nullptr;
        if (FAILED(buffer->Lock(&data, nullptr, nullptr)))
            return E_FAIL;
        const std::array<float, 4> values{0.1F, 0.2F, 0.3F, 0.4F};
        std::memcpy(data, values.data(), bytes);
        buffer->Unlock();
        buffer->SetCurrentLength(static_cast<DWORD>(bytes));
        pcm->AddBuffer(buffer.Get());
        *sample = pcm.Detach();
        return S_OK;
    }
};
} // namespace
#endif

namespace Tests {
void mediaFoundationDistinguishesErrorsTicksAndEof() {
#ifdef _WIN32
    const auto initialized = CoInitializeEx(nullptr, COINIT_MULTITHREADED);
    MFStartup(MF_VERSION);
    struct Scenario {
        ReadMode mode;
        bool fails;
        const char* message;
    };
    constexpr std::array cases{
        Scenario{ReadMode::Error, true, "decoder failures are reported instead of clean EOF"},
        Scenario{ReadMode::Tick, false, "stream ticks do not truncate playback"},
        Scenario{ReadMode::FinalSample, false,
                 "the final PCM sample is drained even when EOF is flagged"},
        Scenario{ReadMode::FormatChange, true,
                 "a changed PCM format cannot silently reuse the old layout"},
        Scenario{ReadMode::PartialFrame, true, "partial PCM frames are rejected"},
    };
    for (const auto& scenario : cases) {
        Reader reader;
        reader.mode = scenario.mode;
        MediaFoundationDecoder decoder;
        MediaFoundationTestAccess::attach(decoder, &reader);
        std::array<float, 4> output{};
        std::uint32_t count = 0;
        bool failed = false;
        try {
            count = decoder.read(output, 4);
        } catch (const std::exception&) {
            failed = true;
        }
        expect(scenario.fails ? failed : (!failed && count == 4 && output.back() == 0.4F),
               scenario.message);
    }
    {
        Reader reader;
        MediaFoundationDecoder decoder;
        MediaFoundationTestAccess::attach(decoder, &reader);
        std::array<float, 8> guarded{};
        guarded.fill(-1);
        expect(decoder.read(std::span<float>{guarded.data(), 2}, 4) == 2 && guarded[2] == -1,
               "decoder honors output span capacity even when the requested frame count is larger");
    }
    MFShutdown();
    if (SUCCEEDED(initialized))
        CoUninitialize();
#endif
}

void mediaFoundationCloseDrainsCancellation() {
#ifdef _WIN32
    Reader reader;
    reader.blockFlush = true;
    MediaFoundationDecoder decoder;
    MediaFoundationTestAccess::attach(decoder, &reader);
    std::thread cancel([&] { decoder.cancel(); });
    reader.flushEntered.acquire();
    std::atomic<bool> closed{false};
    std::thread close([&] {
        decoder.close();
        closed.store(true);
    });
    const auto deadline = std::chrono::steady_clock::now() + std::chrono::milliseconds(100);
    while (!closed.load() && std::chrono::steady_clock::now() < deadline)
        std::this_thread::yield();
    const auto prematureClose = closed.load();
    reader.releaseFlush.release();
    cancel.join();
    close.join();
    expect(!prematureClose && !reader.releasedDuringFlush.load(),
           "reader ownership and MF runtime outlive an in-flight cancellation");
#endif
}

void mediaFoundationOwnsComOnTheDecodingThread() {
#ifdef _WIN32
    const auto path = tempRoot / "mf-com.wav";
    makeTestWav(path, 1024);
    bool initialized = false, cleaned = false;
    std::thread worker([&] {
        MediaFoundationDecoder decoder;
        decoder.open(path.string());
        APTTYPE apartment;
        APTTYPEQUALIFIER qualifier;
        initialized = SUCCEEDED(CoGetApartmentType(&apartment, &qualifier));
        decoder.close();
        cleaned = CoGetApartmentType(&apartment, &qualifier) == CO_E_NOTINITIALIZED;
    });
    worker.join();
    expect(initialized && cleaned, "decoder initializes and balances COM on its worker thread");
#endif
}
} // namespace Tests
