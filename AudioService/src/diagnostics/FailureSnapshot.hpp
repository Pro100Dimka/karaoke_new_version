#pragma once

#include "backend/IAudioBackend.hpp"
#include "common/Types.hpp"

#include <cstdint>

struct FailureSnapshot {
    bool valid{false};
    FailureInfo failure{};
    GenerationId generationId{0};
    BackendKind backend{BackendKind::Fake};
    RequestedConfiguration requested{};
    RuntimeConfiguration runtime{};
    FinalSessionPlan plan{};
    BackendSnapshot backendState{};
    SessionFrame sessionFrame{0};
    std::uint32_t clockBridgeFillFrames{0};
    double driftPpm{0.0};
    double correctionRatio{1.0};
    std::uint32_t recordingQueueFillFrames{0};
    std::uint32_t networkSendQueueFillFrames{0};
    std::uint32_t networkReceiveQueueFillFrames{0};
};
