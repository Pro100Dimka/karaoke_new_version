# Kaggle GPU backend

1. Create a private Kaggle Notebook and enable an available GPU accelerator (T4 x2 or P100) plus Internet access.
2. Add a private notebook secret named `AD_VOICE_TOKEN` with a random value of at least 8 characters.
3. Import `ad_voice_p100.ipynb` and run its cells. The first run downloads about 1.5 GB of model weights.
4. Copy the public `https://…gradio.live` URL printed by the final cell.
5. In A&D Voice open **Settings → AI / Processing**, choose **Kaggle GPU**, paste the URL and the same token, then save.

Keep the final notebook cell running during song processing. Stop the Kaggle session when finished so idle time does not consume the weekly GPU quota. The public URL changes whenever the server cell restarts, so update it in the app settings after each restart. Audio is stored only in the temporary notebook session directory and is removed after six hours or when the Kaggle session ends.
