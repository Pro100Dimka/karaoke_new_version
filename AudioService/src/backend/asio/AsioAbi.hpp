#pragma once
#ifdef _WIN32
#ifndef WIN32_LEAN_AND_MEAN
#define WIN32_LEAN_AND_MEAN
#endif
#include <cstdint>
#include <unknwn.h>
#include <windows.h>

using AsioBool = long;
using AsioError = long;
using AsioSampleRate = double;
struct AsioInt64 {
    std::uint32_t hi;
    std::uint32_t lo;
};
using AsioSamples = AsioInt64;
using AsioTimeStamp = AsioInt64;

constexpr AsioError AsioOk = 0;
constexpr AsioError AsioSuccess = 0x3f4847a0L;
constexpr long AsioSelectorSupported = 1;
constexpr long AsioEngineVersion = 2;
constexpr long AsioResetRequest = 3;
constexpr long AsioBufferSizeChange = 4;
constexpr long AsioResyncRequest = 5;
constexpr long AsioLatenciesChanged = 6;
constexpr long AsioSupportsTimeInfo = 7;

enum AsioSampleType : long {
    AsioInt16Msb = 0,
    AsioInt24Msb = 1,
    AsioInt32Msb = 2,
    AsioFloat32Msb = 3,
    AsioFloat64Msb = 4,
    AsioInt16Lsb = 16,
    AsioInt24Lsb = 17,
    AsioInt32Lsb = 18,
    AsioFloat32Lsb = 19,
    AsioFloat64Lsb = 20,
    AsioInt32Lsb16 = 24,
    AsioInt32Lsb18 = 25,
    AsioInt32Lsb20 = 26,
    AsioInt32Lsb24 = 27
};
struct AsioBufferInfo {
    AsioBool isInput;
    long channelNum;
    void* buffers[2];
};
struct AsioChannelInfo {
    long channel;
    AsioBool isInput;
    AsioBool isActive;
    long channelGroup;
    AsioSampleType type;
    char name[32];
};
struct AsioCallbacks {
    void (*bufferSwitch)(long doubleBufferIndex, AsioBool directProcess);
    void (*sampleRateDidChange)(AsioSampleRate sampleRate);
    long (*asioMessage)(long selector, long value, void* message, double* opt);
    void* (*bufferSwitchTimeInfo)(void* params, long doubleBufferIndex, AsioBool directProcess);
};

struct __declspec(novtable) IAsioDriver : IUnknown {
    virtual AsioBool STDMETHODCALLTYPE init(void* sysHandle) = 0;
    virtual void STDMETHODCALLTYPE getDriverName(char* name) = 0;
    virtual long STDMETHODCALLTYPE getDriverVersion() = 0;
    virtual void STDMETHODCALLTYPE getErrorMessage(char* string) = 0;
    virtual AsioError STDMETHODCALLTYPE start() = 0;
    virtual AsioError STDMETHODCALLTYPE stop() = 0;
    virtual AsioError STDMETHODCALLTYPE getChannels(long* numInputChannels,
                                                    long* numOutputChannels) = 0;
    virtual AsioError STDMETHODCALLTYPE getLatencies(long* inputLatency, long* outputLatency) = 0;
    virtual AsioError STDMETHODCALLTYPE getBufferSize(long* minSize, long* maxSize,
                                                      long* preferredSize, long* granularity) = 0;
    virtual AsioError STDMETHODCALLTYPE canSampleRate(AsioSampleRate sampleRate) = 0;
    virtual AsioError STDMETHODCALLTYPE getSampleRate(AsioSampleRate* sampleRate) = 0;
    virtual AsioError STDMETHODCALLTYPE setSampleRate(AsioSampleRate sampleRate) = 0;
    virtual AsioError STDMETHODCALLTYPE getClockSources(void* clocks, long* numSources) = 0;
    virtual AsioError STDMETHODCALLTYPE setClockSource(long reference) = 0;
    virtual AsioError STDMETHODCALLTYPE getSamplePosition(AsioSamples* samplePosition,
                                                          AsioTimeStamp* timeStamp) = 0;
    virtual AsioError STDMETHODCALLTYPE getChannelInfo(AsioChannelInfo* info) = 0;
    virtual AsioError STDMETHODCALLTYPE createBuffers(AsioBufferInfo* bufferInfos, long numChannels,
                                                      long bufferSize,
                                                      AsioCallbacks* callbacks) = 0;
    virtual AsioError STDMETHODCALLTYPE disposeBuffers() = 0;
    virtual AsioError STDMETHODCALLTYPE controlPanel() = 0;
    virtual AsioError STDMETHODCALLTYPE future(long selector, void* opt) = 0;
    virtual AsioError STDMETHODCALLTYPE outputReady() = 0;
};

inline std::uint64_t asioInt64Value(const AsioInt64& value) noexcept {
    return (static_cast<std::uint64_t>(value.hi) << 32U) | value.lo;
}
#endif
