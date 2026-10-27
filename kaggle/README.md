# Kaggle GPU backend

1. Open **Settings → Ключи ENV** and click **Войти в Kaggle**.
2. Confirm the official Kaggle OAuth page in the browser. A&D Voice then creates and starts a private `ad-voice-gpu` notebook with GPU and Internet enabled. The first run downloads about 1.5 GB of model weights.
3. Choose **Kaggle GPU** under **AI / Обработка**. The app discovers every current `https://…gradio.live` address automatically.

After updating A&D Voice, the next Kaggle processing job checks the worker revision. If it differs, the app publishes and starts the bundled worker in this installation's private notebook, then waits for its matching health response before uploading audio. This requires a connected Kaggle account and available GPU quota. Publishing an application release does not start users' notebooks. Releases with unchanged worker code reuse a matching running notebook.

Use **Развернуть и запустить** to start a fresh notebook version manually. Stop the Kaggle session when finished so idle time does not consume the weekly GPU quota. The public address can change whenever the server restarts; the notebook republishes it automatically, so no settings need to be rewritten. Audio is stored only in the temporary notebook session directory and is removed after six hours or when the Kaggle session ends.

## For maintainers

`release.bat` runs `kaggle/build_notebook.py` to embed the current worker and its transitive backend imports into the staged notebook. It includes package initializers and imports inside functions; backend imports must be absolute. The notebook runs these bundled sources without cloning a moving Git branch. A SHA-256 revision covers the embedded sources and executable notebook cells, including dependency installation commands. No user credentials enter this build step.

For development or manual notebook uploads, refresh the checked-in template after worker changes:

```powershell
python/.venv/Scripts/python.exe -B kaggle/build_notebook.py kaggle/ad_voice_p100.ipynb
```

Release generation writes only the staged copy; it does not modify the checkout. `python/tests/test_kaggle_notebook_discovery.py` verifies required embedded files against the working source when tests are requested.

The current remote protocol is **7** (`backend/infrastructure/kaggle_ai_provider.py`). Health must return the matching `protocolVersion`, `workerRevision`, and a non-empty `sessionGeneration`; a legacy worker without a revision is also replaced at the next processing job. Separation returns source-timed bass/kick/snare onsets for lyric motion. A local notebook build or a mocked health handshake does not prove a real remote job: verify a UI-initiated recalculation, its reported Kaggle backend, published revision and loaded result against the newly deployed worker before claiming remote processing works.

Alignment uses the same phrase/word guidance and sung-tail evidence as the local worker. Catalogue/ASR phrase bounds select phonetic cores; they do not cap sustained vowels. Accelerated CPU float32 Whisper is prepared for coverage/alignment guidance even when CTC runs on the GPU, with native Whisper fallback if that runtime cannot load.
