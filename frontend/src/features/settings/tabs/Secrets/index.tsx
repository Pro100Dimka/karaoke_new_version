import {
  Braces,
  ChevronDown,
  Copy,
  LoaderCircle,
  LogIn,
  Microchip,
  Rocket,
} from "lucide-react";
import {
  useCallback,
  useEffect,
  useId,
  useMemo,
  useRef,
  useState,
  type ReactElement,
} from "react";
import { useNotify } from "../../../../app/NotificationsProvider";
import { useText } from "../../../../i18n/useText";
import { desktopClient } from "../../../../services/desktopClient";
import { pythonClient } from "../../../../services/pythonClient";
import { Spinner } from "../../../../shared/ui/Spinner";
import {
  Button,
  IconButton,
  RenderFormikFields,
  useGetForm,
  type FormRow,
} from "../../../../theme/ui";
import "./secrets.css";
import {
  effectiveState,
  fieldUi,
  formatElapsed,
  groupOrder,
  groupUi,
  saveDelayMilliseconds,
  StatusMark,
  valuesOf,
  type DisplayEntry,
  type EnvironmentGroup,
  type EnvironmentValues,
} from "./secretsUi";
import { kaggleDeploymentRunning, useKaggleActions } from "./useKaggleActions";

const environmentWaveConfig: Record<EnvironmentGroup, {
  width: number;
  height: number;
  paths: number;
  phase: number;
}> = {
  kaggle: { width: 383, height: 95, paths: 22, phase: 0 },
  room: { width: 375, height: 104, paths: 22, phase: .82 },
  recognition: { width: 768, height: 174, paths: 29, phase: 1.64 },
  deployment: { width: 620, height: 156, paths: 22, phase: 2.46 },
};

const EnvironmentWaves = ({ group }: { group: EnvironmentGroup }) => {
  const ref = useRef<SVGSVGElement | null>(null);
  const gradientId = `environment-wave-${useId().replaceAll(":", "")}`;
  const config = environmentWaveConfig[group];
  const stars = useMemo(() => {
    let seed = 47831 + groupOrder.indexOf(group) * 997;
    const next = () => {
      seed = (Math.imul(1664525, seed) + 1013904223) | 0;
      return (seed >>> 0) / 4294967296;
    };
    return Array.from({ length: 58 }, () => ({
      x: next() * config.width,
      y: next() * config.height,
      radius: .14 + next() * .44,
      opacity: .1 + next() * .38,
    }));
  }, [config.height, config.width, group]);

  useEffect(() => {
    const svg = ref.current;
    if (!svg) return;
    const paths = [...svg.querySelectorAll<SVGPathElement>(".environmentWavePath")];
    const reducedMotion = window.matchMedia?.("(prefers-reduced-motion: reduce)");
    let frame = 0;
    let start = performance.now();
    let lastPaint = -Infinity;
    const paint = (time: number) => {
      paths.forEach((path, index) => {
        const progress = index / (paths.length - 1);
        const drift = time * .54 + config.phase;
        const a = Math.sin(drift + progress * 1.7) * config.height * .085;
        const b = Math.cos(drift * .8 + progress * 2.4) * config.height * .11;
        path.setAttribute("d", `M-8 ${config.height * (.16 + progress * .37) + a} C${config.width * .16} ${config.height * (.83 - progress * .25) + b} ${config.width * .25} ${config.height * (.12 + progress * .2) + a} ${config.width * .4} ${config.height * (.46 + progress * .1)} S${config.width * .64} ${config.height * (.9 - progress * .23) - a} ${config.width * .72} ${config.height * (.4 + progress * .23) + b} S${config.width * .91} ${config.height * (.02 + progress * .33) + a} ${config.width + 8} ${config.height * (.26 + progress * .44) - b}`);
      });
    };
    const tick = (now: number) => {
      if (now - lastPaint >= 1000 / 30) {
        paint((now - start) / 1000);
        lastPaint = now;
      }
      frame = requestAnimationFrame(tick);
    };
    const sync = () => {
      cancelAnimationFrame(frame);
      start = performance.now();
      paint(0);
      if (!reducedMotion?.matches && !document.hidden) frame = requestAnimationFrame(tick);
    };
    reducedMotion?.addEventListener("change", sync);
    document.addEventListener("visibilitychange", sync);
    sync();
    return () => {
      cancelAnimationFrame(frame);
      reducedMotion?.removeEventListener("change", sync);
      document.removeEventListener("visibilitychange", sync);
    };
  }, [config]);

  return (
    <svg ref={ref} className="environmentWave" viewBox={`0 0 ${config.width} ${config.height}`} preserveAspectRatio="none">
      <defs>
        <linearGradient id={gradientId}>
          <stop stopColor="#81152e" stopOpacity="0" />
          <stop offset=".17" stopColor="#ac1838" stopOpacity=".28" />
          <stop offset=".5" stopColor="#ff365d" stopOpacity=".63" />
          <stop offset=".8" stopColor="#ff7388" stopOpacity=".92" />
          <stop offset="1" stopColor="#ec1644" stopOpacity=".32" />
        </linearGradient>
      </defs>
      {Array.from({ length: config.paths }, (_, index) => (
        <path key={index} className="environmentWavePath" fill="none" stroke={`url(#${gradientId})`} strokeWidth={index === 9 ? 1 : .58} opacity={.37 + index % 5 * .08} />
      ))}
      {stars.map((star, index) => (
        <circle key={index} cx={star.x} cy={star.y} r={star.radius} fill="#ff4d76" opacity={star.opacity} />
      ))}
    </svg>
  );
};

const EnvironmentArtwork = ({ group }: { group: EnvironmentGroup }) => (
  <span className="environmentCardArt" data-art={group} aria-hidden>
    <EnvironmentWaves group={group} />
    {(group === "room" || group === "deployment") && (
      <svg className="environmentServerArt" viewBox="0 0 180 170" fill="none">
        <defs>
          <linearGradient id="env-rack-front" x1="0" y1="0" x2="1" y2="1"><stop stopColor="#592034" /><stop offset=".22" stopColor="#1b0611" /><stop offset=".72" stopColor="#0d040b" /><stop offset="1" stopColor="#360a1d" /></linearGradient>
          <linearGradient id="env-rack-side" x1="0" y1="0" x2=".9" y2="1"><stop stopColor="#481023" /><stop offset=".27" stopColor="#14040d" /><stop offset="1" stopColor="#020208" /></linearGradient>
          <linearGradient id="env-rack-top" x1="0" y1="0" x2=".7" y2="1"><stop stopColor="#ffa0c2" /><stop offset=".23" stopColor="#b1375f" /><stop offset=".57" stopColor="#481029" /><stop offset="1" stopColor="#16060f" /></linearGradient>
          <linearGradient id="env-rack-edge" x1="0" y1="0" x2="1" y2="1"><stop stopColor="#ffb0d3" /><stop offset=".29" stopColor="#c94367" /><stop offset=".52" stopColor="#6d1530" /><stop offset=".8" stopColor="#fc2451" /><stop offset="1" stopColor="#79213a" /></linearGradient>
          <radialGradient id="env-rack-aura"><stop stopColor="#ff234d" stopOpacity=".28" /><stop offset=".6" stopColor="#ff1238" stopOpacity=".06" /><stop offset="1" stopColor="#ff1238" stopOpacity="0" /></radialGradient>
          <filter id="env-rack-bloom" x="-35%" y="-35%" width="170%" height="170%"><feGaussianBlur stdDeviation="2.4" /></filter>
        </defs>
        {group === "deployment" && (
          <g className="environmentUploadCloud">
            <path d="M57 40C37 42 40 16 58 20 63-5 96-4 102 18 120 13 132 32 117 42Z" />
            <path d="M80 37V18m-7 7 7-7 7 7" />
          </g>
        )}
        <g transform={group === "deployment" ? "translate(0 15)" : undefined}>
          <ellipse cx="89" cy="124" rx="76" ry="22" className="environmentRackAura" />
          <path d="M26 43 98 29 150 45 75 61Z" className="environmentRackTop" />
          <path d="M98 29 150 45 150 119 98 107Z" className="environmentRackSide" />
          <path d="M26 43 98 29 98 107 26 121Z" className="environmentRackFront" />
          <path d="M29 46 94 33 94 105 29 117Z" className="environmentRackPanel" />
          {Array.from({ length: 15 }, (_, row) => (
            <g key={row}>
              <path d={`M33 ${50 + row * 3.35} 90 ${38.8 + row * 3.35}`} className="environmentRackSlot" />
              {Array.from({ length: 9 }, (__, column) => (
                <path key={column} d={`M${34 + column * 6.15} ${49.8 + row * 3.35 - column * 1.205}l2.6-.51`} className="environmentRackVent" />
              ))}
            </g>
          ))}
          <path d="M27 44 98 30 147 45" className="environmentRackHighlightBloom" />
          <path d="M27 44 98 30 147 45" className="environmentRackHighlight" />
          {Array.from({ length: 8 }, (_, index) => (
            <g key={index}>
              <path d={`M107 ${52 + index * 7.5}l34 9v4l-34-9Z`} className="environmentRackSidePanel" />
              <path d={`M109 ${54 + index * 7.5}l3 .8`} className="environmentRackLedLine" style={{ animationDelay: `${-index * .34}s` }} />
            </g>
          ))}
          <path d="M31 108 93 96v8l-62 12Z" className="environmentRackLowerPanel" />
          <path d="M35 110l20-4" className="environmentRackLowerGlow" />
          <circle cx="85" cy="103.5" r="1.5" className="environmentRackLed" />
          <path d="M27 43 98 29 98 107 27 121Z" pathLength="100" className="environmentRackOrbit" />
          <path d="M26 125 98 112 150 126v14l-73 10-51-10Z" className="environmentRackBase" />
          <path d="M26 125 98 112v15l-72 13Z" className="environmentRackBaseFront" />
          <path d="M33 130 83 121m-50 13 41-7" className="environmentRackBaseSlot" />
          <circle cx="91" cy="121.5" r="1.3" className="environmentRackLed" />
        </g>
        <g className="environmentSpark"><path d="M114 27h14m-7-10v20" /><circle cx="121" cy="27" r="2.6" /></g>
      </svg>
    )}
    {group === "recognition" && <EnvironmentEqualizer />}
  </span>
);

const EnvironmentEqualizer = () => {
  const ref = useRef<SVGSVGElement | null>(null);
  useEffect(() => {
    const svg = ref.current;
    if (!svg) return;
    const bars = [...svg.querySelectorAll<SVGRectElement>("rect")];
    const reducedMotion = window.matchMedia?.("(prefers-reduced-motion: reduce)");
    let frame = 0;
    let start = performance.now();
    const paint = (now: number) => {
      const time = (now - start) / 1000;
      bars.forEach((bar, index) => {
        const envelope = Math.exp(-(((index - 16) / 6) ** 2));
        const rhythm = .55 + .45 * Math.sin(time * 1.7 + index * .61);
        const height = 9 + 100 * envelope * (.53 + .47 * rhythm) + 15 * Math.sin(index * .67 + time * .58) ** 2;
        bar.setAttribute("y", (134 - height).toFixed(2));
        bar.setAttribute("height", height.toFixed(2));
      });
      if (!reducedMotion?.matches && !document.hidden) frame = requestAnimationFrame(paint);
    };
    paint(performance.now());
    return () => cancelAnimationFrame(frame);
  }, []);
  return (
    <svg ref={ref} className="environmentEqualizer" viewBox="0 0 163 140">
      <defs><linearGradient id="environment-spectrum-color" x1="0" x2="0" y1="0" y2="1"><stop stopColor="#ffa7b9" /><stop offset=".24" stopColor="#ff345e" /><stop offset="1" stopColor="#b40733" stopOpacity="0" /></linearGradient></defs>
      {Array.from({ length: 23 }, (_, index) => <rect key={index} x={4 + index * 6.75} y="40" width="2.8" height="100" rx="1.3" opacity={.55 + index / 55} />)}
    </svg>
  );
};

export const SecretsSettings = () => {
  const t = useText();
  const notify = useNotify();
  const [entries, setEntries] = useState<DisplayEntry[] | null>(null);
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

  const { kaggleAction, kaggleElapsedSeconds, verifyKaggle, runKaggleAction } = useKaggleActions(setEntries);

  useEffect(() => {
    let active = true;
    void Promise.all([
      pythonClient.listEnvironmentSettings(),
      pythonClient.getAiProcessingSettings(),
    ])
      .then(([environment, settings]) => {
        if (!active) return;
        const loaded = [...environment];
        setEntries(loaded);
        void formikRef.current.setValues(valuesOf(loaded), false);
        for (const entry of environment.filter(
          (item) =>
            item.key !== "KAGGLE_API_TOKEN" &&
            item.configured &&
            item.value.trim(),
        )) {
          void pythonClient
            .verifyEnvironmentSetting(entry.key)
            .then((result) => active && replace(result, entry.value))
            .catch(() => undefined);
        }
        const account = environment.find((entry) => entry.key === "KAGGLE_API_TOKEN");
        if (kaggleDeploymentRunning()) {
          void runKaggleAction("deploy", false);
          return;
        }
        if (
          account?.configured &&
          account.value.trim() &&
          settings.processingBackend === "Kaggle" &&
          settings.kaggleConfigured
        ) void verifyKaggle().catch(() => undefined);
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
  }, [notify, replace, runKaggleAction, t, verifyKaggle]);

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
        const stored = await pythonClient.updateEnvironmentSetting(key, value);
        replace(
          {
            ...stored,
            state:
              key !== "KAGGLE_API_TOKEN" &&
              stored.configured &&
              stored.state !== "invalid"
                ? "checking"
                : stored.state,
          },
          value,
        );
        if (
          key !== "KAGGLE_API_TOKEN" &&
          stored.configured &&
          stored.state !== "invalid"
        )
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
    [notify, replace, t],
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
        end: (
          <span className="environmentFieldActions">
            {entry.kind === "secret" && entry.value.trim() && (
              <IconButton
                unstyled
                className="environmentCopyButton"
                icon={Copy}
                size="sm"
                label={t("environmentCopyValue")}
                onClick={() => void desktopClient.copyText(entry.value)}
              />
            )}
            <StatusMark state={state} message={message} />
          </span>
        ),
        onChange: (next: unknown) => changeEntry(entry.key, String(next ?? "")),
        ...(entry.kind === "file" && {
          browseLabel: t("selectFile"),
          onBrowse: () => fileInputs.current[entry.key]?.click(),
        }),
      };
    };
    const groupRows: FormRow[] = [];
    const cards: Partial<Record<EnvironmentGroup, ReactElement>> = {};
    for (const group of groupOrder) {
      const groupEntries = entries.filter(
        (entry) =>
          entry.group === group &&
          !fieldUi[entry.key]?.hidden &&
          (
            group !== "recognition" ||
            Boolean(entry.value.trim()) ||
            fieldUi[entry.key]?.showWhenEmpty
          ),
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
          : groupEntries.some((entry) => effectiveState(entry) === "unverified")
            ? "unverified"
          : configured
            ? "valid"
            : "empty";
      const presentation = groupUi[group];
      const GroupIcon = presentation.icon;
      cards[group] = (
          <section
            key={group}
            className="environmentGroupCard"
            data-group={group}
            data-state={state}
          >
            <EnvironmentArtwork group={group} />
            <header className="environmentGroupHeader">
              <span className="environmentGroupIcon">
                <GroupIcon size={20} aria-hidden />
              </span>
              <span className="environmentGroupCopy">
                <strong>{t(presentation.title)}</strong>
                <small>{t(presentation.hint)}</small>
              </span>
            </header>
            {group === "kaggle" && (
              <span className="environmentGpuBadge" aria-hidden>
                <Microchip /> GPU
              </span>
            )}
            <RenderFormikFields
              formik={formik}
              items={basic}
              rowSpacing={1.5}
            />
            {group === "kaggle" && kaggleAction === "deploy" && (
              <div className="environmentKaggleProgress" role="status">
                <div
                  className="environmentKaggleProgressTrack"
                  role="progressbar"
                  aria-label={t("kaggleDeployProgressLabel")}
                  aria-valuetext={t("kaggleDeployProgressTitle")}
                >
                  <span />
                </div>
                <strong>{t("kaggleDeployProgressTitle")}</strong>
                <small>{t("kaggleDeployProgressTiming", {
                  elapsed: formatElapsed(kaggleElapsedSeconds),
                })}</small>
              </div>
            )}
            {group === "kaggle" && state !== "valid" && state !== "checking" && (
              <div className="environmentKaggleActions">
                <Button
                  size="sm"
                  variant="outlined"
                  tone="neutral"
                  startIcon={kaggleAction === "login"
                    ? <LoaderCircle className="environmentActionSpinner" size={15} />
                    : <LogIn size={15} />}
                  disabled={kaggleAction !== null}
                  onClick={() => void runKaggleAction("login")}
                >
                  {t("kaggleLogin")}
                </Button>
                <Button
                  size="sm"
                  startIcon={kaggleAction === "deploy"
                    ? <LoaderCircle className="environmentActionSpinner" size={15} />
                    : <Rocket size={15} />}
                  disabled={kaggleAction !== null}
                  onClick={() => void runKaggleAction("deploy")}
                >
                  {t("kaggleDeploy")}
                </Button>
              </div>
            )}
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
      );
    }
    if (cards.kaggle || cards.room) {
      groupRows.push({
        key: "group-top",
        md: 12,
        render: () => (
          <div className="environmentTopRow">
            {cards.kaggle}
            {cards.room}
          </div>
        ),
      });
    }
    if (cards.recognition) {
      groupRows.push({
        key: "group-recognition",
        md: 12,
        render: () => cards.recognition,
      });
    }
    if (cards.deployment) {
      groupRows.push({
        key: "group-deployment",
        md: 12,
        render: () => cards.deployment,
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
  }, [applyJson, changeEntry, entries, formik, jsonFormik, kaggleAction, kaggleElapsedSeconds, runKaggleAction, t]);

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
