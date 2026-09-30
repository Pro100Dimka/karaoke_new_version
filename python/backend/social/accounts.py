from __future__ import annotations

from dataclasses import replace
from typing import Callable

from backend.domain_errors import DomainError, NotFoundError
from backend.runtime import Clock, IdGenerator
from backend.social.codes import device_key, new_friend_code, new_transfer_code, normalize_code
from backend.social.domain import Account
from backend.social.ports import AccountStore, VisitStore

# A profile photo is shown at most 256 px wide; the app sends it already reduced to that.
MAXIMUM_AVATAR_BYTES = 256 * 1024
_AVATAR_SIGNATURES = (
    ("image/png", bytes.fromhex("89504e470d0a1a0a")),
    ("image/jpeg", bytes.fromhex("ffd8ff")),
    ("image/webp", b"RIFF"),
)
_MAXIMUM_NAME_LENGTH = 64
_CODE_ATTEMPTS = 8


def _unique(new: Callable[[], str], taken: Callable[[str], Account | None]) -> str:
    for _ in range(_CODE_ATTEMPTS):
        code = new()
        if taken(code) is None:
            return code
    raise DomainError("CodeSpaceExhausted", "No free code was found", 503)


class Accounts:
    """Who is asking: one account per computer (and app profile), found again after a reinstall."""

    def __init__(
        self, store: AccountStore, visits: VisitStore, ids: IdGenerator, clock: Clock
    ) -> None:
        self._store = store
        self._visits = visits
        self._ids = ids
        self._clock = clock

    def identify(self, device_secret: str) -> Account:
        key = device_key(device_secret)
        known = self._store.by_device(key)
        if known is not None:
            return known
        account = Account(
            account_id=self._ids.new(),
            display_name="",
            friend_code=_unique(new_friend_code, self._store.by_friend_code),
            transfer_code=_unique(new_transfer_code, self._store.by_transfer_code),
            avatar_version=0,
            created_at=self._clock.now(),
        )
        self._store.add(account, key)
        return account

    def person(self, account_id: str) -> Account:
        account = self._store.by_id(account_id)
        if account is None:
            raise NotFoundError(
                "AccountNotFound", "This person was not found", accountId=account_id
            )
        return account

    def people(self, account_ids: tuple[str, ...]) -> tuple[Account, ...]:
        return self._store.by_ids(tuple(dict.fromkeys(account_ids)))

    def owners(self, participant_ids: tuple[str, ...]) -> dict[str, str]:
        """The account behind each room participant whose app said who it is."""
        return self._store.accounts_of_participants(participant_ids)

    def left(self, account: Account) -> Account:
        """The app closed: last seen now, in no room."""
        updated = replace(account, last_seen_at=self._clock.now(), room_id=None)
        self._store.save(updated)
        return updated

    def report_presence(
        self, account: Account, display_name: str, participant_id: str | None, room_id: str | None
    ) -> Account:
        """The app is open (and in `room_id`, as `participant_id`); keeps the profile name."""
        name = display_name.strip()[:_MAXIMUM_NAME_LENGTH] or account.display_name
        updated = replace(
            account, display_name=name, last_seen_at=self._clock.now(), room_id=room_id or None
        )
        self._store.save(updated)
        if participant_id:
            self._store.map_participant(participant_id, account.account_id)
            self._visits.claim_visits(participant_id, account.account_id)
        return updated

    def set_avatar(self, account: Account, mime: str, data: bytes) -> Account:
        if not any(
            mime == kind and data.startswith(signature) for kind, signature in _AVATAR_SIGNATURES
        ):
            raise DomainError("UnsupportedAvatar", "Photo must be a PNG, JPEG or WebP image")
        if len(data) > MAXIMUM_AVATAR_BYTES:
            raise DomainError(
                "AvatarTooLarge", "Photo is too large", 413, {"maximum": MAXIMUM_AVATAR_BYTES}
            )
        self._store.set_avatar(account.account_id, mime, data)
        updated = replace(account, avatar_version=account.avatar_version + 1)
        self._store.save(updated)
        return updated

    def clear_avatar(self, account: Account) -> Account:
        self._store.clear_avatar(account.account_id)
        updated = replace(account, avatar_version=account.avatar_version + 1)
        self._store.save(updated)
        return updated

    def avatar(self, account_id: str) -> tuple[str, bytes, int]:
        owner = self._store.by_id(account_id)
        photo = self._store.avatar(account_id)
        if owner is None or photo is None:
            raise NotFoundError("AvatarNotFound", "This person has no photo", accountId=account_id)
        return photo[0], photo[1], owner.avatar_version

    def claim(self, account: Account, transfer_code: str, device_secret: str) -> Account:
        """This computer takes over the account the code belongs to (moving to a new computer)."""
        target = self._store.by_transfer_code(normalize_code(transfer_code))
        if target is None:
            raise NotFoundError("TransferCodeNotFound", "No account has this transfer code")
        if target.account_id == account.account_id:
            return account
        self._store.move_device(device_key(device_secret), target.account_id)
        # The code was shown on another screen; once used it is replaced.
        moved = replace(
            target, transfer_code=_unique(new_transfer_code, self._store.by_transfer_code)
        )
        self._store.save(moved)
        return moved
