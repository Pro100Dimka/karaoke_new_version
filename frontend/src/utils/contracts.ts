import { array, object, pipe, string, minLength, picklist, number, nullable, type InferOutput } from "valibot";
import type { CardProps, FormFieldDefinition, IconButtonProps } from "@neo-ui-kit/react";
import type { PropsWithChildren } from "react";
import type { store } from "../providers/store";
import type { useAudioSettings } from "../pages/library/modals/settings/audio/useAudioSettings";

export type SettingsFormValues = Pick<typeof store,
  "profile" | "interface" | "radio" | "application" | "integrations" | "audio"> & {
    keyboardLighting: { show: boolean };
    ai: { backend: "Local" | "Kaggle"; transferToLibraryPath: string; savingBackend: boolean; error: string };
    profile: typeof store.profile & { canChangePhoto: boolean };
    audioStatus: ReturnType<typeof useAudioSettings>["audio"] & {
      inputLevel: number; canToggle: boolean; ready: boolean;
    };
  };
export type FormCardProps = CardProps & { fields?: FormFieldDefinition<SettingsFormValues>[] };
export type FormBlock = Omit<FormCardProps, "title"> & { span: FormFieldDefinition<SettingsFormValues>["span"]; show?: boolean };
export type FormButtonProps = IconButtonProps & { caption?: string };
export type FormCardsProps = PropsWithChildren<{ blocks: Record<string, FormBlock>; level?: FormCardProps["level"] }>;

export const modelSchema = object({
  modelId: pipe(string(), minLength(1)),
  version: pipe(string(), minLength(1)),
  purpose: picklist(['ASR', 'Alignment', 'Separation', 'Pitch']),
  state: picklist([
    'Missing',
    'Downloading',
    'Verifying',
    'Ready',
    'Failed',
    'ModelUpdateAvailable',
  ]),
  size: number(),
  requiredDiskBytes: number(),
});

export type AIModel = InferOutput<typeof modelSchema>;

const jobTypes = ['ModelDownload', 'SongProcessing'] as const;

export type JobType = (typeof jobTypes)[number];

const jobSchema = object({
  jobId: string(),
  entityId: nullable(string()),
  state: string(),
  stage: nullable(string()),
  stageProgress: number(),
  overallProgress: number(),
});

export type JobProgress = InferOutput<typeof jobSchema>;

export const jobsSchema = object({ items: array(jobSchema) });


export type ModelCardProps = {
  model: AIModel;
  locale: string;
  progressError: boolean;
  disabled: boolean;
  pending: boolean;
  onAction(model: AIModel): void;
};

