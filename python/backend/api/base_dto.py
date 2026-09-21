from __future__ import annotations

from pydantic import BaseModel, ConfigDict


def _camel(value: str) -> str:
    head, *tail = value.split("_")
    return head + "".join(part[:1].upper() + part[1:] for part in tail)


class ApiModel(BaseModel):
    model_config = ConfigDict(alias_generator=_camel, populate_by_name=True, extra="forbid")


class JobRefDto(ApiModel):
    job_id: str
    state: str
