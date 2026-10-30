from __future__ import annotations

import logging
import threading
import uuid
from collections.abc import Iterator
from concurrent.futures import Future
from contextlib import contextmanager

import httpx
from gradio_client import Client
from gradio_client.exceptions import (
    AppError,
    AuthenticationError,
    SerializationSetupError,
    ValidationError as GradioValidationError,
)

CLIENT_ERRORS = (
    AppError,
    AuthenticationError,
    GradioValidationError,
    SerializationSetupError,
    httpx.HTTPError,
    OSError,
    RuntimeError,
    ValueError,
)
AlignmentScopes = dict[threading.Event, tuple[str, dict[str, Client]]]
logger = logging.getLogger(__name__)


@contextmanager
def alignment_scope(
    scopes: AlignmentScopes, lock: threading.Lock, cancel: threading.Event
) -> Iterator[None]:
    scope, clients = uuid.uuid4().hex, dict[str, Client]()
    with lock:
        scopes[cancel] = scope, clients
    try:
        yield
    finally:
        with lock:
            scopes.pop(cancel)
        for session, client in clients.items():
            try:
                # Cleanup uses the existing connection and queues behind active alignment.
                # It must neither restart a notebook nor delay cancellation.
                job = client.submit(session, scope, api_name="/release_alignment")
                job.add_done_callback(_cleanup_done)
            except CLIENT_ERRORS as error:
                logger.warning("Kaggle alignment cleanup failed: %s", type(error).__name__)


def _cleanup_done(job: Future[object]) -> None:
    if job.cancelled():
        logger.warning("Kaggle alignment cleanup was cancelled")
    elif (error := job.exception()) is not None:
        logger.warning("Kaggle alignment cleanup failed: %s", type(error).__name__)
