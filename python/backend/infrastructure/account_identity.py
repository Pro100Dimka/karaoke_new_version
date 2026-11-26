"""Keep account access across reinstalls, migrating through the existing account-transfer API."""

from __future__ import annotations

import hashlib
import re
import secrets
import sys
import urllib.request
from urllib.parse import urlsplit

from backend.infrastructure.windows_credentials import WindowsCredentials
from backend.serialization import dumps, loads_object
from backend.infrastructure.transfer_consent import CONSENT_VERSION, PURPOSES


class _NoRedirect(urllib.request.HTTPRedirectHandler):
    def redirect_request(self, *args: object, **kwargs: object) -> None:
        raise ValueError("Account requests must not redirect")


def _choice(server: str, secret: str, purpose: str, enabled: bool) -> None:
    request = urllib.request.Request(
        f"{server}/social/privacy/{purpose}",
        method="PUT",
        data=dumps({"enabled": enabled, "version": CONSENT_VERSION}).encode(),
        headers={"X-AD-Voice-Device": secret, "Content-Type": "application/json"},
    )
    with urllib.request.build_opener(_NoRedirect()).open(request, timeout=10):
        pass


def _request(
    server: str, secret: str, code: str | None = None, consents: tuple[str, ...] = ()
) -> dict[str, str]:
    for purpose in consents:
        _choice(server, secret, purpose, True)
    data = None if code is None else dumps({"transferCode": code}).encode()
    request = urllib.request.Request(
        f"{server}/social/{'me' if code is None else 'transfer'}",
        data=data,
        headers={"X-AD-Voice-Device": secret, "Content-Type": "application/json"},
    )
    with urllib.request.build_opener(_NoRedirect()).open(request, timeout=10) as response:
        value = loads_object(response.read(65537).decode("utf-8"))
    if not all(
        isinstance(value.get(key), str) and value[key] for key in ["accountId", "transferCode"]
    ):
        raise ValueError("Invalid account response")
    return {"accountId": value["accountId"], "transferCode": value["transferCode"]}


def account_identity(
    server: str,
    profile: str,
    legacy_secret: str,
    action: str = "read",
    consents: tuple[str, ...] = (),
) -> dict[str, object]:
    url = urlsplit(server)
    if (
        url.scheme not in ["https", "http"]
        or (url.scheme == "http" and url.hostname not in ["localhost", "127.0.0.1", "::1"])
        or url.username is not None
        or url.password is not None
        or url.path not in ["", "/"]
        or url.query
        or url.fragment
    ):
        raise ValueError("Account migration requires a secure server origin")
    server = server.rstrip("/")
    scope = hashlib.sha256(f"{server}\n{profile}".encode()).hexdigest()
    credentials = WindowsCredentials(f"ADVoice.Account.v1/{scope}")
    with credentials.locked():
        if action in ["disable", "create"]:
            credentials.write(
                dumps({"secret": secrets.token_hex(32), "disabled": action == "disable"})
            )
        elif action not in ["read", "existing", "local"]:
            raise ValueError("Invalid account identity action")
        saved = credentials.read()
        if saved is None:
            if action == "local":
                record = {"secret": secrets.token_hex(32), "legacy": legacy_secret}
                credentials.write(dumps(record))
                return {"secret": record["secret"], "enabled": True}
            if action == "existing":
                raise ValueError("An existing online account is required")
            # Read the previous account before publishing any replacement identity. Offline
            # first launches retry later, instead of silently creating an unrelated account.
            previous = _request(server, legacy_secret, consents=consents)
            record = {"secret": secrets.token_hex(32), "legacy": legacy_secret, **previous}
            credentials.write(dumps(record))
        else:
            record = loads_object(saved)
        secret = record.get("secret")
        if not isinstance(secret, str) or re.fullmatch(r"[a-f0-9]{64}", secret) is None:
            raise ValueError("Invalid stored account credential")
        if (
            "legacy" in record
            and "transferCode" not in record
            and action not in ["local", "existing"]
        ):
            previous_secret = record["legacy"]
            if not isinstance(previous_secret, str):
                raise ValueError("Invalid pending account migration")
            record = {
                "secret": secret,
                "legacy": previous_secret,
                **_request(server, previous_secret, consents=consents),
            }
            credentials.write(dumps(record))
        if action == "existing" and any(key in record for key in ["legacy", "transferCode"]):
            raise ValueError("Complete the account migration in the application first")
        if "transferCode" in record and action != "local":
            account_id, code = record.get("accountId"), record["transferCode"]
            if not isinstance(account_id, str) or not isinstance(code, str):
                raise ValueError("Invalid pending account migration")
            # A prior transfer may have succeeded before its response or final local write
            # was lost. Check ownership first: transfer codes rotate after every transfer.
            current = _request(server, secret, consents=consents)
            if current["accountId"] != account_id:
                current = _request(server, secret, code, consents)
            if current["accountId"] != account_id:
                raise ValueError("Account migration did not preserve the account")
            if isinstance(record.get("legacy"), str):
                _choice(server, record["legacy"], "online", False)
            credentials.write(dumps({"secret": secret}))
        return {"secret": secret, "enabled": record.get("disabled") is not True}


def account_secret(server: str, profile: str, legacy_secret: str) -> str:
    return str(account_identity(server, profile, legacy_secret)["secret"])


if __name__ == "__main__":
    try:
        arguments = loads_object(sys.stdin.read(8192))
        if not all(
            isinstance(arguments.get(key), str) for key in ["server", "profile", "legacySecret"]
        ):
            raise ValueError("Invalid identity request")
        print(
            dumps(
                account_identity(
                    arguments["server"],
                    arguments["profile"],
                    arguments["legacySecret"],
                    str(arguments.get("action", "read")),
                    tuple(
                        purpose
                        for purpose in PURPOSES
                        if purpose in arguments.get("consents", [])
                        and arguments.get("consentVersion") == CONSENT_VERSION
                    ),
                )
            )
        )
    except Exception:
        # The caller receives only a generic error, never credentials or HTTP response bodies.
        sys.stderr.write("Windows account identity is unavailable\n")
        sys.exit(1)
