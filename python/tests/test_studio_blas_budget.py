from concurrent.futures import ThreadPoolExecutor
import threading

from threadpoolctl import threadpool_info

from backend.recordings.studio_parallel import render_execution


def _blas_threads():
    return {
        item["filepath"]: item["num_threads"]
        for item in threadpool_info()
        if item["user_api"] == "blas"
    }


def test_render_uses_one_native_blas_thread_per_worker_and_restores_settings():
    before = _blas_threads()
    assert before
    with render_execution(threading.Event(), workers=2):
        assert set(_blas_threads().values()) == {1}
    assert _blas_threads() == before


def test_overlapping_render_scopes_restore_only_after_the_last_render_exits():
    before = _blas_threads()
    ready, release = threading.Event(), threading.Event()

    def second():
        with render_execution(threading.Event(), workers=1):
            ready.set()
            assert release.wait(3)
            assert set(_blas_threads().values()) == {1}

    with ThreadPoolExecutor(max_workers=1) as pool:
        with render_execution(threading.Event(), workers=1):
            future = pool.submit(second)
            assert ready.wait(3)
        assert set(_blas_threads().values()) == {1}
        release.set()
        future.result(timeout=3)
    assert _blas_threads() == before
