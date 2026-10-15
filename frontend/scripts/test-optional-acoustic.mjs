/** Targeted checks of production modules with controlled hooks/IPC and a JSX object tree.
 * No browser, React renderer, Electron, physical device or network connection is simulated here.
 * Run from frontend: node scripts/test-optional-acoustic.mjs (requires existing typescript dev dep).
 */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";
import vm from "node:vm";
import ts from "typescript";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
let checks = 0;
const check = (label, run) => { run(); ++checks; console.log(`PASS ${label}`); };
const load = (file, imports = {}, globals = {}) => {
  const source = readFileSync(resolve(root, file), "utf8");
  const out = ts.transpileModule(source, {
    fileName: file,
    reportDiagnostics: true,
    compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS,
      jsx: ts.JsxEmit.ReactJSX, esModuleInterop: true },
  });
  assert.equal((out.diagnostics ?? []).filter((d) => d.category === ts.DiagnosticCategory.Error).length, 0,
    `Syntax errors in ${file}`);
  const module = { exports: {} };
  const require = (name) => {
    if (!(name in imports)) throw new Error(`Unprovided dependency ${name} in ${file}`);
    return imports[name];
  };
  vm.runInNewContext(out.outputText, { module, exports: module.exports, require, console, ...globals }, { filename: file });
  return module.exports;
};
const plain = (value) => JSON.parse(JSON.stringify(value));
const { runtimeConfigurationFromDiagnostics: runtime } = load("src/services/audioProtocol.ts");
const baseline = { RuntimeOutputSampleRate: "48000", MonitoringLatencyFrames: "1519",
  LocalCaptureDeviceMs: "10", ReportedInputLatencyHns: "0",
  LocalAudioServiceInternalMs: "5.56", LocalResamplerDspMs: "2",
  LocalRenderQueueMs: "10", LocalEndpointOutputMs: "6.08" };
check("fresh uncalibrated profile gets an available driver model", () => {
  const r = runtime(baseline);
  assert.equal(r.estimatedLatencyMs, 1519 / 48);
  assert.equal(r.latencyEstimateSource, "driver-model");
  assert.equal(r.calibratedLatencyMs, undefined);
});
check("device timeline replaces, rather than adds to, the stage model", () => {
  const r = runtime({ ...baseline, LocalObservedMonitoringMs: "34.125" });
  assert.equal(r.estimatedLatencyMs, 34.125);
  assert.equal(r.latencyEstimateSource, "device-timeline");
  assert.deepEqual(plain(r.latencyParts), { inputMs: 10, inputReportedMs: 0, outputMs: 16.08,
    appMs: 7.56, bridgeMs: 5.56, dspMs: 2 });
});
check("saved 45.2 ms correction is preserved separately, not quietly lost or counted as CPU", () => {
  const r = runtime({ ...baseline, LocalObservedMonitoringMs: "34.125",
    AcousticLatencyUs: "45200", AcousticCalibrationValid: "1", AcousticCalibrationOrigin: "PROFILE" });
  assert.equal(r.estimatedLatencyMs, 34.125);
  assert.equal(r.calibratedLatencyMs, 45.2);
  assert.equal(r.calibrationOrigin, "PROFILE");
});
for (const missing of ["", "UNKNOWN", "-1", "NaN", "Infinity"]) {
  check(`unknown observation '${missing}' falls back explicitly, never defaults to 45 or zero`, () => {
    const r = runtime({ ...baseline, LocalObservedMonitoringMs: missing });
    assert.equal(r.latencyEstimateSource, "driver-model");
    assert.equal(r.estimatedLatencyMs, 1519 / 48);
  });
}
check("no device data means unavailable, not zero", () => {
  const r = runtime({}); assert.equal(r.estimatedLatencyMs, null);
  assert.equal(r.latencyEstimateSource, "unavailable");
});
check("an output-only session does not invent a microphone-monitoring delay", () => {
  assert.equal(runtime({ ...baseline, LocalCaptureEstimateSource: "NO_CAPTURE" }).estimatedLatencyMs, null);
});
check("callback elapsed time is separate and unsampled zeros are unknown", () => {
  const r = runtime({ ...baseline, RenderCallbackSamples: "256", RenderCallbackP95Us: "120",
    CaptureCallbackSamples: "0", CaptureCallbackP95Us: "0", RenderJitWaitOnlySamples: "42",
    RenderJitWaitOnlyP95Us: "3400", RenderJitDeadlineOvershootSamples: "42", RenderJitDeadlineOvershootP95Us: "0" });
  assert.deepEqual(plain(r.latencyTiming), { renderCallbackP95Ms: 0.12, captureCallbackP95Ms: null,
    jitWaitP95Ms: 3.4, deadlineOvershootP95Ms: 0 });
  assert.equal(r.estimatedLatencyMs, 1519 / 48);
});
check("unknown negative stage cannot cancel against positive DSP", () => {
  assert.equal(runtime({ LocalAudioServiceInternalMs: "-1", LocalResamplerDspMs: "10" }).latencyParts.appMs, null);
});
check("verified acoustic zero is distinct from missing/empty acoustic data", () => {
  assert.equal(runtime({ AcousticCalibrationValid: "1", AcousticLatencyUs: "0" }).calibratedLatencyMs, 0);
  assert.equal(runtime({ AcousticCalibrationValid: "1", AcousticLatencyUs: "" }).calibratedLatencyMs, undefined);
});
check("negotiated periods and actual CPU fallback reason survive unchanged", () => {
  const r = runtime({ ...baseline, RequestedPeriodFrames: "128", SelectedPeriodFrames: "128",
    RuntimeOutputPeriodFrames: "480", RuntimeInputPeriodFrames: "240",
    SharedEnginePeriodFallback: "CPU_USAGE_EXCEEDED" });
  assert.equal(r.periodFrames, 480); assert.equal(r.inputPeriodFrames, 240);
  assert.equal(r.sharedPeriodFallback, "CPU_USAGE_EXCEEDED");
});
const translations = Object.fromEntries(["ru", "en", "uk"].map((language) => {
  const module = load(`src/i18n/messages.${language}.audio.ts`);
  return [language, module[Object.keys(module)[0]]];
}));
check("all three locales cover the new estimate and CPU distinctions", () => {
  for (const key of Object.keys(translations.ru)) {
    assert.ok(key in translations.en, `missing en ${key}`);
    assert.ok(key in translations.uk, `missing uk ${key}`);
  }
  for (const text of Object.values(translations)) {
    assert.ok(!("acousticSetupBody" in text));
    assert.ok(text.latencyBoundaryHint && text.latencyTimingNotCpu && text.latencyOptionalAcoustic);
  }
});
const h = (type, props, key) => ({ type, props: props ?? {}, key });
const components = Object.fromEntries(["Card", "IconButton", "LevelMeter", "RotaryKnob", "Stack",
  "StatusIndicator", "Switch", "Tooltip", "Typography"].map((name) => [name, name]));
const { AudioTests } = load("src/features/settings/tabs/Audio/AudioTests.tsx", {
  "react/jsx-runtime": { jsx: h, jsxs: h },
  "@neo-ui-kit/react": { ...components, useFormContext: () => ({ values: { voiceGain: 1, noiseSuppression: 0 }, setValue() {} }) },
  "../../../../i18n/useText": { useText: () => (key, data = {}) => `${key}:${JSON.stringify(data)}` },
  "./AcousticCalibration": { AcousticCalibration: "AcousticCalibration" },
});
const children = (element) => Array.isArray(element) ? element.flatMap(children)
  : element && typeof element === "object" ? [element, ...children(element.props?.children)] : [];
const props = { runtime: runtime({ ...baseline, LocalObservedMonitoringMs: "34.125" }),
  audioAvailable: true, microphoneIssue: false, inputLevel: 0.2, testingInput: false,
  onToggleInputTest() {}, onPlayTestSound() { throw new Error("unsolicited sound"); } };
check("optional acoustic controls are collapsed in the normal view", () => {
  const elements = children(AudioTests(props));
  const details = elements.filter((e) => e.type === "details");
  assert.equal(details.length, 2); assert.ok(details.every((d) => !d.props.open));
  assert.ok(children(details[1]).some((e) => e.type === "AcousticCalibration"));
});
check("saved calibration does not silently change the scope of the main displayed figure", () => {
  for (const acoustic of [undefined, 45.2]) {
    const elements = children(AudioTests({ ...props, runtime: { ...props.runtime, calibratedLatencyMs: acoustic } }));
    const number = elements.find((e) => e.type === "Typography" && e.props.variant === "h3");
    assert.equal(number.props.children, 'approximateMillisecondsValue:{"value":34}');
  }
});
check("a preserved calibration is visibly applied, not hidden as a lower main latency", () => {
  const elements = children(AudioTests({ ...props, runtime: { ...props.runtime, calibratedLatencyMs: 45.2 } }));
  assert.ok(elements.some((e) => e.type === "Typography" &&
    e.props.children === 'latencyActiveCorrection:{"value":"45.20"}'));
  const fresh = children(AudioTests(props));
  assert.ok(!fresh.some((e) => typeof e.props.children === "string" && e.props.children.startsWith("latencyActiveCorrection:")));
});
check("monitor toggle only invokes the supplied self-monitor handler", () => {
  let changed = false;
  const toggle = children(AudioTests({ ...props, onToggleInputTest(value) { changed = value; } })).find((e) => e.type === "Switch");
  toggle.props.onValueChange(true); assert.equal(changed, true);
});

const flush = async () => { for (let i = 0; i < 10; ++i) await Promise.resolve(); };
const hookFixture = (stored = {}) => {
  const app = { preferences: { acousticLatencyMs: stored }, updates: [],
    updatePreferences(change) { this.updates.push(change); this.preferences = { ...this.preferences, ...change }; } };
  app.updatePreferences = app.updatePreferences.bind(app);
  let state = { fingerprint: "path,mic,out", origin: "NONE", milliseconds: null, songPlaying: false, songEstimates: 0 };
  let pending = null, cleanup, tick, clears = 0;
  const remembered = [];
  const client = {
    async rememberAcousticLatencies(values) { remembered.push({ ...values }); },
    acousticCalibrationState() { return pending ?? Promise.resolve(state); },
    measureAcousticLatency() { throw new Error("automatic acoustic test forbidden"); },
  };
  const { useAcousticLatencyAutoSave } = load("src/app/useAcousticLatencyAutoSave.ts", {
    react: { useRef: (value) => ({ current: value }), useEffect: (effect) => { cleanup = effect(); } },
    "../services/audioClient": { audioClient: client }, "./AppContext": { useApp: () => app },
  }, { window: { setInterval(fn) { tick = fn; return 123; }, clearInterval() { ++clears; } } });
  useAcousticLatencyAutoSave();
  return { app, remembered, setState(value) { state = { ...state, ...value }; },
    setPending(value) { pending = value; }, async tick() { tick(); await flush(); },
    stop() { cleanup(); }, clears() { return clears; } };
};
const fresh = hookFixture(); await flush();
fresh.setState({ songPlaying: true }); await fresh.tick();
fresh.setState({ songPlaying: false }); await fresh.tick(); await fresh.tick();
check("fresh-profile song then silence requires neither acoustic dialog nor test sound", () => {
  assert.equal(fresh.app.updates.length, 0); assert.ok(fresh.remembered.length >= 3);
});
fresh.stop();
const saved = hookFixture({ "old,mic,out": 44.7 }); await flush();
check("restoring a different current device never deletes historical checked profiles", () => {
  assert.equal(saved.remembered[0]["old,mic,out"], 44.7); assert.equal(saved.app.updates.length, 0);
});
saved.setState({ origin: "TEST_SIGNAL", milliseconds: 28.2 }); await saved.tick();
check("explicit diagnostic result is persisted alongside the old profile", () => {
  assert.equal(saved.app.preferences.acousticLatencyMs["old,mic,out"], 44.7);
  assert.equal(saved.app.preferences.acousticLatencyMs["path,mic,out"], 28.2);
});
saved.setState({ origin: "TEST_SIGNAL", milliseconds: Infinity }); await saved.tick();
check("non-finite optional result cannot overwrite a saved profile", () => {
  assert.equal(saved.app.preferences.acousticLatencyMs["path,mic,out"], 28.2);
});
let resolvePending;
saved.setPending(new Promise((resolve) => { resolvePending = resolve; })); await saved.tick();
const count = saved.app.updates.length; saved.stop();
resolvePending({ fingerprint: "new,mic,out", origin: "TEST_SIGNAL", milliseconds: 45 }); await flush();
check("late IPC response after unmount cannot write a calibration", () => {
  assert.equal(saved.app.updates.length, count); assert.equal(saved.clears(), 1);
});
console.log(`CHECKS ${checks}`);
