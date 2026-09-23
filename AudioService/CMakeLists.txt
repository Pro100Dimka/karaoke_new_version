cmake_minimum_required(VERSION 3.24)
project(AudioService LANGUAGES CXX)

set(CMAKE_CXX_STANDARD 20)
set(CMAKE_CXX_STANDARD_REQUIRED ON)
set(CMAKE_CXX_EXTENSIONS OFF)

# Opus is the de-facto standard low-latency speech codec (used by WebRTC, Discord, etc.); vendored via
# FetchContent rather than a hand-rolled encoder, since writing a perceptual codec is exactly the kind of
# nontrivial infrastructure the project rules say to use a proven library for instead.
include(FetchContent)
set(OPUS_BUILD_SHARED_LIBRARY OFF CACHE BOOL "" FORCE)
set(OPUS_BUILD_TESTING OFF CACHE BOOL "" FORCE)
set(OPUS_BUILD_PROGRAMS OFF CACHE BOOL "" FORCE)
set(OPUS_INSTALL_PKG_CONFIG_MODULE OFF CACHE BOOL "" FORCE)
set(OPUS_INSTALL_CMAKE_CONFIG_MODULE OFF CACHE BOOL "" FORCE)
FetchContent_Declare(
    opus
    GIT_REPOSITORY https://github.com/xiph/opus.git
    GIT_TAG v1.5.2
    GIT_SHALLOW TRUE
)
FetchContent_MakeAvailable(opus)

option(AUDIOSERVICE_WARNINGS_AS_ERRORS "Treat warnings as errors" ON)
option(AUDIOSERVICE_BUILD_TESTS "Build tests" ON)
option(AUDIOSERVICE_BUILD_RELEASE_GATES "Build long release repetition gates" OFF)
option(AUDIOSERVICE_ENABLE_ASIO "Build native ASIO backend on Windows" ON)
option(AUDIOSERVICE_ENABLE_MSVC_ANALYSIS "Enable MSVC code analysis" OFF)

set(AUDIOSERVICE_CORE_SOURCES
    src/realtime/RealtimeInstrumentation.cpp
    src/realtime/RealtimeBufferPool.cpp
    src/diagnostics/LatencyMeasurement.cpp
    src/diagnostics/GraphIntrospection.cpp
    src/analysis/AnalysisEngine.cpp
    src/analysis/SignalMetrics.cpp
    src/analysis/OutputSpectrum.cpp
    src/app/AudioService.cpp
    src/app/AudioServiceCommands.cpp
    src/backend/fake/FakeAudioBackend.cpp
    src/backend/BackendSelection.cpp
    src/clock/ClockBridge.cpp
    src/clock/ClockSynchronizer.cpp
    src/diagnostics/LatencyRegistry.cpp
    src/diagnostics/TraceBuffer.cpp
    src/dsp/BasicProcessors.cpp
    src/dsp/DspChain.cpp
    src/graph/Mixer.cpp
    src/ipc/ControlProtocol.cpp
    src/media/MediaController.cpp
    src/media/DecoderFactory.cpp
    src/media/MediaSource.cpp
    src/media/RateTransposeProcessor.cpp
    src/media/WavDecoder.cpp
    src/network/AdaptiveJitterBuffer.cpp
    src/network/NetworkAudioEngine.cpp
    src/network/OpusCodec.cpp
    src/network/UdpSocket.cpp
    src/recording/RecordingEngine.cpp
    src/recording/WavWriter.cpp
    src/realtime/PcmRingBuffer.cpp
    src/realtime/RealtimeEngine.cpp
    src/session/SessionManager.cpp
)

if(WIN32)
    list(APPEND AUDIOSERVICE_CORE_SOURCES
        src/backend/wasapi/WasapiBackend.cpp
        src/backend/wasapi/WasapiPcm.cpp
        src/devices/WindowsDeviceManager.cpp
        src/media/MediaFoundationDecoder.cpp
        src/ipc/NamedPipeServer.cpp
    )
    if(AUDIOSERVICE_ENABLE_ASIO)
        list(APPEND AUDIOSERVICE_CORE_SOURCES
            src/backend/asio/AsioBackend.cpp
            src/backend/asio/AsioComApartment.cpp
            src/backend/asio/AsioSampleConversion.cpp
        )
    endif()
else()
    list(APPEND AUDIOSERVICE_CORE_SOURCES src/ipc/UnixControlServer.cpp src/devices/PortableDeviceManager.cpp)
endif()

add_library(audioservice_core ${AUDIOSERVICE_CORE_SOURCES})
target_include_directories(audioservice_core PUBLIC src)
target_compile_definitions(audioservice_core PUBLIC $<$<BOOL:${AUDIOSERVICE_ENABLE_ASIO}>:AUDIOSERVICE_ENABLE_ASIO=1>)
if(WIN32)
    target_compile_definitions(audioservice_core PUBLIC NOMINMAX WIN32_LEAN_AND_MEAN)
endif()

function(audioservice_apply_warnings target)
    if(MSVC)
        target_compile_options(${target} PRIVATE /W4 /permissive- /EHsc)
        if(AUDIOSERVICE_WARNINGS_AS_ERRORS)
            target_compile_options(${target} PRIVATE /WX)
        endif()
        if(AUDIOSERVICE_ENABLE_MSVC_ANALYSIS)
            target_compile_options(${target} PRIVATE /analyze)
        endif()
    else()
        target_compile_options(${target} PRIVATE -Wall -Wextra -Wpedantic -Wconversion -Wsign-conversion)
        if(AUDIOSERVICE_WARNINGS_AS_ERRORS)
            target_compile_options(${target} PRIVATE -Werror)
        endif()
    endif()
endfunction()

audioservice_apply_warnings(audioservice_core)

if(WIN32)
    target_link_libraries(audioservice_core PRIVATE ole32 avrt winmm ws2_32 mfplat mfreadwrite mfuuid propsys)
endif()

find_package(Threads REQUIRED)
target_link_libraries(audioservice_core PRIVATE Threads::Threads)
target_link_libraries(audioservice_core PRIVATE opus)

add_executable(AudioService src/app/main.cpp)
target_link_libraries(AudioService PRIVATE audioservice_core)
audioservice_apply_warnings(AudioService)

add_executable(AudioControl tools/audio-control.cpp)
target_link_libraries(AudioControl PRIVATE audioservice_core)
audioservice_apply_warnings(AudioControl)

if(AUDIOSERVICE_BUILD_TESTS)
    enable_testing()
    add_executable(audioservice_tests
        tests/main.cpp
        tests/RealtimeAllocationGuard.cpp
        tests/backend/FakeBackendTests.cpp
        tests/backend/WasapiPcmTests.cpp
        tests/backend/AsioSampleConversionTests.cpp
        tests/realtime/PcmRingBufferTests.cpp
        tests/clock/ClockTests.cpp
        tests/analysis/SignalTests.cpp
        tests/network/NetworkTests.cpp
        tests/media/MediaTests.cpp
        tests/recording/RecordingTests.cpp
        tests/dsp/DspTests.cpp
        tests/ipc/ProtocolTests.cpp
        tests/session/SessionTests.cpp
        tests/session/StateFuzzTests.cpp
        tests/diagnostics/DiagnosticsTests.cpp
    )
    target_include_directories(audioservice_tests PRIVATE tests)
    target_link_libraries(audioservice_tests PRIVATE audioservice_core)
    audioservice_apply_warnings(audioservice_tests)
    add_test(NAME audioservice_tests COMMAND audioservice_tests)
endif()

if(AUDIOSERVICE_BUILD_RELEASE_GATES)
    enable_testing()
    add_executable(audioservice_release_gates tests/release/ReleaseGateTests.cpp)
    target_link_libraries(audioservice_release_gates PRIVATE audioservice_core)
    audioservice_apply_warnings(audioservice_release_gates)
    add_test(NAME audioservice_release_gates COMMAND audioservice_release_gates)
    set_tests_properties(audioservice_release_gates PROPERTIES LABELS "release;repetition")
endif()
