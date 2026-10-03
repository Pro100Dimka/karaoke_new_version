import { Activity, AudioWaveform, Check, ChevronLeft, Music2, Sparkles, Target, Timer, Trash2, X } from "lucide-react";
import { useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import type { StudioMasterProgress } from "../../contracts/clients";
import type { AnalysisDto, RecordingDto } from "../../contracts/models";
import { useText } from "../../i18n/useText";
import { Modal } from "../../theme/ui";
import { NeonFrame } from "../../shared/ui/NeonFrame";
import performanceArtUrl from "./assets/performance-art.svg";
import { analysisMetrics, gradeLabel, weakestMetric, type AnalysisMetricKey } from "./analysisPresentation";
import { RecordingPlayer } from "./RecordingPlayer";
import performanceDefs from "./assets/performance-analysis-defs.svg?raw";
import performanceHeader from "./assets/performance-analysis-header.svg?raw";
import performanceLandscape from "./assets/performance-analysis-landscape.svg?raw";
import performanceSkins from "./assets/performance-analysis-skins.svg?raw";
import "./analysis.css";

interface PerformanceAnalysisModalProps {
  analysis: AnalysisDto | null;
  recordings: readonly RecordingDto[];
  onDelete(recording: RecordingDto): void;
  onCreateStudioMaster(recording: RecordingDto): void;
  studioMaster: StudioMasterProgress | null;
  onClose(): void;
}

const takeList = (recordings: readonly RecordingDto[], analysis: AnalysisDto): readonly RecordingDto[] =>
  recordings.some(recording => recording.id === analysis.recordingId)
    ? recordings.filter(recording => !recording.sourceRecordingId)
    : [...recordings.filter(recording => !recording.sourceRecordingId), { id: analysis.recordingId, filePath: "", songId: "", displayName: "", createdAt: "", durationSeconds: 0, sizeBytes: 0, analyzed: true }];

const metricIcons = { pitch: Music2, rhythm: Activity, stability: Timer } satisfies Record<AnalysisMetricKey, typeof Music2>;
type ReferenceSkin = "shell" | "navigator" | "original" | "master" | "studio" | AnalysisMetricKey | "recommendation";
const referenceSkins = Object.fromEntries(
  [...performanceSkins.matchAll(/<svg data-pa-skin="([^"]+)"[\s\S]*?<\/svg>/g)].map(match => [match[1], match[0]]),
) as Record<ReferenceSkin, string>;
const landscapeFlowPattern = /<path class="pa-flow"[\s\S]*?\/>/g;
const landscapeFlowPaths = performanceLandscape.match(landscapeFlowPattern) ?? [];
const performanceLandscapeStatic = performanceLandscape.replace(landscapeFlowPattern, "");
const performanceLandscapeMotion = `<svg viewBox="0 0 1177 152" fill="none" aria-hidden="true">${landscapeFlowPaths.join("")}</svg>`;
const ReferenceArt = ({ markup, className }: { markup: string; className: string }) =>
  <div className={className} aria-hidden="true" dangerouslySetInnerHTML={{ __html: markup }} />;
const ReferencePanel = ({ className, skin, children }: { className: string; skin: ReferenceSkin; children: ReactNode }) => <section className={`paPanel ${className}`}><ReferenceArt markup={referenceSkins[skin]} className="paSkinArt"/><NeonFrame />{children}</section>;

const AnalysisArtwork = ({ landscape = false }: { landscape?: boolean }) => {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  useEffect(() => {
    const canvas = canvasRef.current;
    const context = canvas?.getContext("2d");
    if (!canvas || !context) return;
    const clamp = (value: number, low = 0, high = 1) => Math.max(low, Math.min(high, value));
    let seed = 8319;
    const random = () => { seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0; return seed / 4294967296; };
    const table = Float32Array.from({ length: 65536 }, random);
    const noise = (x: number, y: number) => {
      const a = Math.floor(x), b = Math.floor(y);
      let u = x - a, v = y - b;
      u = u * u * (3 - 2 * u); v = v * v * (3 - 2 * v);
      const get = (i: number, j: number) => table[(i & 255) + ((j & 255) << 8)]!;
      const p = get(a, b), q = get(a + 1, b), r = get(a, b + 1), s = get(a + 1, b + 1);
      return (p + (q - p) * u) * (1 - v) + (r + (s - r) * u) * v;
    };
    const fbm = (initialX: number, initialY: number, octaves = 5) => {
      let x = initialX, y = initialY, value = 0, weight = .5;
      for (let index = 0; index < octaves; index += 1) { value += noise(x, y) * weight; x = x * 2.09 + 9.2; y = y * 2.03 - 4.3; weight *= .5; }
      return value;
    };
    if (!landscape) {
      const image = context.createImageData(canvas.width, canvas.height);
      for (let y = 0; y < canvas.height; y += 1) for (let x = 610; x < canvas.width; x += 1) {
        const edge = 679 - Math.hypot(x - 568, y - 571);
        const n = fbm(x * .026, y * .032), crag = fbm(x * .15 + n * 5, y * .17 - n * 7, 4);
        const ridge = Math.pow(1 - Math.abs(2 * crag - 1), 4);
        let red = 0, green = 0, blue = 0, alpha = clamp((x - 610) / 150);
        if (edge >= 0) {
          const light = .08 + .95 * Math.exp(-edge / 145), crust = Math.max(0, n - .38) * 3.4 * ridge;
          const terrain = (8 + 95 * crust + n * 22) * light, hot = Math.exp(-edge / 15), white = Math.exp(-edge / 2.5);
          red = 4 + terrain * .69 + hot * 95 + white * 222; green = 6 + terrain * .19 + hot * 7 + white * 154; blue = 12 + terrain * .38 + hot * 29 + white * 169;
        } else {
          const hot = Math.exp(edge / 8.2), dust = Math.max(0, crag - .6) * 65;
          red = 6 + hot * 182 + dust; green = 5 + hot * 28 + dust * .16; blue = 11 + hot * 61 + dust * .25; alpha *= clamp((65 + edge) / 40);
        }
        const offset = (y * canvas.width + x) * 4;
        image.data[offset] = red; image.data[offset + 1] = green; image.data[offset + 2] = blue; image.data[offset + 3] = alpha * 255;
      }
      context.putImageData(image, 0, 0);
      for (let index = 0; index < 1600; index += 1) {
        const x = 760 + random() * 470, y = random() * 130, edge = 679 - Math.hypot(x - 568, y - 571);
        if (edge > 70 && random() > .12) continue;
        const bright = random(), radius = .15 + bright * .62;
        context.fillStyle = `rgba(255,${40 + Math.floor(bright * 80)},${78 + Math.floor(bright * 65)},${.09 + bright * .46})`;
        context.beginPath(); context.arc(x, y, radius, 0, Math.PI * 2); context.fill();
      }
      return;
    }
    const anchors = [[140,139],[215,78],[255,90],[286,98],[344,116],[426,107],[520,112],[620,131],[703,102],[735,67],[753,73],[783,49],[800,39],[809,53],[822,65],[850,86],[886,112],[920,120],[948,117],[977,99],[997,80],[1017,91],[1042,92],[1071,66],[1088,66],[1108,73],[1137,73],[1161,54],[1177,61]] as const;
    const image = context.createImageData(canvas.width, canvas.height);
    let segment = 0;
    for (let x = 141; x < canvas.width; x += 1) {
      while (segment + 2 < anchors.length && x > anchors[segment + 1]![0]) segment += 1;
      const [x0, y0] = anchors[segment]!, [x1, y1] = anchors[segment + 1]!;
      const ridgeY = y0 + (y1 - y0) * ((x - x0) / (x1 - x0)) + (noise(x * .37, 17) - .5) * 5;
      for (let y = Math.floor(ridgeY); y < canvas.height; y += 1) {
        if (y < 0) continue;
        const n = fbm(x * .032, y * .06), ridges = Math.pow(1 - Math.abs(fbm(x * .21 + n * 4, y * .16 - n * 8, 4) * 2 - 1), 5);
        const depth = Math.max(0, y - ridgeY), edgeLight = Math.exp(-depth / 5.6), light = clamp((.52 - n) * 3);
        const terrain = (8 + n * 8 + ridges * 32 + edgeLight * 10) * (.2 + light * .65), offset = (y * canvas.width + x) * 4;
        image.data[offset] = 3 + terrain * 1.05; image.data[offset + 1] = 5 + terrain * .27; image.data[offset + 2] = 11 + terrain * .58; image.data[offset + 3] = 255 * clamp((x - 141) / 65) * clamp((y - ridgeY) * 1.5);
      }
    }
    context.putImageData(image, 0, 0);
  }, [landscape]);
  return <canvas ref={canvasRef} className={landscape ? "paLandscape" : "paHeaderTexture"} width={landscape ? 1177 : 1230} height={landscape ? 152 : 130} aria-hidden="true"/>;
};

export const PerformanceAnalysisModal = ({ analysis, recordings, onDelete, onCreateStudioMaster, studioMaster, onClose }: PerformanceAnalysisModalProps) => {
  const t = useText();
  const [viewedId, setViewedId] = useState(analysis?.recordingId);
  useEffect(() => setViewedId(analysis?.recordingId), [analysis?.recordingId]);
  const list = useMemo(() => (analysis ? takeList(recordings, analysis) : []), [recordings, analysis]);
  if (!analysis) return null;
  const index = Math.max(0, list.findIndex(recording => recording.id === viewedId));
  const viewed = list[index];
  if (!viewed) return null;
  const previous = list[index - 1], next = list[index + 1];
  const active = viewed.id === analysis.recordingId;
  const practice = weakestMetric(analysis);
  const mastering = studioMaster?.recordingId === viewed.id ? studioMaster : null;
  const master = recordings.find(recording => recording.sourceRecordingId === viewed.id);
  const date = viewed.createdAt ? new Intl.DateTimeFormat("ru-RU", { day: "2-digit", month: "2-digit", year: "numeric", hour: "2-digit", minute: "2-digit", second: "2-digit" }).format(new Date(viewed.createdAt)).replace(",", "") : t("recordingTake");

  return <Modal isOpen onClose={onClose} ariaLabel={t("performanceAnalysis")} closeAriaLabel={t("closeDialog")} portal tilt={false} maxWidth="none" modalClassName="performanceAnalysisReferenceModal" closeClassName="libraryReferenceHiddenClose" neonFrame={<NeonFrame className="paShellFrame" variant="shell" order={0} />}>
    <div className="paScene">
      <ReferenceArt markup={performanceDefs} className="paReferenceDefs"/>
      <ReferenceArt markup={referenceSkins.shell} className="paSkinArt paShellSkin"/>
      <header className="paHeader"><ReferenceArt markup={performanceHeader} className="paHeaderArt"/><AnalysisArtwork/><div className="paTile paHeaderTile"><AudioWaveform /></div><span className="paEyebrow">{t("analysisEyebrow")}</span><h1>{t("performanceAnalysis")}</h1><p>{t("analysisDescription")}</p><button type="button" className="paClose" aria-label={t("closeDialog")} onClick={onClose}><X /></button></header>
      <main className="paContent">
        <ReferencePanel className="paNavigator" skin="navigator"><button type="button" className="paRound paPrevious" disabled={!previous} aria-label={t("previousRecording")} onClick={() => previous && setViewedId(previous.id)}><ChevronLeft /></button><time>{date}</time><span>{t("recordingOf", { current: index + 1, total: list.length })}{active ? ` · ${t("beingAnalysed")}` : ""}</span><button type="button" className="paRound paNext" disabled={!next} aria-label={t("nextRecording")} onClick={() => next && setViewedId(next.id)}><ChevronLeft /></button></ReferencePanel>
        <ReferencePanel className="paOriginal" skin="original"><h2>{t("studioMasterSourceTitle")}</h2><RecordingPlayer key={viewed.id} recording={viewed}/><button type="button" className="paDelete" aria-label={t("recordingDelete")} onClick={() => onDelete(viewed)}><Trash2 /></button></ReferencePanel>
        {master && <ReferencePanel className="paMaster" skin="master"><div className="paMasterCover"><svg viewBox="0 0 240 204" aria-hidden="true"><use href={`${performanceArtUrl}#pf-art-4`}/></svg></div><h2>{t("studioMasterTitle")}</h2><p>{t("studioMasterReadyDescription")}</p><RecordingPlayer key={master.id} recording={master}/></ReferencePanel>}
        {active && <ReferencePanel className={`paStudio ${master ? "hasMaster" : ""}`} skin="studio"><div className="paTile"><Sparkles /></div><h2>{t("studioMasterTitle")}</h2><p>{t("studioMasterDescription")}</p>{!master && !mastering && <button type="button" onClick={() => onCreateStudioMaster(viewed)}><Sparkles/><span>{t("studioMasterCreate")}</span></button>}{mastering && <div className="paMastering"><i style={{ width: `${mastering.progress}%` }}/><span>{t("studioMasterProgressValue", { progress: mastering.progress })}</span></div>}</ReferencePanel>}
        {active && <div className={`paMetrics ${master ? "hasMaster" : ""}`}>{analysisMetrics.map(metric => { const Icon = metricIcons[metric.key]; return <ReferencePanel key={metric.key} className="paMetric" skin={metric.key}><div className="paTile"><Icon/></div><span>{t(metric.label)}</span><strong>{analysis[metric.key]}%</strong><div className="paMetricBar" role="meter" aria-valuemin={0} aria-valuemax={100} aria-valuenow={analysis[metric.key]}><i style={{ width: `${analysis[metric.key]}%` }}/></div><p>{t(metric.description)}</p></ReferencePanel>; })}</div>}
        {active && <ReferencePanel className={`paRecommendation ${master ? "hasMaster" : ""}`} skin="recommendation"><AnalysisArtwork landscape/><ReferenceArt markup={performanceLandscapeStatic} className="paLandscapeArt paLandscapeStatic"/><ReferenceArt markup={performanceLandscapeMotion} className="paLandscapeArt paLandscapeMotion"/><div className="paTile paTarget"><Target/></div><h2>{t(gradeLabel(analysis.score))}</h2><div className="paScore"><strong data-role="analysis-score">{analysis.score}</strong><span>{t("analysisOverall")}</span></div><b>{t("analysisRecommendation")}</b><p>{t(practice.advice)}</p></ReferencePanel>}
      </main>
      <button type="button" className="paDone" onClick={onClose}><Check/>{t("done")}</button>
    </div>
  </Modal>;
};
