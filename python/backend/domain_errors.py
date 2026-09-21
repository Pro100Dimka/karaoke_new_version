from __future__ import annotations

from dataclasses import dataclass, field
from typing import Mapping


@dataclass(slots=True)
class DomainError(Exception):
    code: str
    message: str
    status_code: int = 400
    details: Mapping[str, object] = field(default_factory=dict)

    def __str__(self) -> str:
        return self.message


class NotFoundError(DomainError):
    def __init__(self, code: str, message: str, **details: object) -> None:
        super().__init__(code, message, 404, details)


class ConflictError(DomainError):
    def __init__(self, code: str, message: str, **details: object) -> None:
        super().__init__(code, message, 409, details)


class ForbiddenError(DomainError):
    def __init__(self, code: str, message: str, **details: object) -> None:
        super().__init__(code, message, 403, details)


class DependencyError(DomainError):
    def __init__(self, code: str, message: str, **details: object) -> None:
        super().__init__(code, message, 503, details)
