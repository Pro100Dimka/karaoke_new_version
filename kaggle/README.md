# Kaggle GPU backend

1. Open **Settings → Ключи ENV** and click **Войти в Kaggle**.
2. Confirm the official Kaggle OAuth page in the browser. A&D Voice then creates and starts a private `ad-voice-gpu` notebook with GPU and Internet enabled. The first run downloads about 1.5 GB of model weights.
3. Choose **Kaggle GPU** under **AI / Обработка**. The app discovers every current `https://…gradio.live` address automatically.

Use **Развернуть и запустить** to start a fresh notebook version later. Stop the Kaggle session when finished so idle time does not consume the weekly GPU quota. The public address can change whenever the server restarts; the notebook republishes it automatically, so no settings need to be rewritten. Audio is stored only in the temporary notebook session directory and is removed after six hours or when the Kaggle session ends.

## For maintainers

The notebook clones the repository and then overwrites a few files with copies embedded in `ad_voice_p100.ipynb` (`kaggle/ad_voice_server.py`, `python/backend/ai_worker/speech.py`, `ctc.py`, `timing.py`), so a run works even before the matching code is pushed. Whenever one of these files changes, re-embed it in the notebook; `python/tests/test_kaggle_notebook_discovery.py` fails while the embedded server differs from `kaggle/ad_voice_server.py`.
