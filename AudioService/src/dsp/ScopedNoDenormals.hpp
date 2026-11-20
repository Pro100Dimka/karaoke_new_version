#pragma once

#if defined(_M_X64) || defined(__x86_64__)
#include <xmmintrin.h>
#endif

// Recursive filters can otherwise retain inaudible subnormal tails indefinitely. Keep the
// x64 FTZ/DAZ mode local to audio processing, including callbacks on driver-owned threads.
class ScopedNoDenormals {
  public:
    ScopedNoDenormals() noexcept {
#if defined(_M_X64) || defined(__x86_64__)
        previousMode_ = _mm_getcsr();
        _mm_setcsr(previousMode_ | FlushModes);
#endif
    }
    ~ScopedNoDenormals() noexcept {
#if defined(_M_X64) || defined(__x86_64__)
        _mm_setcsr(previousMode_);
#endif
    }
    ScopedNoDenormals(const ScopedNoDenormals&) = delete;
    ScopedNoDenormals& operator=(const ScopedNoDenormals&) = delete;

  private:
#if defined(_M_X64) || defined(__x86_64__)
    static constexpr unsigned FlushModes = (1U << 15U) | (1U << 6U);
    unsigned previousMode_{0};
#endif
};
