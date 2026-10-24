import {
  Button,
  Card,
  Grid,
  Icon,
  MessageBar,
  NeonWaves,
  ProgressBar,
  Select,
  TextField,
  Typography,
  Stack,
} from "@neo-ui-kit/react";
import { useRef } from "react";
import { useText } from "../../../../i18n/useText";
import { useAiSettings, type ProcessingBackend } from "./hooks/useAiSettings";
import "./ui/ai.css";
import { ModelCard } from "./ui/ModelCard";

export const AiSettings = () => {
  const t = useText();
  const ai = useAiSettings();
  const local = ai.backend === "Local";
  const picker = useRef<HTMLInputElement>(null);
  const labels = { export: t("libraryExport"), import: t("libraryImport") };

  return (
    <Card
      border
      style={{ background: "unset!important", boxShadow: "unset!important" }}
      icon="chip"
      actions={
        <div className="aiHeaderArt">
          <NeonWaves strands={18} stars={false} aria-hidden="true" />
          <span className="aiPromise">{t("aiSettingsPromise")}</span>
        </div>
      }
    >
      <div className="settingsStack">
        <Grid minChildWidth="min(100%, 18rem)" gap={4} align="start">
          <Select<ProcessingBackend>
            label={t("aiProcessingBackend")}
            value={ai.backend}
            disabled={ai.savingBackend}
            options={[
              { value: "Local", label: t("aiBackendLocal") },
              { value: "Kaggle", label: t("aiBackendKaggle") },
            ]}
            onValueChange={(value) => void ai.changeBackend(value)}
          />
          <TextField
            label={t("dataStorageRoot")}
            description={t("dataStorageRootHint")}
            readOnly
            value={ai.dataRoot}
            startAdornment={<Icon name="folder" />}
            endAdornment={
              <Button
                size="xs"
                variant="ghost"
                disabled={ai.savingRoot}
                aria-label={t("selectDataFolder")}
                onClick={() => void ai.chooseDataRoot()}
              >
                {t("selectDataFolder")}
              </Button>
            }
          />
        </Grid>
        <Card
          title={t("libraryArchive")}
          description={t("libraryArchiveHint")}
          padding="sm"
        >
          <Stack direction="row" gap={2} style={{ flexWrap: "wrap" }}>
            {(["export", "import"] as const).map((action) => (
              <Button
                key={action}
                icon={{ export: "download", import: "upload" }[action]}
                disabled={ai.transfer !== null}
                onClick={() =>
                  action === "export"
                    ? void ai.transferLibrary(action)
                    : picker.current?.click()
                }
              >
                {labels[action]}
              </Button>
            ))}
          </Stack>
          <input
            ref={picker}
            type="file"
            accept=".zip"
            hidden
            onChange={(event) => {
              const file = event.currentTarget.files?.[0];
              event.currentTarget.value = "";
              if (file) void ai.transferLibrary("import", file);
            }}
          />
          {ai.transfer && (
            <ProgressBar
              label={labels[ai.transfer.action]}
              value={ai.transfer.progress}
            />
          )}
        </Card>
        {ai.failed && (
          <MessageBar
            tone="error"
            action={
              <Button size="sm" onClick={() => void ai.refresh()}>
                {t("retry")}
              </Button>
            }
          >
            {ai.error ?? t("modelsLoadFailed")}
          </MessageBar>
        )}
        {ai.loadingModels && (
          <ProgressBar indeterminate label={t("loadingSettings")} />
        )}
        {local && ai.models?.length === 0 && (
          <Typography variant="body-sm" tone="muted">
            {t("noModels")}
          </Typography>
        )}
        {local && (
          <div className="aiModels">
            {ai.models?.map((model) => (
              <ModelCard
                key={`${model.id}-${model.version}`}
                model={model}
                job={ai.jobs[model.id]}
                pending={ai.pendingDownloads.has(model.id)}
                free={ai.free}
                onDownload={(model) => void ai.download(model)}
                onCancel={(jobId) => void ai.cancel(jobId)}
              />
            ))}
          </div>
        )}
      </div>
    </Card>
  );
};
