"""
The room voice wire protocol's timing invariants: the one authoritative definition.

Not a setting. Every client, both relays and the room timing policy must agree on them, so the C++
side reads them from a header generated from this module (scripts/audio_contract_codegen.py), and
a test fails when the generated header is out of date. Only the sample rate and the packet length
are defined; everything else is derived, so a different packet length moves its duration with it.
"""

from __future__ import annotations

from typing import Final

VOICE_SAMPLE_RATE_HZ: Final = 48_000
VOICE_PACKET_FRAMES: Final = 120

VOICE_PACKETS_PER_SECOND: Final = VOICE_SAMPLE_RATE_HZ // VOICE_PACKET_FRAMES
VOICE_PACKET_SECONDS: Final = VOICE_PACKET_FRAMES / VOICE_SAMPLE_RATE_HZ
VOICE_PACKET_MS: Final = VOICE_PACKET_SECONDS * 1_000.0

if VOICE_SAMPLE_RATE_HZ % VOICE_PACKET_FRAMES:
    raise ValueError("A voice packet must hold a whole number of packets per second")
