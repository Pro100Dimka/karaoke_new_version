import { Button, Card, Grid, Icon, MessageBar, NeonWaves, ProgressBar, Select, TextField, Typography } from "@ad-voice/ui";
import { useText } from "../../../../i18n/useText";
import "./ai.css";
import { ModelCard } from "./ModelCard";
import { useAiSettings, type ProcessingBackend } from "./useAiSettings";

export const AiSettings = () => {
  const t = useText();
  const ai = useAiSettings();
  const local = ai.backend === "Local";

  return (
    <Card border icon="chip" title={t("aiSettingsTitle")} description={t("aiSettingsHint")}
      actions={(
        <div className="aiHeaderArt">
          <NeonWaves strands={18} stars={false} aria-hidden="true" />
          <span className="aiPromise">{t("aiSettingsPromise")}</span>
        </div>
      )}>
      <div className="settingsStack">
        <Grid minChildWidth="min(100%, 18rem)" gap={4} align="start">
          <Select label={t("aiProcessingBackend")} value={ai.backend} disabled={ai.savingBackend}
            options={[
              { value: "Local", label: t("aiBackendLocal") },
              { value: "Kaggle", label: t("aiBackendKaggle") },
            ]}
            onValueChange={value => void ai.changeBackend(value as ProcessingBackend)} />
          <TextField label={t("dataStorageRoot")} description={t("dataStorageRootHint")} readOnly value={ai.dataRoot}
            startAdornment={<Icon name="folder" />}
            endAdornment={(
              <Button size="xs" variant="ghost" aria-label={t("selectDataFolder")} onClick={() => void ai.chooseDataRoot()}>
                {t("selectDataFolder")}
              </Button>
            )} />
        </Grid>
        {ai.failed && (
          <MessageBar tone="error" action={<Button size="sm" onClick={() => void ai.refresh()}>{t("retry")}</Button>}>
            {t("modelsLoadFailed")}
          </MessageBar>
        )}
        {!ai.models && !ai.failed && <ProgressBar indeterminate label={t("loadingSettings")} />}
        {local && ai.models?.length === 0 && <Typography variant="body-sm" tone="muted">{t("noModels")}</Typography>}
        {local && (
          <div className="aiModels">
            {ai.models?.map(model => (
              <ModelCard key={`${model.id}-${model.version}`} model={model} job={ai.jobs[model.id]} free={ai.free}
                onDownload={model => void ai.download(model)} onCancel={ai.cancel} />
            ))}
          </div>
        )}
      </div>
    </Card>
  );
};
