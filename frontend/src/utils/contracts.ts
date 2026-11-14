import {
  array,
  object,
  pipe,
  string,
  minLength,
  picklist,
  number,
  nullable,
  type InferOutput,
} from 'valibot';
import type { IconButtonProps } from '@neo-ui-kit/react';

export type FormButtonProps = IconButtonProps & { caption?: string };

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
