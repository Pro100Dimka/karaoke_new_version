from __future__ import annotations

from collections.abc import Callable
from dataclasses import dataclass
from typing import Generic, TypeVar

from backend.persistence import UnitOfWork, UnitOfWorkFactory

_T = TypeVar("_T")


@dataclass(frozen=True)
class RepositoryCase(Generic[_T]):
    name: str
    add: Callable[[UnitOfWork, _T], None]
    get: Callable[[UnitOfWork], _T | None]
    updated: _T | None = None
    update: Callable[[UnitOfWork, _T], None] | None = None
    delete: Callable[[UnitOfWork], None] | None = None


def assert_repository_contract(
    factory: UnitOfWorkFactory,
    case: RepositoryCase[_T],
    entity: _T,
) -> None:
    with factory.create() as transaction:
        assert case.get(transaction) is None
        case.add(transaction, entity)

    with factory.create() as transaction:
        assert case.get(transaction) is None
        case.add(transaction, entity)
        transaction.commit()

    with factory.create() as transaction:
        assert case.get(transaction) == entity

    if case.update and case.updated is not None:
        with factory.create() as transaction:
            case.update(transaction, case.updated)
            transaction.commit()
        with factory.create() as transaction:
            assert case.get(transaction) == case.updated

    if case.delete:
        with factory.create() as transaction:
            case.delete(transaction)
            transaction.commit()
        with factory.create() as transaction:
            assert case.get(transaction) is None
