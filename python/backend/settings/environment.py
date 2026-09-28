from __future__ import annotations

import os
import re
from dataclasses import dataclass
from pathlib import Path
from typing import Literal
from urllib.parse import urlparse

import httpx
from dotenv import dotenv_values, set_key

EnvironmentState = Literal["empty", "valid", "invalid", "unverified"]
EnvironmentKind = Literal["text", "secret", "file", "url", "port"]


@dataclass(frozen=True, slots=True)
class EnvironmentDefinition:
    key: str
    group: str
    kind: EnvironmentKind
    source: Literal["project", "python", "frontend"]


@dataclass(frozen=True, slots=True)
class EnvironmentEntry:
    key: str
    group: str
    kind: EnvironmentKind
    value: str
    configured: bool
    state: EnvironmentState
    message: str


_definitions = (
    EnvironmentDefinition("AD_VOICE_AUDD_TOKEN", "recognition", "secret", "python"),
    EnvironmentDefinition("AD_VOICE_YOUTUBE_API_KEY", "recognition", "secret", "python"),
    EnvironmentDefinition("AD_VOICE_ROOM_SERVER_HOST", "room", "text", "frontend"),
    EnvironmentDefinition("AD_VOICE_ROOM_SERVER_PORT", "room", "port", "frontend"),
    EnvironmentDefinition("AD_VOICE_ROOM_SERVER_RELAY_PORT", "room", "port", "frontend"),
    EnvironmentDefinition("AD_VOICE_ROOM_SERVER_SSH_KEY", "deployment", "file", "project"),
    EnvironmentDefinition("AD_VOICE_ROOM_SERVER_KNOWN_HOSTS", "deployment", "file", "project"),
    EnvironmentDefinition("AD_VOICE_ROOM_SERVER_SSH_USER", "deployment", "text", "project"),
)
def default_environment_store() -> "EnvironmentSettingsStore":
    project_root = Path(__file__).parents[3]
    secret_root = project_root / "local-secrets" / "env"
    project = Path(os.getenv("AD_VOICE_PROJECT_ENV_FILE") or secret_root / "project.env")
    python = Path(os.getenv("AD_VOICE_ENV_FILE") or secret_root / "python.env")
    frontend = project_root / "frontend" / ".env.local"
    return EnvironmentSettingsStore(
        project,
        python,
        frontend_file=frontend,
        default_values={
            "AD_VOICE_ROOM_SERVER_HOST": "130.61.169.61",
            "AD_VOICE_ROOM_SERVER_PORT": "8081",
            "AD_VOICE_ROOM_SERVER_RELAY_PORT": "40000",
            "AD_VOICE_ROOM_SERVER_SSH_KEY": str(project_root / "local-secrets" / "ssh" / "karaoke_room_server"),
            "AD_VOICE_ROOM_SERVER_KNOWN_HOSTS": str(project_root / "local-secrets" / "ssh" / "known_hosts"),
            "AD_VOICE_ROOM_SERVER_SSH_USER": "ubuntu",
        },
    )


class EnvironmentSettingsStore:
    def __init__(
        self,
        project_file: Path,
        python_file: Path,
        transport: httpx.BaseTransport | None = None,
        frontend_file: Path | None = None,
        default_values: dict[str, str] | None = None,
    ) -> None:
        self._files = {
            "project": project_file,
            "python": python_file,
            "frontend": frontend_file or project_file,
        }
        self._transport = transport
        self._default_values = default_values or {}

    def read(self) -> list[EnvironmentEntry]:
        values = self._values()
        return [self._entry(item, values.get(item.key, ""), values) for item in _definitions]

    def save(self, key: str, value: str) -> EnvironmentEntry:
        definition = _definition(key)
        target = self._files[definition.source]
        target.parent.mkdir(parents=True, exist_ok=True)
        if not target.exists():
            target.touch()
        set_key(target, key, value, quote_mode="auto")
        values = self._values()
        return self._entry(definition, values.get(key, ""), values)

    def verify(self, key: str) -> EnvironmentEntry:
        definition = _definition(key)
        values = self._values()
        value = values.get(key, "").strip()
        entry = self._entry(definition, value, values)
        if entry.state in {"empty", "invalid"}:
            return entry
        try:
            state, message = self._verify_remote(definition, value, values)
        except (httpx.HTTPError, OSError, ValueError) as error:
            state, message = "invalid", f"Verification failed: {error}"
        return EnvironmentEntry(
            key=entry.key,
            group=entry.group,
            kind=entry.kind,
            value=entry.value,
            configured=entry.configured,
            state=state,
            message=message,
        )

    def _verify_remote(
        self,
        definition: EnvironmentDefinition,
        value: str,
        values: dict[str, str],
    ) -> tuple[EnvironmentState, str]:
        if definition.key == "AD_VOICE_AUDD_TOKEN":
            with httpx.Client(transport=self._transport, timeout=8) as client:
                response = client.post("https://api.audd.io/", data={"api_token": value})
            payload = response.json()
            error_code = (payload.get("error") or {}).get("error_code")
            if error_code in {900, 901}:
                return "invalid", "AudD rejected this token"
            return "valid", "AudD accepted this token"
        if definition.key == "AD_VOICE_YOUTUBE_API_KEY":
            with httpx.Client(transport=self._transport, timeout=8) as client:
                response = client.get(
                    "https://www.googleapis.com/youtube/v3/videos",
                    params={"part": "id", "id": "dQw4w9WgXcQ", "key": value},
                )
            if response.is_success:
                return "valid", "YouTube accepted this API key"
            return "invalid", "YouTube rejected this API key or its quota is unavailable"
        if definition.key == "AD_VOICE_ROOM_SERVER":
            with httpx.Client(transport=self._transport, timeout=5) as client:
                response = client.get(f"{value.rstrip('/')}/health/ready")
            if response.is_success and response.json().get("ok") is True:
                return "valid", "Room Server is available"
            return "invalid", "Room Server did not pass its health check"
        return "valid", entry_message(definition)

    def _values(self) -> dict[str, str]:
        result: dict[str, str] = {}
        for target in self._files.values():
            if not target.is_file():
                continue
            result.update(
                (key, value or "")
                for key, value in dotenv_values(target).items()
                if isinstance(key, str)
            )
        legacy = result.get("AD_VOICE_ROOM_SERVER", "").strip()
        if legacy:
            parsed = urlparse(legacy)
            if parsed.hostname:
                result.setdefault("AD_VOICE_ROOM_SERVER_HOST", parsed.hostname)
                result.setdefault(
                    "AD_VOICE_ROOM_SERVER_PORT",
                    str(parsed.port or (443 if parsed.scheme == "https" else 80)),
                )
        return {**self._default_values, **result}

    @staticmethod
    def _entry(
        definition: EnvironmentDefinition, value: str, values: dict[str, str]
    ) -> EnvironmentEntry:
        state, message = _validate(definition, value.strip(), values)
        return EnvironmentEntry(
            key=definition.key,
            group=definition.group,
            kind=definition.kind,
            value=value,
            configured=bool(value.strip()),
            state=state,
            message=message,
        )


def _validate(
    definition: EnvironmentDefinition, value: str, values: dict[str, str]
) -> tuple[EnvironmentState, str]:
    if not value:
        return "empty", "Value is not configured"
    if definition.kind == "secret":
        return "unverified", "The key is saved; online verification is required"
    if definition.kind == "file":
        return _validate_file(definition.key, value, values)
    if definition.kind == "url":
        parsed = urlparse(value)
        if parsed.scheme not in {"http", "https"} or not parsed.hostname:
            return "invalid", "Enter a valid HTTP or HTTPS URL"
        return "unverified", "Address is saved; availability has not been checked"
    return _validate_scalar(definition, value)


def _validate_file(
    key: str, value: str, values: dict[str, str]
) -> tuple[EnvironmentState, str]:
    target = Path(value).expanduser()
    if not target.is_file():
        return "invalid", "File was not found"
    if key == "AD_VOICE_ROOM_SERVER_SSH_KEY":
        content = target.read_text(encoding="utf-8", errors="ignore")
        if "-----BEGIN " not in content or "PRIVATE KEY-----" not in content:
            return "invalid", "The selected file is not a private SSH key"
    if key == "AD_VOICE_ROOM_SERVER_KNOWN_HOSTS" and not target.read_text(
        encoding="utf-8", errors="ignore"
    ).strip():
        return "invalid", "known_hosts is empty"
    return "valid", "File is valid"


def _validate_scalar(
    definition: EnvironmentDefinition, value: str
) -> tuple[EnvironmentState, str]:
    invalid = {
        "AD_VOICE_ROOM_SERVER_PORT": not value.isdigit() or not 1 <= int(value) <= 65535,
        "AD_VOICE_ROOM_SERVER_RELAY_PORT": not value.isdigit() or not 1 <= int(value) <= 65535,
        "AD_VOICE_ROOM_SERVER_HOST": any(character.isspace() for character in value) or "://" in value,
        "AD_VOICE_ROOM_SERVER_SSH_USER": not re.fullmatch(r"[a-z_][a-z0-9_-]{0,31}", value),
    }.get(definition.key, False)
    messages = {
        "AD_VOICE_ROOM_SERVER_PORT": "Port must be between 1 and 65535",
        "AD_VOICE_ROOM_SERVER_RELAY_PORT": "Port must be between 1 and 65535",
        "AD_VOICE_ROOM_SERVER_HOST": "Enter a host name or IP address without a protocol",
        "AD_VOICE_ROOM_SERVER_SSH_USER": "Enter a valid SSH user name",
    }
    return ("invalid", messages[definition.key]) if invalid else ("valid", "Value is valid")


def _definition(key: str) -> EnvironmentDefinition:
    try:
        return next(item for item in _definitions if item.key == key)
    except StopIteration as error:
        raise ValueError(f"Unsupported environment key: {key}") from error


def entry_message(definition: EnvironmentDefinition) -> str:
    return "Value is valid"
