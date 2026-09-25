#ifdef _WIN32
#include "media/MediaFoundationDecoder.hpp"
#include "common/Types.hpp"
#include "realtime/RealtimeInstrumentation.hpp"
#ifndef WIN32_LEAN_AND_MEAN
#define WIN32_LEAN_AND_MEAN
#endif
#ifndef NOMINMAX
#define NOMINMAX
#endif
#include <algorithm>
#include <cstdio>
#include <cstring>
#include <mfapi.h>
#include <mfidl.h>
#include <mfreadwrite.h>
#include <propvarutil.h>
#include <stdexcept>
#include <windows.h>
#include <wrl/client.h>

using Microsoft::WRL::ComPtr;
namespace {
constexpr DWORD kFirstAudioStream = static_cast<DWORD>(MF_SOURCE_READER_FIRST_AUDIO_STREAM);
constexpr DWORD kAllStreams = static_cast<DWORD>(MF_SOURCE_READER_ALL_STREAMS);
constexpr DWORD kMediaSource = static_cast<DWORD>(MF_SOURCE_READER_MEDIASOURCE);
constexpr DWORD kEndOfStreamFlag = static_cast<DWORD>(MF_SOURCE_READERF_ENDOFSTREAM);
std::wstring widen(const std::string& text) {
    if (text.empty())
        return {};
    const auto count = MultiByteToWideChar(CP_UTF8, 0, text.c_str(), -1, nullptr, 0);
    if (count <= 0)
        throw std::runtime_error("UTF-8 path conversion failed");
    std::wstring out(static_cast<std::size_t>(count), L'\0');
    MultiByteToWideChar(CP_UTF8, 0, text.c_str(), -1, out.data(), count);
    out.resize(static_cast<std::size_t>(count - 1));
    return out;
}
void check(HRESULT hr, const char* message) {
    if (FAILED(hr)) {
        char code[16]{};
        std::snprintf(code, sizeof(code), " (0x%08lX)", static_cast<unsigned long>(hr));
        throw std::runtime_error(std::string(message) + code);
    }
}
} // namespace
MediaFoundationDecoder::MediaFoundationDecoder() = default;
MediaFoundationDecoder::~MediaFoundationDecoder() {
    close();
}
DecodedAudioFormat MediaFoundationDecoder::open(const std::string& pathOrUrl) try {
    close();
    const auto initialized = CoInitializeEx(nullptr, COINIT_MULTITHREADED);
    if (initialized != RPC_E_CHANGED_MODE)
        check(initialized, "MF COM initialization failed");
    comInitialized_ = SUCCEEDED(initialized);
    check(MFStartup(MF_VERSION, MFSTARTUP_LITE), "MFStartup failed");
    mfStarted_ = true;
    ComPtr<IMFAttributes> attributes;
    check(MFCreateAttributes(&attributes, 2), "MF attributes failed");
    check(attributes->SetUINT32(MF_LOW_LATENCY, TRUE), "MF low-latency attribute failed");
    ComPtr<IMFSourceReader> reader;
    const auto path = widen(pathOrUrl);
    check(MFCreateSourceReaderFromURL(path.c_str(), attributes.Get(), &reader),
          "Media Foundation cannot open source");
    ComPtr<IMFMediaType> type;
    check(MFCreateMediaType(&type), "MF media type failed");
    check(type->SetGUID(MF_MT_MAJOR_TYPE, MFMediaType_Audio), "MF audio major type failed");
    check(type->SetGUID(MF_MT_SUBTYPE, MFAudioFormat_Float), "MF float subtype failed");
    check(reader->SetCurrentMediaType(kFirstAudioStream, nullptr, type.Get()),
          "MF float conversion unavailable");
    check(reader->SetStreamSelection(kAllStreams, FALSE), "MF stream deselection failed");
    check(reader->SetStreamSelection(kFirstAudioStream, TRUE), "MF audio stream selection failed");
    ComPtr<IMFMediaType> current;
    check(reader->GetCurrentMediaType(kFirstAudioStream, &current),
          "MF current media type failed");
    UINT32 sampleRate = 0, channels = 0;
    check(current->GetUINT32(MF_MT_AUDIO_SAMPLES_PER_SECOND, &sampleRate),
          "MF sample rate missing");
    check(current->GetUINT32(MF_MT_AUDIO_NUM_CHANNELS, &channels), "MF channel count missing");
    if (sampleRate == 0 || channels == 0 || channels > MaxAudioChannels)
        throw std::runtime_error("MF returned unsupported audio dimensions");
    PROPVARIANT duration;
    PropVariantInit(&duration);
    std::uint64_t totalFrames = 0;
    if (SUCCEEDED(reader->GetPresentationAttribute(kMediaSource, MF_PD_DURATION,
                                                   &duration)) &&
        duration.vt == VT_UI8 && sampleRate != 0)
        totalFrames = static_cast<std::uint64_t>(
            (static_cast<long double>(duration.uhVal.QuadPart) * sampleRate) / 10'000'000.0L);
    PropVariantClear(&duration);
    {
        std::lock_guard lock(readerMutex_);
        reader_ = reader.Detach();
        cancelled_.store(false, std::memory_order_release);
    }
    format_ = {sampleRate, channels, totalFrames};
    pending_.clear();
    pendingOffset_ = 0;
    eof_ = false;
    return format_;
} catch (...) {
    close();
    throw;
}
std::uint32_t MediaFoundationDecoder::read(std::span<float> output, std::uint32_t maxFrames) {
    RealtimeInstrumentation::reportDiskIo();
    RealtimeInstrumentation::reportNetworkIo();
    if (reader_ == nullptr || format_.channels == 0)
        return 0;
    const auto wantedSamples =
        std::min<std::size_t>(maxFrames, output.size() / format_.channels) * format_.channels;
    std::size_t written = 0;
    unsigned emptySamples = 0;
    constexpr unsigned MaximumEmptySamples = 1024;
    while (written < wantedSamples && !cancelled_.load(std::memory_order_acquire)) {
        if (pendingOffset_ < pending_.size()) {
            const auto count = std::min(wantedSamples - written, pending_.size() - pendingOffset_);
            std::copy_n(pending_.data() + static_cast<std::ptrdiff_t>(pendingOffset_), count,
                        output.data() + static_cast<std::ptrdiff_t>(written));
            pendingOffset_ += count;
            written += count;
            if (pendingOffset_ == pending_.size()) {
                pending_.clear();
                pendingOffset_ = 0;
            }
            continue;
        }
        if (eof_)
            break;
        DWORD stream = 0, flags = 0;
        LONGLONG timestamp = 0;
        ComPtr<IMFSample> sample;
        const auto hr = reader_->ReadSample(kFirstAudioStream, 0, &stream, &flags,
                                            &timestamp, &sample);
        if (cancelled_.load(std::memory_order_acquire))
            break;
        check(hr, "MF read failed");
        if ((flags & MF_SOURCE_READERF_ERROR) != 0)
            throw std::runtime_error("MF source reported a decoding error");
        if ((flags & MF_SOURCE_READERF_CURRENTMEDIATYPECHANGED) != 0) {
            ComPtr<IMFMediaType> current;
            check(reader_->GetCurrentMediaType(kFirstAudioStream, &current),
                  "MF format update failed");
            UINT32 sampleRate = 0, channels = 0, bits = 0;
            GUID subtype{};
            check(current->GetUINT32(MF_MT_AUDIO_SAMPLES_PER_SECOND, &sampleRate),
                  "MF sample rate missing");
            check(current->GetUINT32(MF_MT_AUDIO_NUM_CHANNELS, &channels),
                  "MF channel count missing");
            check(current->GetUINT32(MF_MT_AUDIO_BITS_PER_SAMPLE, &bits), "MF sample size missing");
            check(current->GetGUID(MF_MT_SUBTYPE, &subtype), "MF sample encoding missing");
            if (sampleRate != format_.sampleRateHz || channels != format_.channels || bits != 32 ||
                subtype != MFAudioFormat_Float)
                throw std::runtime_error("MF source changed the negotiated audio format");
        }
        eof_ = (flags & kEndOfStreamFlag) != 0;
        if (sample == nullptr) {
            // Bound malformed sources that produce endless events with no PCM or EOF.
            if (++emptySamples > MaximumEmptySamples)
                throw std::runtime_error("MF source made no audio progress");
            continue;
        }
        ComPtr<IMFMediaBuffer> buffer;
        check(sample->ConvertToContiguousBuffer(&buffer), "MF sample conversion failed");
        BYTE* data = nullptr;
        DWORD maxLength = 0, currentLength = 0;
        check(buffer->Lock(&data, &maxLength, &currentLength), "MF sample lock failed");
        struct Unlock {
            IMFMediaBuffer* buffer;
            ~Unlock() {
                buffer->Unlock();
            }
        } unlock{buffer.Get()};
        constexpr DWORD MaximumSampleBytes = 32U * 1024U * 1024U;
        if (currentLength > maxLength || currentLength > MaximumSampleBytes ||
            currentLength % (format_.channels * sizeof(float)) != 0 ||
            (currentLength != 0 && data == nullptr))
            throw std::runtime_error("MF returned invalid PCM buffer dimensions");
        if (currentLength == 0) {
            if (++emptySamples > MaximumEmptySamples)
                throw std::runtime_error("MF source made no audio progress");
            continue;
        }
        emptySamples = 0;
        const auto samples = currentLength / sizeof(float);
        pending_.resize(samples);
        std::memcpy(pending_.data(), data, samples * sizeof(float));
        pendingOffset_ = 0;
        (void)stream;
        (void)timestamp;
        (void)maxLength;
    }
    return static_cast<std::uint32_t>(written / format_.channels);
}
void MediaFoundationDecoder::seek(std::uint64_t frame) {
    RealtimeInstrumentation::reportDiskIo();
    RealtimeInstrumentation::reportNetworkIo();
    if (reader_ == nullptr || format_.sampleRateHz == 0)
        return;
    PROPVARIANT position;
    PropVariantInit(&position);
    position.vt = VT_I8;
    position.hVal.QuadPart = static_cast<LONGLONG>(
        (static_cast<long double>(frame) * 10'000'000.0L) / format_.sampleRateHz);
    if (FAILED(reader_->SetCurrentPosition(GUID_NULL, position))) {
        PropVariantClear(&position);
        throw std::runtime_error("MF source does not support seek");
    }
    PropVariantClear(&position);
    pending_.clear();
    pendingOffset_ = 0;
    eof_ = false;
    cancelled_.store(false, std::memory_order_release);
}
void MediaFoundationDecoder::cancel() noexcept {
    cancelled_.store(true, std::memory_order_release);
    std::lock_guard lock(readerMutex_);
    if (reader_ != nullptr)
        (void)reader_->Flush(kFirstAudioStream);
}

void MediaFoundationDecoder::close() noexcept {
    RealtimeInstrumentation::reportDiskIo();
    RealtimeInstrumentation::reportNetworkIo();
    std::lock_guard lock(readerMutex_);
    pending_.clear();
    pendingOffset_ = 0;
    format_ = {};
    if (reader_ != nullptr) {
        reader_->Release();
        reader_ = nullptr;
    }
    if (mfStarted_) {
        MFShutdown();
        mfStarted_ = false;
    }
    if (comInitialized_) {
        CoUninitialize();
        comInitialized_ = false;
    }
}
#endif
