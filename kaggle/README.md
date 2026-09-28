# Kaggle GPU backend

1. Create a private Kaggle Notebook and enable an available GPU accelerator (T4 x2 or P100) plus Internet access.
2. Add a private notebook secret named `AD_VOICE_TOKEN` with a random value of at least 8 characters.
3. Import `ad_voice_p100.ipynb` and run its cells. The first run downloads about 1.5 GB of model weights.
4. In A&D Voice open **Settings → Ключи ENV** and enter the same token in **Токен доступа Kaggle**.
5. Choose **Kaggle GPU** under **AI / Обработка**. The app discovers the current `https://…gradio.live` address automatically.

Keep the final notebook cell running during song processing. Stop the Kaggle session when finished so idle time does not consume the weekly GPU quota. The public address can change whenever the server cell restarts; the notebook republishes it automatically, so no settings need to be rewritten. Audio is stored only in the temporary notebook session directory and is removed after six hours or when the Kaggle session ends.
