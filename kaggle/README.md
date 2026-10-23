# Kaggle GPU backend

1. Open **Settings → Ключи ENV** and click **Войти в Kaggle**.
2. Confirm the official Kaggle OAuth page in the browser. A&D Voice then creates and starts a private `ad-voice-gpu` notebook with GPU and Internet enabled. The first run downloads about 1.5 GB of model weights.
3. Choose **Kaggle GPU** under **AI / Обработка**. The app discovers every current `https://…gradio.live` address automatically.

Use **Развернуть и запустить** to start a fresh notebook version later. Stop the Kaggle session when finished so idle time does not consume the weekly GPU quota. The public address can change whenever the server restarts; the notebook republishes it automatically, so no settings need to be rewritten. Audio is stored only in the temporary notebook session directory and is removed after six hours or when the Kaggle session ends.

## For maintainers

The notebook clones the repository and then overwrites the worker and lyric modules with copies embedded in `ad_voice_p100.ipynb`, including `python/backend/ai_worker/word_guidance.py`, so a run works even before the matching code is pushed. Whenever an embedded module changes, re-embed it in the notebook; `python/tests/test_kaggle_notebook_discovery.py` verifies every required embedded file against the working source.

The current remote protocol is **5** (`backend/infrastructure/kaggle_ai_provider.py`). Health must return the matching `protocolVersion` and a non-empty server `generation`; an older worker is rejected. After updating embedded modules, use **Развернуть и запустить** so the running notebook actually contains them. A local notebook-copy test or a mocked health handshake does not prove a real remote job: verify a UI-initiated recalculation, its reported Kaggle backend, published revision and loaded result against the newly deployed worker before claiming remote processing works.

Alignment uses the same phrase/word guidance and sung-tail evidence as the local worker. Catalogue/ASR phrase bounds select phonetic cores; they do not cap sustained vowels. Accelerated CPU float32 Whisper is prepared for coverage/alignment guidance even when CTC runs on the GPU, with native Whisper fallback if that runtime cannot load.
