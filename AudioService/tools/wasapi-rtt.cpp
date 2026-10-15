// Engineering-only WASAPI round-trip localizer (not part of the product).
// Opens the default capture and render endpoints independently, each in Shared (IAudioClient3,
// minimum engine period) or Exclusive (event-driven, the same period), plays a quiet chirp train
// and finds it in the microphone. Reports, on the QueryPerformanceCounter clock:
//   physical  = app hands the first chirp frame to WASAPI -> app receives that frame from WASAPI
//   renderLead = IAudioClock presentation time of that frame - hand-over time
//   captureAge = receive time - GetBuffer QPC stamp of that frame
//   residual  = capture stamp - presentation time (what timestamps cannot see)
// physical = renderLead + residual + captureAge, so comparing the four mode combinations shows
// which side a delay belongs to, independently of whether a driver's timestamps are honest.
// Build: cl /nologo /std:c++20 /O2 /EHsc wasapi-rtt.cpp ole32.lib avrt.lib
// Usage: wasapi-rtt <capture s|e> <render s|e> [runs=3] [periodMs=10]
#define NOMINMAX
#include <windows.h>
#include <audioclient.h>
#include <avrt.h>
#include <mmdeviceapi.h>
#include <mmreg.h>
#include <ks.h>
#include <ksmedia.h>

#include <algorithm>
#include <atomic>
#include <cmath>
#include <cstdio>
#include <cstdlib>
#include <cstring>
#include <stdexcept>
#include <string>
#include <thread>
#include <vector>

#pragma comment(lib, "ole32.lib")
#pragma comment(lib, "avrt.lib")

namespace {
constexpr double Pi = 3.14159265358979323846;
constexpr double ChirpSeconds = 0.05, ChirpGain = 0.2;
constexpr double Offsets[]{0.0, 0.33, 0.71};
constexpr double TrainSeconds = 0.76, LeadInSeconds = 1.0, RunSeconds = 3.0;

void check(HRESULT hr, const char* what) {
    if (FAILED(hr)) {
        char text[128];
        std::snprintf(text, sizeof text, "%s failed: 0x%08lx", what, static_cast<unsigned long>(hr));
        throw std::runtime_error(text);
    }
}
double qpcFrequency() {
    LARGE_INTEGER f;
    QueryPerformanceFrequency(&f);
    return static_cast<double>(f.QuadPart);
}
const double QpcHz = qpcFrequency();
double nowSeconds() {
    LARGE_INTEGER c;
    QueryPerformanceCounter(&c);
    return static_cast<double>(c.QuadPart) / QpcHz;
}

std::vector<float> chirp(unsigned rate) {
    const auto count = static_cast<unsigned>(std::lround(ChirpSeconds * rate));
    std::vector<float> out(count);
    const double sweep = (5000.0 - 600.0) / ChirpSeconds;
    for (unsigned i = 0; i < count; ++i) {
        const double t = static_cast<double>(i) / rate;
        const double window = 0.5 - 0.5 * std::cos(2.0 * Pi * i / (count - 1U));
        out[i] = static_cast<float>(window * std::sin(2.0 * Pi * (600.0 * t + 0.5 * sweep * t * t)));
    }
    return out;
}

struct Format {
    WAVEFORMATEXTENSIBLE wfx{};
    bool isFloat{false};
    unsigned bits{0}, container{0}, channels{0}, rate{0};
    void describe(const WAVEFORMATEX* f) {
        std::memcpy(&wfx, f, std::min<size_t>(sizeof wfx, sizeof(WAVEFORMATEX) + f->cbSize));
        channels = f->nChannels;
        rate = f->nSamplesPerSec;
        container = f->wBitsPerSample;
        bits = container;
        isFloat = f->wFormatTag == WAVE_FORMAT_IEEE_FLOAT;
        if (f->wFormatTag == WAVE_FORMAT_EXTENSIBLE) {
            const auto* x = reinterpret_cast<const WAVEFORMATEXTENSIBLE*>(f);
            isFloat = x->SubFormat == KSDATAFORMAT_SUBTYPE_IEEE_FLOAT;
            bits = x->Samples.wValidBitsPerSample ? x->Samples.wValidBitsPerSample : container;
        }
    }
    float read(const BYTE* p) const {
        if (isFloat) return *reinterpret_cast<const float*>(p);
        if (container == 16) return *reinterpret_cast<const int16_t*>(p) / 32768.0f;
        if (container == 24) {
            const int v = (p[0] << 8 | p[1] << 16 | p[2] << 24) >> 8;
            return v / 8388608.0f;
        }
        return static_cast<float>(*reinterpret_cast<const int32_t*>(p) / 2147483648.0);
    }
    void write(BYTE* p, float v) const {
        v = std::clamp(v, -1.0f, 1.0f);
        if (isFloat) { *reinterpret_cast<float*>(p) = v; return; }
        if (container == 16) { *reinterpret_cast<int16_t*>(p) = static_cast<int16_t>(v * 32767); return; }
        if (container == 24) {
            const int s = static_cast<int>(v * 8388607);
            p[0] = s & 0xff; p[1] = (s >> 8) & 0xff; p[2] = (s >> 16) & 0xff;
            return;
        }
        *reinterpret_cast<int32_t*>(p) = static_cast<int32_t>(v * 2147483647.0);
    }
};

// Exclusive: the endpoint's own format first, then common PCM layouts at 48 kHz.
WAVEFORMATEXTENSIBLE exclusiveCandidate(unsigned channels, unsigned rate, unsigned container,
                                        unsigned valid, bool isFloat) {
    WAVEFORMATEXTENSIBLE x{};
    x.Format.wFormatTag = WAVE_FORMAT_EXTENSIBLE;
    x.Format.nChannels = static_cast<WORD>(channels);
    x.Format.nSamplesPerSec = rate;
    x.Format.wBitsPerSample = static_cast<WORD>(container);
    x.Format.nBlockAlign = static_cast<WORD>(channels * container / 8);
    x.Format.nAvgBytesPerSec = rate * x.Format.nBlockAlign;
    x.Format.cbSize = sizeof(WAVEFORMATEXTENSIBLE) - sizeof(WAVEFORMATEX);
    x.Samples.wValidBitsPerSample = static_cast<WORD>(valid);
    x.dwChannelMask = channels == 1 ? SPEAKER_FRONT_CENTER : SPEAKER_FRONT_LEFT | SPEAKER_FRONT_RIGHT;
    x.SubFormat = isFloat ? KSDATAFORMAT_SUBTYPE_IEEE_FLOAT : KSDATAFORMAT_SUBTYPE_PCM;
    return x;
}

std::string gOptions; // "noraw", "legacy", "comm": capture-only variants for localisation

struct Stream {
    bool exclusive{false};
    IMMDevice* device{nullptr};
    IAudioClient* client{nullptr};
    HANDLE event{nullptr};
    Format format;
    UINT32 bufferFrames{0}, periodFrames{0};
    std::string describe;

    void open(EDataFlow flow, bool wantExclusive, double periodMs) {
        exclusive = wantExclusive;
        IMMDeviceEnumerator* e = nullptr;
        check(CoCreateInstance(__uuidof(MMDeviceEnumerator), nullptr, CLSCTX_ALL,
                               IID_PPV_ARGS(&e)), "enumerator");
        check(e->GetDefaultAudioEndpoint(flow, eConsole, &device), "default endpoint");
        e->Release();
        check(device->Activate(__uuidof(IAudioClient), CLSCTX_ALL, nullptr,
                               reinterpret_cast<void**>(&client)), "activate");
        event = CreateEventW(nullptr, FALSE, FALSE, nullptr);
        WAVEFORMATEX* mix = nullptr;
        check(client->GetMixFormat(&mix), "mix format");
        if (!exclusive) {
            format.describe(mix);
            IAudioClient3* c3 = nullptr;
            UINT32 def = 0, fund = 0, mn = 0, mx = 0;
            const bool variant = flow == eCapture;
            const bool legacy = variant && gOptions.find("legacy") != std::string::npos;
            if (!legacy && SUCCEEDED(client->QueryInterface(IID_PPV_ARGS(&c3))) &&
                SUCCEEDED(c3->GetSharedModeEnginePeriod(mix, &def, &fund, &mn, &mx))) {
                AudioClientProperties props{sizeof props};
                props.eCategory = variant && gOptions.find("comm") != std::string::npos
                                      ? AudioCategory_Communications : AudioCategory_Media;
                props.Options = variant && gOptions.find("noraw") != std::string::npos
                                    ? AUDCLNT_STREAMOPTIONS_NONE : AUDCLNT_STREAMOPTIONS_RAW;
                if (props.Options && FAILED(c3->SetClientProperties(&props))) {
                    props.Options = AUDCLNT_STREAMOPTIONS_NONE;
                    c3->SetClientProperties(&props);
                } else if (!props.Options) {
                    c3->SetClientProperties(&props);
                }
                check(c3->InitializeSharedAudioStream(AUDCLNT_STREAMFLAGS_EVENTCALLBACK, mn, mix,
                                                      nullptr), "InitializeSharedAudioStream");
                UINT32 actualFormatPeriod = 0;
                WAVEFORMATEX* cur = nullptr;
                c3->GetCurrentSharedModeEnginePeriod(&cur, &actualFormatPeriod);
                if (cur) CoTaskMemFree(cur);
                periodFrames = actualFormatPeriod;
                describe = "Shared(c3 min=" + std::to_string(mn) + " actual=" +
                           std::to_string(actualFormatPeriod) + (props.Options ? " raw)" : ")");
                c3->Release();
            } else {
                check(client->Initialize(AUDCLNT_SHAREMODE_SHARED, AUDCLNT_STREAMFLAGS_EVENTCALLBACK,
                                         0, 0, mix, nullptr), "Initialize shared");
                describe = "Shared(legacy)";
            }
        } else {
            const unsigned channels = mix->nChannels, rate = mix->nSamplesPerSec;
            const WAVEFORMATEXTENSIBLE candidates[]{
                exclusiveCandidate(channels, rate, 32, 32, true),
                exclusiveCandidate(channels, rate, 32, 24, false),
                exclusiveCandidate(channels, rate, 32, 32, false),
                exclusiveCandidate(channels, rate, 24, 24, false),
                exclusiveCandidate(channels, rate, 16, 16, false),
            };
            const WAVEFORMATEXTENSIBLE* chosen = nullptr;
            for (const auto& c : candidates)
                if (client->IsFormatSupported(AUDCLNT_SHAREMODE_EXCLUSIVE,
                                              reinterpret_cast<const WAVEFORMATEX*>(&c), nullptr) == S_OK) {
                    chosen = &c;
                    break;
                }
            if (!chosen) throw std::runtime_error("no exclusive format");
            format.describe(reinterpret_cast<const WAVEFORMATEX*>(chosen));
            REFERENCE_TIME duration = static_cast<REFERENCE_TIME>(periodMs * 10'000.0);
            auto hr = client->Initialize(AUDCLNT_SHAREMODE_EXCLUSIVE, AUDCLNT_STREAMFLAGS_EVENTCALLBACK,
                                         duration, duration, &format.wfx.Format, nullptr);
            if (hr == AUDCLNT_E_BUFFER_SIZE_NOT_ALIGNED) {
                UINT32 frames = 0;
                client->GetBufferSize(&frames);
                client->Release();
                client = nullptr;
                check(device->Activate(__uuidof(IAudioClient), CLSCTX_ALL, nullptr,
                                       reinterpret_cast<void**>(&client)), "reactivate");
                duration = static_cast<REFERENCE_TIME>(10'000'000.0 * frames / format.rate + 0.5);
                hr = client->Initialize(AUDCLNT_SHAREMODE_EXCLUSIVE, AUDCLNT_STREAMFLAGS_EVENTCALLBACK,
                                        duration, duration, &format.wfx.Format, nullptr);
            }
            check(hr, "Initialize exclusive");
            describe = "Exclusive(" + std::to_string(format.container) + "bit" +
                       (format.isFloat ? " float" : "") + ")";
        }
        CoTaskMemFree(mix);
        check(client->SetEventHandle(event), "SetEventHandle");
        check(client->GetBufferSize(&bufferFrames), "GetBufferSize");
        if (!periodFrames) periodFrames = exclusive ? bufferFrames : 0;
        REFERENCE_TIME latency = 0;
        client->GetStreamLatency(&latency);
        describe += " buffer=" + std::to_string(bufferFrames) + " period=" + std::to_string(periodFrames) +
                    " streamLatency=" + std::to_string(latency / 10'000.0) + "ms";
    }
    void close() {
        if (client) { client->Stop(); client->Release(); }
        if (device) device->Release();
        if (event) CloseHandle(event);
        client = nullptr; device = nullptr; event = nullptr;
    }
};

struct RenderBlock { long long firstFrame; unsigned frames; double releasedAt, clockQpc; double clockPos; };
struct CapturePacket { long long firstFrame; unsigned frames; double receivedAt, stampQpc; long long devicePos; bool stampError; };

struct Result { bool ok; double physical, renderLead, captureAge, residual, confidence; };

Result runOnce(Stream& cap, Stream& ren) {
    const unsigned rate = ren.format.rate;
    if (cap.format.rate != rate) throw std::runtime_error("capture and render rates differ");
    const auto single = chirp(rate);
    std::vector<float> train(static_cast<size_t>(TrainSeconds * rate), 0.0f);
    for (const auto o : Offsets) {
        const auto start = static_cast<size_t>(std::lround(o * rate));
        for (size_t i = 0; i < single.size(); ++i) train[start + i] += single[i] * static_cast<float>(ChirpGain);
    }
    const long long chirpFrame = static_cast<long long>(LeadInSeconds * rate);
    const long long totalFrames = static_cast<long long>(RunSeconds * rate);

    std::vector<RenderBlock> blocks;
    std::vector<CapturePacket> packets;
    std::vector<float> recorded;
    blocks.reserve(4096); packets.reserve(4096); recorded.reserve(static_cast<size_t>(RunSeconds * rate * 1.5));
    std::atomic<bool> stop{false};
    IAudioRenderClient* rc = nullptr;
    IAudioCaptureClient* cc = nullptr;
    IAudioClock* clock = nullptr;
    check(ren.client->GetService(IID_PPV_ARGS(&rc)), "render client");
    check(cap.client->GetService(IID_PPV_ARGS(&cc)), "capture client");
    check(ren.client->GetService(IID_PPV_ARGS(&clock)), "audio clock");
    UINT64 clockFrequency = 0;
    clock->GetFrequency(&clockFrequency);
    long long written = 0;

    auto renderPass = [&](bool prefill) {
        UINT32 available = ren.bufferFrames;
        if (!ren.exclusive) {
            UINT32 padding = 0;
            check(ren.client->GetCurrentPadding(&padding), "padding");
            available = ren.bufferFrames - padding;
            // Like AudioService: keep one engine period queued, not the whole buffer.
            const UINT32 target = ren.periodFrames ? ren.periodFrames : ren.bufferFrames / 2;
            available = padding >= target ? 0 : std::min(available, target - padding);
        }
        if (!available) return;
        BYTE* data = nullptr;
        check(rc->GetBuffer(available, &data), "render GetBuffer");
        const unsigned bytes = ren.format.container / 8, ch = ren.format.channels;
        for (UINT32 f = 0; f < available; ++f) {
            const long long frame = written + f;
            float v = 0.0f;
            if (!prefill && frame >= chirpFrame && frame - chirpFrame < static_cast<long long>(train.size()))
                v = train[static_cast<size_t>(frame - chirpFrame)];
            for (unsigned c = 0; c < ch; ++c) ren.format.write(data + (f * ch + c) * bytes, v);
        }
        check(rc->ReleaseBuffer(available, 0), "render ReleaseBuffer");
        const double released = nowSeconds();
        UINT64 pos = 0, qpc = 0;
        double clockQpc = 0, clockPos = -1;
        if (SUCCEEDED(clock->GetPosition(&pos, &qpc))) {
            clockQpc = qpc / 1e7;
            clockPos = static_cast<double>(pos) * rate / static_cast<double>(clockFrequency);
        }
        blocks.push_back({written, available, released, clockQpc, clockPos});
        written += available;
    };

    std::thread capture([&] {
        CoInitializeEx(nullptr, COINIT_MULTITHREADED);
        DWORD task = 0;
        HANDLE mm = AvSetMmThreadCharacteristicsW(L"Pro Audio", &task);
        long long frames = 0;
        while (!stop) {
            if (WaitForSingleObject(cap.event, 200) != WAIT_OBJECT_0) continue;
            for (;;) {
                BYTE* data = nullptr; UINT32 n = 0; DWORD flags = 0; UINT64 devPos = 0, qpc = 0;
                const HRESULT hr = cc->GetBuffer(&data, &n, &flags, &devPos, &qpc);
                if (hr == AUDCLNT_S_BUFFER_EMPTY) break;
                check(hr, "capture GetBuffer");
                if (n == 0) { cc->ReleaseBuffer(0); break; }
                const double received = nowSeconds();
                const unsigned bytes = cap.format.container / 8, ch = cap.format.channels;
                for (UINT32 f = 0; f < n; ++f)
                    recorded.push_back((flags & AUDCLNT_BUFFERFLAGS_SILENT) ? 0.0f
                                                                           : cap.format.read(data + f * ch * bytes));
                packets.push_back({frames, n, received, qpc / 1e7, static_cast<long long>(devPos),
                                   (flags & AUDCLNT_BUFFERFLAGS_TIMESTAMP_ERROR) != 0});
                frames += n;
                cc->ReleaseBuffer(n);
            }
        }
        if (mm) AvRevertMmThreadCharacteristics(mm);
        CoUninitialize();
    });

    DWORD task = 0;
    HANDLE mm = AvSetMmThreadCharacteristicsW(L"Pro Audio", &task);
    renderPass(true);
    check(cap.client->Start(), "capture Start");
    check(ren.client->Start(), "render Start");
    while (written < totalFrames) {
        if (WaitForSingleObject(ren.event, 200) != WAIT_OBJECT_0) continue;
        renderPass(false);
    }
    Sleep(300);
    stop = true;
    capture.join();
    ren.client->Stop(); cap.client->Stop();
    ren.client->Reset(); cap.client->Reset();
    if (mm) AvRevertMmThreadCharacteristics(mm);
    rc->Release(); cc->Release(); clock->Release();

    // Hand-over time of the first chirp frame: its block's release time, advanced by its offset.
    const auto block = std::find_if(blocks.begin(), blocks.end(), [&](const RenderBlock& b) {
        return chirpFrame >= b.firstFrame && chirpFrame < b.firstFrame + b.frames; });
    if (block == blocks.end()) return {false};
    const double handedOver = block->releasedAt + double(chirpFrame - block->firstFrame) / rate;
    // Presentation from the latest clock snapshot taken at or after that block.
    double presented = 0;
    for (auto b = block; b != blocks.end(); ++b)
        if (b->clockPos >= 0 && b->clockQpc > 0) {
            presented = b->clockQpc + (chirpFrame - b->clockPos) / rate;
            if (b - block > 20) break;
        }
    // Search the microphone from the hand-over moment for up to 0.5 s.
    auto receiveTime = [&](long long frame) {
        for (const auto& p : packets)
            if (frame >= p.firstFrame && frame < p.firstFrame + p.frames)
                return p.receivedAt - double(p.firstFrame + p.frames - 1 - frame) / rate;
        return -1.0;
    };
    long long startLag = 0;
    for (const auto& p : packets)
        if (p.receivedAt >= handedOver) { startLag = std::max<long long>(0, p.firstFrame - static_cast<long long>(p.frames) * 2); break; }
    const long long lastLag = std::min<long long>(static_cast<long long>(recorded.size()) - static_cast<long long>(train.size()),
                                                  startLag + static_cast<long long>(0.6 * rate));
    double chirpEnergy = 0;
    for (const auto v : single) chirpEnergy += double(v) * v;
    double best = -1, bestWeakest = 0; long long bestLag = -1;
    for (long long lag = startLag; lag <= lastLag; ++lag) {
        double score = 0, weakest = 1;
        for (const auto o : Offsets) {
            const auto at = lag + std::lround(o * rate);
            double dot = 0, energy = 0;
            for (size_t i = 0; i < single.size(); ++i) {
                const double x = recorded[static_cast<size_t>(at) + i];
                dot += x * single[i]; energy += x * x;
            }
            const double ncc = energy > 0 ? std::abs(dot) / std::sqrt(energy * chirpEnergy) : 0;
            score += ncc; weakest = std::min(weakest, ncc);
        }
        if (score > best) { best = score; bestWeakest = weakest; bestLag = lag; }
    }
    if (bestLag < 0 || bestWeakest < 0.3) return {false, 0, 0, 0, 0, bestWeakest};
    const double received = receiveTime(bestLag);
    double stamped = 0;
    for (const auto& p : packets)
        if (bestLag >= p.firstFrame && bestLag < p.firstFrame + p.frames)
            stamped = p.stampQpc + double(bestLag - p.firstFrame) / rate;
    return {true, (received - handedOver) * 1e3, (presented - handedOver) * 1e3,
            (received - stamped) * 1e3, (stamped - presented) * 1e3, bestWeakest};
}
} // namespace

// "probe [seconds]": opens the default microphone the ordinary shared way, the way any other
// application would, keeps it running for `seconds` and prints whether Windows allowed it.
int probe(double seconds, bool exclusive) {
    CoInitializeEx(nullptr, COINIT_MULTITHREADED);
    IMMDeviceEnumerator* e = nullptr;
    IMMDevice* device = nullptr;
    IAudioClient* client = nullptr;
    WAVEFORMATEX* mix = nullptr;
    HRESULT hr = CoCreateInstance(__uuidof(MMDeviceEnumerator), nullptr, CLSCTX_ALL, IID_PPV_ARGS(&e));
    if (SUCCEEDED(hr)) hr = e->GetDefaultAudioEndpoint(eCapture, eConsole, &device);
    if (SUCCEEDED(hr)) hr = device->Activate(__uuidof(IAudioClient), CLSCTX_ALL, nullptr,
                                             reinterpret_cast<void**>(&client));
    if (SUCCEEDED(hr)) hr = client->GetMixFormat(&mix);
    if (SUCCEEDED(hr)) {
        REFERENCE_TIME normal = 0, minimum = 0;
        client->GetDevicePeriod(&normal, &minimum);
        std::printf("{\"devicePeriodDefaultMs\":%.3f,\"devicePeriodMinimumMs\":%.3f}%c",
                    normal / 10'000.0, minimum / 10'000.0, 10);
    }
    if (SUCCEEDED(hr) && exclusive) {
        // The endpoint's own PCM layouts, as an exclusive recorder would open it.
        Stream holder;
        holder.open(eCapture, true, 10.0);
        std::printf("{\"probe\":\"exclusive-capture\",\"open\":true}"),
        std::printf("%c", 10);
        std::fflush(stdout);
        holder.client->Start();
        Sleep(static_cast<DWORD>(seconds * 1000));
        holder.close();
        client->Release(); client = nullptr;
        CoTaskMemFree(mix); mix = nullptr;
        device->Release(); e->Release();
        CoUninitialize();
        return 0;
    }
    if (SUCCEEDED(hr)) hr = client->Initialize(AUDCLNT_SHAREMODE_SHARED, 0, 1'000'000, 0, mix, nullptr);
    if (SUCCEEDED(hr)) hr = client->Start();
    std::printf("{\"probe\":\"shared-capture\",\"hresult\":\"0x%08lx\",\"open\":%s}\n",
                static_cast<unsigned long>(hr), SUCCEEDED(hr) ? "true" : "false");
    std::fflush(stdout);
    if (SUCCEEDED(hr)) Sleep(static_cast<DWORD>(seconds * 1000));
    if (client) { client->Stop(); client->Release(); }
    if (mix) CoTaskMemFree(mix);
    if (device) device->Release();
    if (e) e->Release();
    CoUninitialize();
    return SUCCEEDED(hr) ? 0 : 1;
}

int main(int argc, char** argv) {
    if (argc >= 2 && std::string(argv[1]).rfind("probe", 0) == 0)
        try {
            return probe(argc > 2 ? std::atof(argv[2]) : 0.5,
                         std::string(argv[1]) == "probe-exclusive");
        } catch (const std::exception& error) {
            std::printf("{\"probe\":\"%s\",\"open\":false,\"error\":\"%s\"}%c", argv[1],
                        error.what(), 10);
            return 1;
        }
    if (argc < 3) {
        std::fprintf(stderr, "usage: wasapi-rtt <capture s|e> <render s|e> [runs] [periodMs]\n");
        return 2;
    }
    const bool capExclusive = argv[1][0] == 'e', renExclusive = argv[2][0] == 'e';
    const int runs = argc > 3 ? std::atoi(argv[3]) : 3;
    const double periodMs = argc > 4 ? std::atof(argv[4]) : 10.0;
    gOptions = argc > 5 ? argv[5] : "";
    CoInitializeEx(nullptr, COINIT_MULTITHREADED);
    int failures = 0;
    for (int run = 0; run < runs; ++run) {
        Stream cap, ren;
        try {
            cap.open(eCapture, capExclusive, periodMs);
            ren.open(eRender, renExclusive, periodMs);
            if (run == 0)
                std::printf("capture: %s\nrender:  %s\n", cap.describe.c_str(), ren.describe.c_str());
            const auto r = runOnce(cap, ren);
            if (r.ok)
                std::printf("{\"capture\":\"%s\",\"render\":\"%s\",\"run\":%d,\"physicalMs\":%.2f,"
                            "\"renderLeadMs\":%.2f,\"residualMs\":%.2f,\"captureAgeMs\":%.2f,\"confidence\":%.2f}\n",
                            capExclusive ? "exclusive" : "shared", renExclusive ? "exclusive" : "shared",
                            run, r.physical, r.renderLead, r.residual, r.captureAge, r.confidence);
            else {
                std::printf("{\"run\":%d,\"error\":\"chirp not found\",\"confidence\":%.2f}\n", run, r.confidence);
                ++failures;
            }
        } catch (const std::exception& error) {
            std::printf("{\"run\":%d,\"error\":\"%s\"}\n", run, error.what());
            ++failures;
        }
        cap.close();
        ren.close();
        Sleep(300);
    }
    CoUninitialize();
    return failures ? 1 : 0;
}
