from __future__ import annotations

from concurrent.futures import ThreadPoolExecutor
from contextlib import contextmanager
from pathlib import Path
from threading import Event, Lock

import dotenv.main
import pytest
from dotenv import dotenv_values


@pytest.mark.parametrize("existing", [False, True])
def test_parallel_environment_requests_preserve_both_saved_keys(
    client, tmp_path: Path, monkeypatch: pytest.MonkeyPatch, existing: bool
) -> None:
    target = tmp_path / "python.env"
    monkeypatch.setenv("AD_VOICE_ENV_FILE", str(target))
    if existing:
        target.write_text("KEEP_ME=unchanged\n", encoding="utf-8")
    original_rewrite = dotenv.main.rewrite
    opened = Event()
    second_started = Event()
    second_opened = Event()
    resume = Event()
    guard = Lock()
    calls = 0

    @contextmanager
    def interleaved_rewrite(path, *args, **kwargs):
        nonlocal calls
        with original_rewrite(path, *args, **kwargs) as streams:
            with guard:
                calls += 1
                first = calls == 1
            if first:
                opened.set()
                assert resume.wait(10), "first ENV writer was never released"
            else:
                second_opened.set()
            yield streams

    monkeypatch.setattr(dotenv.main, "rewrite", interleaved_rewrite)

    def save_second():
        second_started.set()
        return client.patch(
            "/settings/environment/AD_VOICE_YOUTUBE_API_KEY", json={"value": "youtube-test-value"}
        )

    with ThreadPoolExecutor(max_workers=2) as pool:
        first = pool.submit(
            client.patch,
            "/settings/environment/AD_VOICE_AUDD_TOKEN",
            json={"value": "audd-test-value"},
        )
        try:
            assert opened.wait(10), "first request did not open its ENV snapshot"
            second = pool.submit(save_second)
            assert second_started.wait(10)
            # An unguarded writer opens the old snapshot here. A serialized writer
            # remains outside the rewrite until the first request is released.
            second_opened.wait(1)
        finally:
            resume.set()
        responses = (first.result(timeout=10), second.result(timeout=10))

    assert all(response.status_code == 200 for response in responses)
    assert all(response.json()["configured"] for response in responses)
    assert all(response.json()["value"] == "" for response in responses)
    values = dotenv_values(target)
    assert values["AD_VOICE_AUDD_TOKEN"] == "audd-test-value"
    assert values["AD_VOICE_YOUTUBE_API_KEY"] == "youtube-test-value"
    if existing:
        assert values["KEEP_ME"] == "unchanged"
