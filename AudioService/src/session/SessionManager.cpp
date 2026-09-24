#include "session/SessionManager.hpp"

#include <algorithm>
#include <array>
#include <ranges>
#include <stdexcept>
#include <string>

namespace {
constexpr std::uint32_t TraceStateChange = 1;
}

SessionManager::SessionManager(std::unique_ptr<IAudioBackend> backend, RealtimeEngine& engine,
                               TraceBuffer& trace)
    : backend_(std::move(backend)), engine_(engine), trace_(trace) {
    if (!backend_)
        throw std::invalid_argument("backend is required");
}

void SessionManager::replaceBackend(std::unique_ptr<IAudioBackend> backend) {
    if (state_ != SessionState::Idle) {
        throw std::logic_error("backend can only be replaced while Idle");
    }
    if (!backend)
        throw std::invalid_argument("backend is required");
    backend_ = std::move(backend);
}

RequestedConfiguration
SessionManager::chooseSupported(RequestedConfiguration requested,
                                const AudioDeviceCapabilities& capabilities) const {
    const std::array requiredValues{
        capabilities.defaultSampleRateHz,
        capabilities.minPeriodFrames,
        capabilities.maxPeriodFrames,
        capabilities.defaultPeriodFrames,
        capabilities.fundamentalPeriodFrames,
        capabilities.inputChannels,
        capabilities.outputChannels,
    };
    if (capabilities.sampleRatesHz.empty() ||
        std::ranges::find(requiredValues, 0U) != requiredValues.end() ||
        capabilities.minPeriodFrames > capabilities.defaultPeriodFrames ||
        capabilities.defaultPeriodFrames > capabilities.maxPeriodFrames) {
        throw std::runtime_error("backend returned incomplete device capabilities");
    }
    const auto requestedRate = std::ranges::find(capabilities.sampleRatesHz, requested.sampleRateHz);
    if (requestedRate == capabilities.sampleRatesHz.end()) {
        const auto systemRate = std::ranges::find(capabilities.sampleRatesHz,
                                                  capabilities.defaultSampleRateHz);
        requested.sampleRateHz = systemRate != capabilities.sampleRatesHz.end()
                                     ? *systemRate
                                     : (capabilities.sampleRatesHz.empty()
                                            ? capabilities.defaultSampleRateHz
                                            : capabilities.sampleRatesHz.front());
    }
    const auto fundamental = std::max(1U, capabilities.fundamentalPeriodFrames);
    const auto periodInRange = requested.periodFrames >= capabilities.minPeriodFrames &&
                               requested.periodFrames <= capabilities.maxPeriodFrames;
    const auto periodAligned =
        periodInRange && ((requested.periodFrames - capabilities.minPeriodFrames) % fundamental == 0);
    const auto explicitPeriodSupported =
        capabilities.periodFrames.empty() ||
        std::ranges::find(capabilities.periodFrames, requested.periodFrames) !=
            capabilities.periodFrames.end();
    if (!periodAligned || !explicitPeriodSupported) {
        requested.periodFrames = std::clamp(capabilities.defaultPeriodFrames,
                                            capabilities.minPeriodFrames,
                                            capabilities.maxPeriodFrames);
    }
    const auto supportedChannels = [](std::uint32_t requestedChannels,
                                      std::uint32_t deviceChannels) {
        const auto selected = requestedChannels == 0
                                  ? deviceChannels
                                  : std::min(requestedChannels, deviceChannels);
        return std::min(selected, MaxAudioChannels);
    };
    requested.inputChannels = supportedChannels(requested.inputChannels,
                                                capabilities.inputChannels);
    requested.outputChannels = supportedChannels(requested.outputChannels,
                                                 capabilities.outputChannels);
    return requested;
}

FinalSessionPlan SessionManager::buildPlan(const RuntimeConfiguration& runtime) const {
    const std::array requiredValues{runtime.inputSampleRateHz, runtime.outputSampleRateHz,
                                    runtime.inputPeriodFrames, runtime.outputPeriodFrames,
                                    runtime.inputChannels,     runtime.outputChannels};
    if (std::ranges::find(requiredValues, 0U) != requiredValues.end()) {
        throw std::runtime_error("backend returned invalid RuntimeConfiguration");
    }

    const auto maxBlock = std::min(
        MaxBlockFrames, std::max(runtime.inputPeriodFrames, runtime.outputPeriodFrames) * 4U);
    const auto independent = runtime.clockRelationship == ClockRelationship::Independent ||
                             runtime.inputSampleRateHz != runtime.outputSampleRateHz;
    const auto target = std::max(runtime.inputPeriodFrames, runtime.outputPeriodFrames);
    return {runtime.inputSampleRateHz,
            runtime.outputSampleRateHz,
            maxBlock,
            runtime.inputChannels,
            runtime.outputChannels,
            runtime.inputSampleRateHz != runtime.outputSampleRateHz,
            independent,
            std::max(target * 8U, maxBlock * 2U),
            target};
}

RuntimeConfiguration SessionManager::prepare(RequestedConfiguration requested) {
    if (state_ != SessionState::Idle) {
        throw std::logic_error("Session must be Idle before prepare");
    }
    setState(SessionState::Opening);
    try {
        const auto capabilities = backend_->queryCapabilities(requested);
        capabilities_ = capabilities;
        requested_ = chooseSupported(std::move(requested), capabilities);
        runtime_ = backend_->open(requested_);
        plan_ = buildPlan(runtime_);
        ++generationId_;
        engine_.prepare(plan_, generationId_);
        lastFailure_ = {};
        setState(SessionState::Prepared);
        return runtime_;
    } catch (const std::exception& error) {
        setFailure(FailureCategory::Backend, FailureSeverity::SessionFatal, 0, error.what());
        backend_->close();
        runtime_ = {};
        plan_ = {};
        capabilities_.reset();
        setState(SessionState::Failed);
        throw;
    } catch (...) {
        setFailure(FailureCategory::Unknown, FailureSeverity::SessionFatal, 0,
                   "non-standard exception while preparing session");
        backend_->close();
        runtime_ = {};
        plan_ = {};
        capabilities_.reset();
        setState(SessionState::Failed);
        throw;
    }
}

void SessionManager::start() {
    if (state_ != SessionState::Prepared) {
        throw std::logic_error("Session must be Prepared before start");
    }
    setState(SessionState::Starting);
    try {
        backend_->start(engine_, generationId_);
        setState(SessionState::Running);
    } catch (const std::exception& error) {
        setFailure(FailureCategory::Backend, FailureSeverity::SessionFatal, 0, error.what());
        backend_->close();
        invalidateGeneration();
        setState(SessionState::Failed);
        throw;
    } catch (...) {
        setFailure(FailureCategory::Unknown, FailureSeverity::SessionFatal, 0,
                   "non-standard exception while starting session");
        backend_->close();
        invalidateGeneration();
        setState(SessionState::Failed);
        throw;
    }
}

void SessionManager::invalidateGeneration() noexcept {
    ++generationId_;
    engine_.invalidate(generationId_);
}

void SessionManager::stop() noexcept {
    constexpr std::array noOpStates{SessionState::Idle, SessionState::Stopping};
    if (std::ranges::find(noOpStates, state_) != noOpStates.end())
        return;

    setState(SessionState::Stopping);
    invalidateGeneration();
    backend_->stop();
    backend_->close();
    engine_.reset();
    runtime_ = {};
    plan_ = {};
    capabilities_.reset();
    setState(SessionState::Idle);
}

RuntimeConfiguration SessionManager::reconfigure(RequestedConfiguration requested) {
    const auto wasRunning = state_ == SessionState::Running;
    stop();
    auto runtime = prepare(std::move(requested));
    if (wasRunning)
        start();
    return runtime;
}

bool SessionManager::recover() {
    if (requested_.sampleRateHz == 0)
        return false;
    const auto request = requested_;
    constexpr std::array restartStates{SessionState::Running, SessionState::Failed,
                                       SessionState::Recovering};
    const auto shouldStart = std::ranges::find(restartStates, state_) != restartStates.end();

    setState(SessionState::Recovering);
    invalidateGeneration();
    backend_->stop();
    backend_->close();
    runtime_ = {};
    plan_ = {};
    try {
        state_ = SessionState::Idle;
        prepare(request);
        if (shouldStart)
            start();
        return true;
    } catch (const std::exception& error) {
        setFailure(FailureCategory::Backend, FailureSeverity::SessionFatal, 0, error.what());
        setState(SessionState::Failed);
        return false;
    } catch (...) {
        setFailure(FailureCategory::Unknown, FailureSeverity::SessionFatal, 0,
                   "non-standard exception during recovery");
        setState(SessionState::Failed);
        return false;
    }
}

void SessionManager::suspend() noexcept {
    wasRunningBeforeSuspend_ = state_ == SessionState::Running;
    if (state_ != SessionState::Idle) {
        invalidateGeneration();
        backend_->stop();
        backend_->close();
        engine_.reset();
    }
    setState(SessionState::Suspended);
}

bool SessionManager::resume() {
    if (state_ != SessionState::Suspended)
        return false;
    const auto request = requested_;
    state_ = SessionState::Idle;
    try {
        prepare(request);
        if (wasRunningBeforeSuspend_)
            start();
        return true;
    } catch (const std::exception& error) {
        setFailure(FailureCategory::Backend, FailureSeverity::SessionFatal, 0, error.what());
        setState(SessionState::Failed);
        return false;
    } catch (...) {
        setFailure(FailureCategory::Unknown, FailureSeverity::SessionFatal, 0,
                   "non-standard exception during resume");
        setState(SessionState::Failed);
        return false;
    }
}

void SessionManager::setFailure(FailureCategory category, FailureSeverity severity,
                                std::int32_t code, std::string message) {
    lastFailure_ = {category, severity, code, std::move(message)};
}

void SessionManager::setState(SessionState state) noexcept {
    state_ = state;
    trace_.push({monotonicTicksNow(), engine_.sessionFrame(), generationId_, TraceStateChange,
                 static_cast<std::uint32_t>(state)});
}
