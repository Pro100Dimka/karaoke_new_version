import {
  Braces,
  CheckCircle2,
  ChevronDown,
  CircleDashed,
  CloudCog,
  LoaderCircle,
  Music2,
  RadioTower,
  ServerCog,
  XCircle,
  type LucideIcon,
} from "lucide-react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useNotify } from "../../../../app/NotificationsProvider";
import type {
  AiProcessingSettingsDto,
  EnvironmentSettingDto,
} from "../../../../contracts/models";
import type { MessageKey } from "../../../../i18n/messages";
import { useText } from "../../../../i18n/useText";
import { desktopClient } from "../../../../services/desktopClient";
import { pythonClient } from "../../../../services/pythonClient";
import { Spinner } from "../../../../shared/ui/Spinner";
import {
  RenderFormikFields,
  useGetForm,
  type FormRow,
} from "../../../../theme/ui";
import "./secrets.css";

type DisplayState = EnvironmentSettingDto["state"] | "checking";
type DisplayEntry = Omit<EnvironmentSettingDto, "state"> & {
  state: DisplayState;
};
type EnvironmentValues = Record<string, string>;
type EnvironmentGroup = Exclude<DisplayEntry["group"], "runtime">;

const groupOrder = [
  "kaggle",
  "recognition",
  "room",
  "deployment",
] as const satisfies readonly EnvironmentGroup[];
const saveDelayMilliseconds = 450;
const statusIcon = {
  valid: CheckCircle2,
  invalid: XCircle,
  empty: CircleDashed,
  unverified: CircleDashed,
  checking: LoaderCircle,
} as const;
const groupUi = {
  kaggle: {
    icon: CloudCog,
    title: "environmentGroupKaggle",
    hint: "environmentGroupKaggleHint",
  },
  recognition: {
    icon: Music2,
    title: "environmentGroupRecognition",
    hint: "environmentGroupRecognitionHint",
  },
  room: {
    icon: RadioTower,
    title: "environmentGroupRoom",
    hint: "environmentGroupRoomHint",
  },
  deployment: {
    icon: ServerCog,
    title: "environmentGroupDeployment",
    hint: "environmentGroupDeploymentHint",
  },
} as const satisfies Record<
  EnvironmentGroup,
  { icon: LucideIcon; title: MessageKey; hint: MessageKey }
>;
const fieldUi: Readonly<
  Record<
    string,
    {
      label: MessageKey;
      md?: number;
      optional?: boolean;
      advanced?: boolean;
      hidden?: boolean;
    }
  >
> = {
  AD_VOICE_TOKEN: { label: "environmentFieldKaggleToken", md: 12 },
  AD_VOICE_AUDD_TOKEN: {
    label: "environmentFieldAuddToken",
    md: 12,
    optional: true,
  },
  AD_VOICE_YOUTUBE_API_KEY: {
    label: "environmentFieldYoutubeKey",
    md: 6,
    optional: true,
  },
  AD_VOICE_ROOM_SERVER_HOST: { label: "environmentFieldRoomHost", md: 6 },
  AD_VOICE_ROOM_SERVER_PORT: { label: "environmentFieldRoomApiPort", md: 3 },
  AD_VOICE_ROOM_SERVER_RELAY_PORT: { label: "environmentFieldRoomPort", md: 3 },
  AD_VOICE_ROOM_SERVER_SSH_KEY: { label: "environmentFieldRoomSshKey", md: 5 },
  AD_VOICE_ROOM_SERVER_KNOWN_HOSTS: {
    label: "environmentFieldRoomKnownHosts",
    md: 4,
  },
  AD_VOICE_ROOM_SERVER_SSH_USER: {
    label: "environmentFieldRoomSshUser",
    md: 3,
  },
};

const valuesOf = (entries: readonly DisplayEntry[]): EnvironmentValues =>
  Object.fromEntries(entries.map((entry) => [entry.key, entry.value]));
const effectiveState = (entry: DisplayEntry): DisplayState =>
  entry.value.trim() ? entry.state : "empty";
const kaggleEntries = (settings: AiProcessingSettingsDto): DisplayEntry[] => [
  {
    key: "AD_VOICE_TOKEN",
    group: "kaggle",
    kind: "secret",
    value: settings.kaggleToken ?? "",
    configured: Boolean(settings.kaggleToken),
    state: settings.kaggleToken
      ? settings.kaggleConfigured
        ? "unverified"
        : "invalid"
      : "empty",
    message: settings.kaggleToken ? "Токен сохранён" : "Токен не настроен",
  },
];

const StatusMark = ({
  state,
  message,
}: {
  state: DisplayState;
  message: string;
}) => {
  const Status = statusIcon[state];
  return (
    <span className="environmentStatus" title={message} data-state={state}>
      <Status size={18} aria-label={message} />
    </span>
  );
};

export const SecretsSettings = () => {
  const t = useText();
  const notify = useNotify();
  const [entries, setEntries] = useState<DisplayEntry[] | null>(null);
  const [ai, setAi] = useState<AiProcessingSettingsDto | null>(null);
  const timers = useRef(new Map<string, number>());
  const fileInputs = useRef<Record<string, HTMLInputElement | null>>({});
  const formik = useGetForm<EnvironmentValues>({
    initialValues: {},
    onSubmit: () => undefined,
  });
  const formikRef = useRef(formik);
  formikRef.current = formik;
  const jsonFormik = useGetForm<{ source: string }>({
    initialValues: { source: "{}" },
    onSubmit: () => undefined,
  });

  const replace = useCallback(
    (next: DisplayEntry, expectedValue = next.value) => {
      setEntries(
        (current) =>
          current?.map((item) =>
            item.key === next.key && item.value === expectedValue ? next : item,
          ) ?? null,
      );
    },
    [],
  );

  const verifyKaggle = useCallback(async () => {
    setEntries(
      (current) =>
        current?.map((item) =>
          item.group === "kaggle" && item.configured
            ? { ...item, state: "checking" }
            : item,
        ) ?? null,
    );
    const result = await pythonClient.verifyKaggleSettings();
    setEntries(
      (current) =>
        current?.map((item) =>
          item.group === "kaggle" && item.configured
            ? { ...item, state: result.state, message: result.message }
            : item,
        ) ?? null,
    );
  }, []);

  useEffect(() => {
    let active = true;
    void Promise.all([
      pythonClient.listEnvironmentSettings(),
      pythonClient.getAiProcessingSettings(),
    ])
      .then(([environment, settings]) => {
        if (!active) return;
        const loaded = [...kaggleEntries(settings), ...environment];
        setAi(settings);
        setEntries(loaded);
        void formikRef.current.setValues(valuesOf(loaded), false);
        for (const entry of environment.filter(
          (item) => item.configured && item.value.trim(),
        )) {
          void pythonClient
            .verifyEnvironmentSetting(entry.key)
            .then((result) => active && replace(result, entry.value))
            .catch(() => undefined);
        }
        if (settings.kaggleConfigured)
          void verifyKaggle().catch(() => undefined);
      })
      .catch((error) =>
        notify(
          error instanceof Error ? error.message : t("settingsApplyFailed"),
          "error",
        ),
      );
    return () => {
      active = false;
    };
  }, [notify, replace, t, verifyKaggle]);

  const save = useCallback(
    async (key: string, value: string) => {
      const trimmed = value.trim();
      setEntries(
        (current) =>
          current?.map((item) =>
            item.key === key
              ? {
                  ...item,
                  value,
                  configured: Boolean(trimmed),
                  state: trimmed ? "checking" : "empty",
                  message: trimmed
                    ? t("checking")
                    : t("environmentNotConfigured"),
                }
              : item,
          ) ?? null,
      );
      try {
        if (key === "AD_VOICE_TOKEN") {
          if (!ai) return;
          const updated = await pythonClient.updateAiProcessingSettings({
            processingBackend: ai.processingBackend,
            kaggleToken: trimmed || undefined,
          });
          setAi(updated);
          setEntries((current) => {
            const next = [
              ...kaggleEntries(updated),
              ...(current?.filter((item) => item.group !== "kaggle") ?? []),
            ];
            void formikRef.current.setValues(valuesOf(next), false);
            return next;
          });
          if (updated.kaggleConfigured) await verifyKaggle();
          return;
        }
        const stored = await pythonClient.updateEnvironmentSetting(key, value);
        replace(
          {
            ...stored,
            state:
              stored.configured && stored.state !== "invalid"
                ? "checking"
                : stored.state,
          },
          value,
        );
        if (stored.configured && stored.state !== "invalid")
          replace(await pythonClient.verifyEnvironmentSetting(key), value);

      } catch (error) {
        notify(
          error instanceof Error ? error.message : t("settingsApplyFailed"),
          "error",
        );
        setEntries(
          (current) =>
            current?.map((item) =>
              item.key === key && item.value === value
                ? {
                    ...item,
                    state: "invalid",
                    message: t("settingsApplyFailed"),
                  }
                : item,
            ) ?? null,
        );
      }
    },
    [ai, notify, replace, t, verifyKaggle],
  );

  const scheduleSave = useCallback(
    (key: string, value: string) => {
      const previous = timers.current.get(key);
      if (previous !== undefined) window.clearTimeout(previous);
      timers.current.set(
        key,
        window.setTimeout(() => {
          timers.current.delete(key);
          void save(key, value);
        }, saveDelayMilliseconds),
      );
    },
    [save],
  );

  const changeEntry = useCallback(
    (key: string, value: string) => {
      const configured = Boolean(value.trim());
      setEntries(
        (current) =>
          current?.map((entry) =>
            entry.key === key
              ? {
                  ...entry,
                  value,
                  configured,
                  state: configured ? "unverified" : "empty",
                  message: configured
                    ? t("environmentSaved")
                    : t("environmentNotConfigured"),
                }
              : entry,
          ) ?? null,
      );
      scheduleSave(key, value);
    },
    [scheduleSave, t],
  );

  useEffect(
    () => () => {
      for (const timer of timers.current.values()) window.clearTimeout(timer);
      timers.current.clear();
    },
    [],
  );

  const chooseFile = useCallback(
    (entry: DisplayEntry, file: File | undefined) => {
      if (!file) return;
      const path = desktopClient.pathForFile(file);
      if (!path) return;
      void formikRef.current.setFieldValue(entry.key, path, false);
      void save(entry.key, path);
    },
    [save],
  );

  const json = useMemo(() => valuesOf(entries ?? []), [entries]);
  const jsonSource = useMemo(() => JSON.stringify(json, null, 2), [json]);
  useEffect(() => {
    void jsonFormik.setFieldValue("source", jsonSource, false);
  }, [jsonFormik.setFieldValue, jsonSource]);

  const applyJson = useCallback(async (source: unknown) => {
    const parsed: unknown = JSON.parse(String(source));
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed))
      throw new Error("JSON must contain an object");
    const values = parsed as Record<string, unknown>;
    const known = new Set((entries ?? []).map((entry) => entry.key));
    const invalid = Object.entries(values).find(
      ([key, value]) => !known.has(key) || typeof value !== "string",
    );
    if (invalid)
      throw new Error(`Unsupported ENV value: ${invalid[0]}`);
    const stringValues = values as Record<string, string>;
    const changes = Object.entries(stringValues).filter(
      ([key, value]) => json[key] !== value,
    );
    if (!changes.length) return;
    setEntries((current) => current?.map((entry) => {
      const next = stringValues[entry.key];
      return typeof next === "string"
        ? { ...entry, value: next, configured: Boolean(next.trim()), state: next.trim() ? "unverified" : "empty" }
        : entry;
    }) ?? null);
    await formikRef.current.setValues({ ...formikRef.current.values, ...stringValues }, false);
    for (const [key, value] of changes) await save(key, value);
  }, [entries, json, save]);

  const rows = useMemo<FormRow[]>(() => {
    if (!entries) return [];
    const messageFor = (entry: DisplayEntry, optional: boolean): string => {
      const state = effectiveState(entry);
      if (state === "empty")
        return t(optional ? "environmentOptional" : "environmentNotConfigured");
      if (state === "valid") return t("environmentReady");
      if (state === "checking") return t("checking");
      if (state === "unverified") return t("environmentSaved");
      return entry.message;
    };
    const fieldRow = (entry: DisplayEntry): FormRow => {
      const meta = fieldUi[entry.key];
      const state = effectiveState(entry);
      const message = messageFor(entry, Boolean(meta?.optional));
      return {
        type: entry.kind === "file" ? "FolderField" : "SimpleTextField",
        tag: entry.key,
        label: meta ? t(meta.label) : entry.key,
        tooltip: entry.key,
        md: meta?.md ?? 12,
        saveOn: false,
        fieldClassName: "environmentField",
        hint: undefined,
        error: state === "invalid" ? message : undefined,
        end: <StatusMark state={state} message={message} />,
        onChange: (next: unknown) => changeEntry(entry.key, String(next ?? "")),
        ...(entry.kind === "file" && {
          browseLabel: t("selectFile"),
          onBrowse: () => fileInputs.current[entry.key]?.click(),
        }),
      };
    };
    const groupRows: FormRow[] = [];
    const hasRecognition = entries.some(
      (entry) => entry.group === "recognition" && Boolean(entry.value.trim()),
    );
    for (const group of groupOrder) {
      const groupEntries = entries.filter(
        (entry) =>
          entry.group === group &&
          !fieldUi[entry.key]?.hidden &&
          (group !== "recognition" || Boolean(entry.value.trim())),
      );
      if (!groupEntries.length) continue;
      const basic = groupEntries
        .filter((entry) => !fieldUi[entry.key]?.advanced)
        .map(fieldRow);
      const advanced = groupEntries
        .filter((entry) => fieldUi[entry.key]?.advanced)
        .map(fieldRow);
      const configured = groupEntries.filter((entry) =>
        entry.value.trim(),
      ).length;
      const state = groupEntries.some(
        (entry) => effectiveState(entry) === "invalid",
      )
        ? "invalid"
        : groupEntries.some((entry) => effectiveState(entry) === "checking")
          ? "checking"
          : configured
            ? "valid"
            : "empty";
      const presentation = groupUi[group];
      const GroupIcon = presentation.icon;
      groupRows.push({
        key: `group-${group}`,
        md:
          group === "kaggle" || group === "recognition"
            ? hasRecognition
              ? 6
              : 12
            : 12,
        render: () => (
          <section
            key={group}
            className="environmentGroupCard"
            data-state={state}
          >
            <header className="environmentGroupHeader">
              <span className="environmentGroupIcon">
                <GroupIcon size={20} aria-hidden />
              </span>
              <span className="environmentGroupCopy">
                <strong>{t(presentation.title)}</strong>
                <small>{t(presentation.hint)}</small>
              </span>
            </header>
            <RenderFormikFields
              formik={formik}
              items={basic}
              rowSpacing={1.5}
            />
            {advanced.length > 0 && (
              <details className="environmentDisclosure">
                <summary>
                  <ChevronDown size={16} />
                  {t("environmentAdvanced")}
                </summary>
                <RenderFormikFields
                  formik={formik}
                  items={advanced}
                  rowSpacing={1.5}
                />
              </details>
            )}
          </section>
        ),
      });
    }
    return [
      ...groupRows,
      {
        key: "environment-json",
        md: 12,
        render: () => (
          <details className="environmentJson environmentDisclosure">
            <summary>
              <Braces size={17} />
              <span>
                <strong>{t("environmentJson")}</strong>
                <small>{t("environmentJsonHint")}</small>
              </span>
              <ChevronDown className="environmentDisclosureChevron" size={17} />
            </summary>
            <RenderFormikFields
              className="environmentJsonEditor"
              formik={jsonFormik}
              items={[{
                type: "SimpleTextField",
                tag: "source",
                multiline: true,
                rows: 10,
                inputClassName: "environmentJsonInput",
                "aria-label": t("environmentJson"),
                onSave: applyJson,
                validate: (value: unknown) => {
                  try {
                    const parsed: unknown = JSON.parse(String(value));
                    return parsed && typeof parsed === "object" && !Array.isArray(parsed)
                      ? undefined
                      : "JSON must contain an object";
                  } catch {
                    return "Invalid JSON";
                  }
                },
              }]}
              rowSpacing={0}
            />
          </details>
        ),
      },
    ];
  }, [applyJson, changeEntry, entries, formik, jsonFormik, t]);

  if (!entries) return <Spinner label={t("loadingSettings")} />;
  return (
    <section aria-label={t("environmentKeys")} className="environmentSettings">
      <RenderFormikFields
        className="environmentForm"
        formik={formik}
        items={rows}
        rowSpacing={2}
      />
      {entries
        .filter((entry) => entry.kind === "file")
        .map((entry) => (
          <input
            key={entry.key}
            ref={(node) => {
              fileInputs.current[entry.key] = node;
            }}
            className="environmentFileInput"
            type="file"
            tabIndex={-1}
            aria-hidden="true"
            onChange={(event) =>
              chooseFile(entry, event.currentTarget.files?.[0])
            }
          />
        ))}
    </section>
  );
};
