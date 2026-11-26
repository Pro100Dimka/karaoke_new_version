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


class _NoRedirect(urllib.request.HTTPRedirectHandler):
    def redirect_request(self, *args: object, **kwargs: object) -> None:
        raise ValueError("Account requests must not redirect")


def _request(server: str, secret: str, code: str | None = None) -> dict[str, str]:
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


def account_secret(server: str, profile: str, legacy_secret: str) -> str:
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
        saved = credentials.read()
        if saved is None:
            # Read the previous account before publishing any replacement identity. Offline
            # first launches retry later, instead of silently creating an unrelated account.
            previous = _request(server, legacy_secret)
            record = {"secret": secrets.token_hex(32), **previous}
            credentials.write(dumps(record))
        else:
            record = loads_object(saved)
        secret = record.get("secret")
        if not isinstance(secret, str) or re.fullmatch(r"[a-f0-9]{64}", secret) is None:
            raise ValueError("Invalid stored account credential")
        if "transferCode" in record:
            account_id, code = record.get("accountId"), record["transferCode"]
            if not isinstance(account_id, str) or not isinstance(code, str):
                raise ValueError("Invalid pending account migration")
            # A prior transfer may have succeeded before its response or final local write
            # was lost. Check ownership first: transfer codes rotate after every transfer.
            current = _request(server, secret)
            if current["accountId"] != account_id:
                current = _request(server, secret, code)
            if current["accountId"] != account_id:
                raise ValueError("Account migration did not preserve the account")
            credentials.write(dumps({"secret": secret}))
        return secret


if __name__ == "__main__":
    try:
        arguments = loads_object(sys.stdin.read(8192))
        if not all(
            isinstance(arguments.get(key), str) for key in ["server", "profile", "legacySecret"]
        ):
            raise ValueError("Invalid identity request")
        print(account_secret(arguments["server"], arguments["profile"], arguments["legacySecret"]))
    except Exception:
        # The caller receives only a generic error, never credentials or HTTP response bodies.
        sys.stderr.write("Windows account identity is unavailable\n")
        sys.exit(1)
