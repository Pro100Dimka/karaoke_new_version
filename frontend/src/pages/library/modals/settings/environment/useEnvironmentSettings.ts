import { tr, useLocale } from '@neo-ui-kit/react';
import {
  useMutationState,
  useQuery,
  useQueryClient,
} from '@tanstack/react-query';
import { useEffect, useRef, useState } from 'react';
import { useNotify } from '../../../../../providers/notifications';
import { pythonClient } from '../../../../../services/pythonClient';
import type { EnvironmentSettingDto } from '../../../../../contracts/models';
import {
  valuesOf,
  isSecret,
  saveDelayMilliseconds,
  type DisplayEntry,
} from './environmentModel';
import { toAppError } from '../../../../../shared/errors';

const queryKey = ['environment-settings'] as const;
const mutationKey = ['environment-setting'] as const;
type Write = { key: string; value?: string };
const errorText = (error: unknown, fallback: string) => {
  const failure = toAppError(error);
  return failure.code === 'Unknown' && !(error instanceof Error)
    ? fallback
    : tr(failure.message);
};
const readable = (entry: EnvironmentSettingDto): DisplayEntry =>
  isSecret(entry) ? { ...entry, value: '' } : entry;

/** The query owns the server snapshot; only unsent edits belong to the view. */
export const useEnvironmentSettings = () => {
  useLocale();
  const client = useQueryClient();
  const notify = useNotify();
  const [drafts, setDrafts] = useState<Record<string, string>>({});
  // Rejected secrets belong only to the mounted password field, never the query snapshot.
  const [failedSecrets, setFailedSecrets] = useState<Record<string, string>>(
    {},
  );
  const edits = useRef(new Map<string, number>());
  const pending = useRef(
    new Map<string, { value: string; timer: ReturnType<typeof setTimeout> }>(),
  );
  const writes = useMutationState({
    filters: { mutationKey, status: 'pending' },
    select: (mutation) => mutation.state.variables as Write,
  });
  const query = useQuery({
    queryKey,
    // Consecutive secret writes have identical redacted values. Keep their
    // identities distinct so an older verification cannot replace the new one.
    structuralSharing: false,
    queryFn: async ({ signal }) => {
      const entries = await pythonClient.listEnvironmentSettings();
      signal.throwIfAborted();
      return entries.filter((entry) => entry.group !== 'kaggle').map(readable);
    },
    enabled: writes.length === 0,
    staleTime: Infinity,
    refetchOnMount: 'always',
  });
  const reportError = (error: unknown) =>
    notify(errorText(error, tr('settingsApplyFailed')), 'error');
  const update = (key: string, change: (entry: DisplayEntry) => DisplayEntry) =>
    client.setQueryData<DisplayEntry[]>(queryKey, (entries) =>
      entries?.map((entry) => (entry.key === key ? change(entry) : entry)),
    );
  const clearFailedSecret = (key: string) =>
    setFailedSecrets((current) => {
      if (!(key in current)) return current;
      const next = { ...current };
      delete next[key];
      return next;
    });
  const submit = (variables: Write): Promise<DisplayEntry> => {
    const edit = edits.current.get(variables.key);
    const before = client
      .getQueryData<DisplayEntry[]>(queryKey)
      ?.find((entry) => entry.key === variables.key);
    const isWrite = variables.value !== undefined;
    const current = () =>
      client
        .getQueryData<DisplayEntry[]>(queryKey)
        ?.find((entry) => entry.key === variables.key);
    return client
      .getMutationCache()
      .build<DisplayEntry, unknown, Write, unknown>(client, {
        mutationKey,
        gcTime: 0,
        scope: isWrite
          ? { id: `environment-setting:${variables.key}` }
          : undefined,
        onMutate: () => client.cancelQueries({ queryKey }),
        mutationFn: async ({ key, value }) => {
          const result =
            value !== undefined
              ? await pythonClient.updateEnvironmentSetting(key, value)
              : await pythonClient.verifyEnvironmentSetting(key);
          return {
            ...readable(result),
            ...(!isWrite && { value: before?.value ?? '' }),
          };
        },
        onSuccess: (stored, { key }) => {
          if (!isWrite && current() !== before) return;
          if (isWrite) clearFailedSecret(key);
          update(key, () => stored);
        },
        onError: (error, { key, value }) => {
          if (!isWrite && current() !== before) return;
          if (
            before?.kind === 'secret' &&
            value !== undefined &&
            edits.current.get(key) === edit
          )
            setFailedSecrets((current) => ({ ...current, [key]: value }));
          update(key, (entry) => ({
            ...entry,
            value:
              !isSecret(entry) && value !== undefined ? value : entry.value,
            state: 'invalid',
            errorMessage: toAppError(error).message,
          }));
        },
      })
      .execute(variables)
      .then(async (stored) => {
        // Verification runs outside the write scope so the next save can proceed.
        if (isWrite && stored.configured && stored.state !== 'invalid')
          await submit({ key: variables.key });
        return stored;
      });
  };
  const actions = useRef({ submit, reportError });
  actions.current = { submit, reportError };
  const verified = useRef(false);
  useEffect(() => {
    if (!query.data || query.isFetching || verified.current) return;
    verified.current = true;
    for (const entry of query.data) {
      const active = client.getMutationCache().find({
        mutationKey,
        status: 'pending',
        predicate: (mutation) =>
          (mutation.state.variables as Write).key === entry.key,
      });
      if (entry.configured && !active)
        void actions.current.submit({ key: entry.key }).catch(() => undefined);
    }
  }, [client, query.data, query.isFetching]);
  useEffect(() => {
    const timers = pending.current;
    return () => {
      for (const [key, { value, timer }] of timers) {
        clearTimeout(timer);
        void actions.current
          .submit({ key, value })
          .catch(actions.current.reportError);
      }
      timers.clear();
    };
  }, []);
  const discard = (key: string) => {
    edits.current.set(key, (edits.current.get(key) ?? 0) + 1);
    clearFailedSecret(key);
    clearTimeout(pending.current.get(key)?.timer);
    pending.current.delete(key);
    setDrafts((current) => {
      const next = { ...current };
      delete next[key];
      return next;
    });
  };
  const save = async (key: string, value: string) => {
    discard(key);
    try {
      await submit({ key, value });
    } catch (error) {
      reportError(error);
    }
  };
  const change = (key: string, value: string) => {
    discard(key);
    const entry = query.data?.find((entry) => entry.key === key);
    if (!entry || (isSecret(entry) && !value.trim())) return;
    setDrafts((current) => ({ ...current, [key]: value }));
    const timer = setTimeout(() => {
      void save(key, value);
    }, saveDelayMilliseconds);
    pending.current.set(key, { value, timer });
  };
  const entries =
    query.data?.map((entry) => {
      const draft = drafts[entry.key];
      const writing = [...writes]
        .reverse()
        .find((write) => write.key === entry.key);
      const value =
        draft ?? writing?.value ?? failedSecrets[entry.key] ?? entry.value;
      return {
        ...entry,
        value,
        state:
          draft !== undefined
            ? draft.trim()
              ? 'unverified'
              : 'empty'
            : writing
              ? 'checking'
              : entry.state,
        errorMessage:
          draft !== undefined || writing ? undefined : entry.errorMessage,
      } satisfies DisplayEntry;
    }) ?? null;
  return {
    entries,
    loadError: query.error ? errorText(query.error, tr('actionFailed')) : null,
    retry: () => void query.refetch(),
    json: valuesOf(entries ?? []),
    change,
    save,
    applyJson: async (source: string) => {
      const parsed: unknown = JSON.parse(source);
      if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed))
        throw new Error('JSON must contain an object');
      const changes = Object.entries(parsed).map(([key, value]) => {
        const entry = query.data?.find((entry) => entry.key === key);
        if (!entry || isSecret(entry) || typeof value !== 'string')
          throw new Error(`Unsupported ENV value: ${key}`);
        return { key, value };
      });
      const queued = [...pending.current].map(([key, { value, timer }]) => {
        clearTimeout(timer);
        return { key, value };
      });
      pending.current.clear();
      setDrafts({});
      const combined = new Map(
        [...queued, ...changes].map((write) => [write.key, write]),
      );
      const results = await Promise.allSettled(
        [...combined.values()]
          .filter(({ key, value }) => {
            const entry = query.data?.find((entry) => entry.key === key);
            return (
              entry?.value !== value ||
              entry?.state === 'invalid' ||
              queued.some((write) => write.key === key) ||
              writes.some(
                (write) => write.key === key && write.value !== undefined,
              )
            );
          })
          .map((write) => submit(write)),
      );
      const failures = results.flatMap((result) =>
        result.status === 'rejected'
          ? [errorText(result.reason, tr('settingsApplyFailed'))]
          : [],
      );
      if (failures.length) throw new Error(failures.join('\n'));
    },
  };
};
