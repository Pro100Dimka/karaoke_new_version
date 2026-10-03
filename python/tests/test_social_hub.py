from __future__ import annotations

import asyncio

from backend.infrastructure.social_hub import SocialHub


class _Socket:
    def __init__(self) -> None:
        self.messages: list[object] = []
        self.received = asyncio.Event()

    async def send_json(self, data: object) -> None:
        self.messages.append(data)
        self.received.set()


def test_voice_levels_are_pushed_only_to_open_apps_in_the_room() -> None:
    async def scenario() -> None:
        hub = SocialHub()
        hub.start(lambda _account: {"type": "inbox"})
        in_room, elsewhere = _Socket(), _Socket()
        hub.connect("anna", in_room)
        hub.connect("boris", elsewhere)
        hub.set_room("anna", "room-a")
        hub.set_room("boris", "room-b")

        hub.broadcast_room("room-a", {"type": "voiceLevels", "roomId": "room-a", "levels": {"anna": 0.7}})
        await asyncio.wait_for(in_room.received.wait(), timeout=1)

        assert in_room.messages == [
            {"type": "voiceLevels", "roomId": "room-a", "levels": {"anna": 0.7}}
        ]
        assert elsewhere.messages == []

    asyncio.run(scenario())
