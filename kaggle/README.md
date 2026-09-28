# Kaggle GPU backend

1. Open **Settings → Ключи ENV** and click **Войти в Kaggle**.
2. Confirm the official Kaggle OAuth page in the browser. A&D Voice then creates and starts a private `ad-voice-gpu` notebook with GPU and Internet enabled. The first run downloads about 1.5 GB of model weights.
3. Choose **Kaggle GPU** under **AI / Обработка**. The app discovers every current `https://…gradio.live` address automatically.

Use **Развернуть и запустить** to start a fresh notebook version later. Stop the Kaggle session when finished so idle time does not consume the weekly GPU quota. The public address can change whenever the server restarts; the notebook republishes it automatically, so no settings need to be rewritten. Audio is stored only in the temporary notebook session directory and is removed after six hours or when the Kaggle session ends.
