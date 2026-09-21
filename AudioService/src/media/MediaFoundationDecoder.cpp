#ifdef _WIN32
#include "media/MediaFoundationDecoder.hpp"
#include "realtime/RealtimeInstrumentation.hpp"
#ifndef WIN32_LEAN_AND_MEAN
#define WIN32_LEAN_AND_MEAN
#endif
#ifndef NOMINMAX
#define NOMINMAX
#endif
#include <algorithm>
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
    if (FAILED(hr))
        throw std::runtime_error(message);
}
} // namespace
MediaFoundationDecoder::MediaFoundationDecoder() = default;
MediaFoundationDecoder::~MediaFoundationDecoder() {
    close();
}
DecodedAudioFormat MediaFoundationDecoder::open(const std::string& pathOrUrl) {
    close();
    check(MFStartup(MF_VERSION, MFSTARTUP_LITE), "MFStartup failed");
    mfStarted_ = true;
    ComPtr<IMFAttributes> attributes;
    check(MFCreateAttributes(&attributes, 2), "MF attributes failed");
    attributes->SetUINT32(MF_LOW_LATENCY, TRUE);
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
    reader->SetStreamSelection(kAllStreams, FALSE);
    reader->SetStreamSelection(kFirstAudioStream, TRUE);
    ComPtr<IMFMediaType> current;
    check(reader->GetCurrentMediaType(kFirstAudioStream, &current),
          "MF current media type failed");
    UINT32 sampleRate = 0, channels = 0;
    check(current->GetUINT32(MF_MT_AUDIO_SAMPLES_PER_SECOND, &sampleRate),
          "MF sample rate missing");
    check(current->GetUINT32(MF_MT_AUDIO_NUM_CHANNELS, &channels), "MF channel count missing");
    PROPVARIANT duration;
    PropVariantInit(&duration);
    std::uint64_t totalFrames = 0;
    if (SUCCEEDED(reader->GetPresentationAttribute(kMediaSource, MF_PD_DURATION,
                                                   &duration)) &&
        duration.vt == VT_UI8 && sampleRate != 0)
        totalFrames = static_cast<std::uint64_t>(
            (static_cast<long double>(duration.uhVal.QuadPart) * sampleRate) / 10'000'000.0L);
    PropVariantClear(&duration);
    reader_ = reader.Detach();
    format_ = {sampleRate, channels, totalFrames};
    pending_.clear();
    pendingOffset_ = 0;
    return format_;
}
std::uint32_t MediaFoundationDecoder::read(std::span<float> output, std::uint32_t maxFrames) {
    RealtimeInstrumentation::reportDiskIo();
    RealtimeInstrumentation::reportNetworkIo();
    if (reader_ == nullptr || format_.channels == 0)
        return 0;
    const auto wantedSamples = static_cast<std::size_t>(maxFrames) * format_.channels;
    std::size_t written = 0;
    while (written < wantedSamples) {
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
        DWORD stream = 0, flags = 0;
        LONGLONG timestamp = 0;
        ComPtr<IMFSample> sample;
        const auto hr = reader_->ReadSample(kFirstAudioStream, 0, &stream, &flags,
                                            &timestamp, &sample);
        if (FAILED(hr) || (flags & kEndOfStreamFlag) != 0 || sample == nullptr)
            break;
        ComPtr<IMFMediaBuffer> buffer;
        if (FAILED(sample->ConvertToContiguousBuffer(&buffer)))
            break;
        BYTE* data = nullptr;
        DWORD maxLength = 0, currentLength = 0;
        if (FAILED(buffer->Lock(&data, &maxLength, &currentLength)))
            break;
        const auto samples = currentLength / sizeof(float);
        pending_.resize(samples);
        std::memcpy(pending_.data(), data, samples * sizeof(float));
        buffer->Unlock();
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
}
void MediaFoundationDecoder::cancel() noexcept {
    if (reader_ != nullptr)
        (void)reader_->Flush(kFirstAudioStream);
}

void MediaFoundationDecoder::close() noexcept {
    RealtimeInstrumentation::reportDiskIo();
    RealtimeInstrumentation::reportNetworkIo();
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
}
#endif
