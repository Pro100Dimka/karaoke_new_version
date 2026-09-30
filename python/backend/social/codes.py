from __future__ import annotations

import hashlib
import secrets

# Letters and digits that cannot be misread for one another when a code is read aloud or retyped.
_ALPHABET = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789"
_GROUP = 4
_FRIEND_CODE_GROUPS = 2  # 40 bits: shared openly, only ever used to send a friend request
_TRANSFER_CODE_GROUPS = 5  # 100 bits: takes the whole account to another computer


def _code(groups: int) -> str:
    return "-".join(
        "".join(secrets.choice(_ALPHABET) for _ in range(_GROUP)) for _ in range(groups)
    )


def new_friend_code() -> str:
    return _code(_FRIEND_CODE_GROUPS)


def new_transfer_code() -> str:
    return _code(_TRANSFER_CODE_GROUPS)


def normalize_code(value: str) -> str:
    """The canonical spelling of a typed code: any case, spaces or dashes."""
    letters = "".join(character for character in value.upper() if character.isalnum())
    return "-".join(letters[start : start + _GROUP] for start in range(0, len(letters), _GROUP))


def device_key(device_secret: str) -> str:
    """What the server keeps of a computer's secret: enough to recognise it, never to send it."""
    return hashlib.sha256(device_secret.encode()).hexdigest()
