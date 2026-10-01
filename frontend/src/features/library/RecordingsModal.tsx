import { BarChart3, Check, ChevronDown, FolderOpen, Grid2X2, List, MoreHorizontal, Music2, Pencil, Plus, Trash2, X } from "lucide-react";
import { useEffect, useMemo, useRef, useState } from "react";
import type { RecordingDto, SongDto } from "../../contracts/models";
import type { MessageKey } from "../../i18n/messages";
import { useText } from "../../i18n/useText";
import { desktopClient } from "../../services/desktopClient";
import { formatBytes } from "../../shared/utils/format";
import { IconButton, Modal, RenderFormikFields, useGetForm } from "../../theme/ui";
import { SettingsNeonFrame } from "../settings/SettingsNeonFrame";
import performanceArtUrl from "./assets/performance-art.svg";
import performanceHeaderUrl from "./assets/performance-header.svg";
import { RecordingPlayer } from "./RecordingPlayer";
import { recordingStatusLabels } from "./songMetadataPresentation";
import { defaultTakeName, numberTakes } from "./takeNames";
import "./reference-modals.css";

interface Props { song: SongDto | null; recordings: readonly RecordingDto[]; onClose(): void; onAnalyze(recording: RecordingDto): void; onDelete(recording: RecordingDto): void; onRename(recording: RecordingDto, name: string): void; }
interface RecordingAction { id: "analyze" | "folder" | "delete"; label: MessageKey; icon: typeof BarChart3; destructive?: boolean; run(): void; }

const PerformancesHeaderArt = () => {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const [painted, setPainted] = useState(false);
  useEffect(() => {
    const canvas = canvasRef.current;
    const context = canvas?.getContext("2d", { willReadFrequently: true });
    if (!canvas || !context) return;
    const clamp = (value: number, low = 0, high = 1) => Math.max(low, Math.min(high, value));
    const random = (initialSeed: number) => {
      let seed = initialSeed;
      return () => {
        seed = (Math.imul(seed, 1664525) + 1013904223) | 0;
        return (seed >>> 0) / 4294967296;
      };
    };
    const table = Float32Array.from({ length: 65536 }, random(97131));
    const noise = (x: number, y: number) => {
      const ix = Math.floor(x), iy = Math.floor(y);
      let fx = x - ix, fy = y - iy;
      fx *= fx * (3 - 2 * fx); fy *= fy * (3 - 2 * fy);
      const at = (a: number, b: number) => table[(a & 255) + ((b & 255) << 8)]!;
      const a = at(ix, iy), b = at(ix + 1, iy), c = at(ix, iy + 1), d = at(ix + 1, iy + 1);
      return (a + (b - a) * fx) * (1 - fy) + (c + (d - c) * fx) * fy;
    };
    const fbm = (initialX: number, initialY: number, octaves = 5) => {
      let x = initialX, y = initialY, result = 0, amplitude = .53;
      for (let index = 0; index < octaves; index += 1) {
        result += noise(x, y) * amplitude;
        x = x * 2.07 + 17.8; y = y * 2.03 - 11.5; amplitude *= .48;
      }
      return result;
    };
    const sphere = (ctx: CanvasRenderingContext2D, cx: number, cy: number, radius: number, width: number, height: number, header: boolean) => {
      const image = ctx.getImageData(0, 0, width, height), data = image.data;
      for (let y = 0; y < height; y += 1) for (let x = 0; x < width; x += 1) {
        const dx = (x - cx) / radius, dy = (y - cy) / radius;
        const radial = Math.hypot(dx, dy), distance = (1 - radial) * radius;
        if (radial > 1 + 23 / radius) continue;
        const offset = (y * width + x) * 4;
        const side = header ? clamp(.7 - dx * .55, .08, 1) : clamp(.48 + dx * .74 + dy * .52, .02, 1);
        if (radial > 1) {
          const alpha = Math.exp(distance / 6.2) * side * .8;
          data[offset] = (data[offset] ?? 0) * (1 - alpha) + 253 * alpha;
          data[offset + 1] = (data[offset + 1] ?? 0) * (1 - alpha) + 20 * alpha;
          data[offset + 2] = (data[offset + 2] ?? 0) * (1 - alpha) + 62 * alpha;
          if (header) data[offset + 3] = Math.round(alpha * 255);
          continue;
        }
        const z = Math.sqrt(Math.max(0, 1 - radial * radial));
        const n = fbm(dx * 26 + z * 13, dy * 26 + z * 6, 5);
        const fissure = Math.pow(1 - Math.abs(2 * noise(dx * 112 + n * 9, dy * 98 + n * 11) - 1), 5);
        const light = header ? clamp(.8 - dx * .5 - z * 1.1, .02, 1) : clamp(.1 + dx * .85 + dy * .5 - z * .7, .01, .6);
        const rim = Math.exp(-Math.max(0, distance) / (header ? 1.05 : 1.85)) * side;
        const haze = Math.exp(-Math.max(0, distance) / (header ? 8 : 11)) * side;
        const rock = (7 + n * 50 + fissure * 145 * clamp((n - .32) * 3)) * light;
        data[offset] = 3 + rock + rim * 252 + haze * 54;
        data[offset + 1] = 5 + rock * .09 + rim * 197 + haze * 8;
        data[offset + 2] = 10 + rock * .25 + rim * 204 + haze * 22;
        data[offset + 3] = 255;
      }
      ctx.putImageData(image, 0, 0);
    };
    sphere(context, 1230, 390, 506, 1230, 156, true);
    setPainted(true);
  }, []);
  return <><img className="performancesHeaderArt" src={performanceHeaderUrl} alt="" aria-hidden="true" hidden={painted} /><canvas ref={canvasRef} className="performancesHeaderTexture" width="1230" height="156" aria-hidden="true" /></>;
};
const PerformancesSignature = () => <svg className="performancesSignature" viewBox="0 0 194 50" role="img" aria-label="Performances"><g fill="none" stroke="currentColor" strokeWidth="1.2" strokeLinecap="round" strokeLinejoin="round"><path d="M8 45C12 34 20 16 25 9C33 -2 48 6 37 16C30 22 17 27 11 25M15 36C26 28 31 21 24 18"/><path d="M30 32C36 29 39 23 35 25C28 28 26 39 35 33L43 26C46 21 43 25 41 31L48 26Q54 23 52 27"/><path d="M48 47C52 36 54 24 60 18C68 9 71 9 67 15C63 22 57 26 52 28M50 28L65 25"/><path d="M66 25C61 25 59 38 65 32C69 28 70 23 66 25M65 33L76 25Q80 20 76 28L82 24Q87 23 84 27"/><path d="M81 33L88 23Q92 19 88 27L96 22Q101 20 96 28L104 23Q112 17 107 27C104 34 112 28 116 24"/><path d="M120 23C119 17 110 28 114 31C118 32 124 20 123 22L120 29C120 33 127 26 130 24"/><path d="M128 30L134 21Q138 19 134 27L142 21Q148 16 144 25C139 35 150 25 155 22"/><path d="M160 18C159 14 150 22 151 27C152 31 161 22 165 20"/><path d="M163 23C170 20 174 12 168 16C160 21 159 30 169 24L179 17"/><path d="M184 13C172 15 186 24 177 28C171 31 178 24 189 17"/></g></svg>;

const RecordingItem = ({ recording, name, index, onRename, onAnalyze, onDelete }: { recording: RecordingDto; name: string; index: number; onRename(name: string): void; onAnalyze(recording: RecordingDto): void; onDelete(recording: RecordingDto): void; }) => {
  const t = useText();
  const statuses = recordingStatusLabels(recording.fileStatus ?? "Ready", recording.analysisStatus ?? "NotAnalyzed");
  const [editing, setEditing] = useState(false);
  const formik = useGetForm({ initialValues: { name }, enableReinitialize: false, onSubmit: values => { onRename(values.name); setEditing(false); } });
  const actions = [
    { id: "analyze", label: "recordingAnalyze", icon: BarChart3, run: () => onAnalyze(recording) },
    { id: "folder", label: "openFolder", icon: FolderOpen, run: () => void desktopClient.revealInExplorer(recording.filePath) },
    { id: "delete", label: "recordingDelete", icon: Trash2, destructive: true, run: () => onDelete(recording) }
  ] satisfies readonly RecordingAction[];
  return <li className="performanceCard">
    <SettingsNeonFrame order={index + 1} />
    <div className="performanceArtwork"><svg viewBox="0 0 240 204" role="img" aria-label=""><use href={`${performanceArtUrl}#pf-art-${index % 6 + 1}`} /></svg></div>
    <div className="performanceCopy">
      {editing ? <form noValidate onSubmit={formik.handleSubmit}><RenderFormikFields formik={formik} items={[{ tag: "name", autoFocus: true, "aria-label": t("renameTake"), end: <IconButton type="submit" size="sm" variant="ghost" icon={Check} label={t("save")} /> }]} /></form> : <div className="performanceName"><strong>{name}</strong><button type="button" aria-label={t("renameTake")} onClick={() => { formik.resetForm({ values: { name } }); setEditing(true); }}><Pencil /></button></div>}
      <span>{statuses.map(key => t(key)).join("  •  ")}</span>
    </div>
    <RecordingPlayer recording={recording} />
    <div className="performanceActions">{actions.map(({ id, label, icon: ActionIcon, destructive, run }) => <button key={id} type="button" className={destructive ? "danger" : undefined} aria-label={t(label)} onClick={run}><ActionIcon /></button>)}<button type="button" aria-label="Ещё"><MoreHorizontal /></button></div>
  </li>;
};

export const RecordingsModal = ({ song, recordings, onClose, onAnalyze, onDelete, onRename }: Props) => {
  const t = useText();
  const [view, setView] = useState<"grid" | "list">("list");
  const numbers = useMemo(() => numberTakes(recordings), [recordings]);
  const totalSize = useMemo(() => recordings.reduce((sum, recording) => sum + recording.sizeBytes, 0), [recordings]);
  if (!song) return null;
  const nameOf = (recording: RecordingDto) => recording.displayName || defaultTakeName(numbers.get(recording.id) ?? 1, recording.createdAt);
  return <Modal isOpen onClose={onClose} ariaLabel={`${t("recordings")} · ${song.title}`} closeAriaLabel={t("closeDialog")} portal tilt={false} maxWidth="none" modalClassName="performancesReferenceModal" closeClassName="libraryReferenceHiddenClose" neonFrame={<SettingsNeonFrame className="libraryReferenceShellFrame" variant="shell" order={0} />}>
    <div className="performancesScene">
      <header className="performancesHeader"><PerformancesHeaderArt/><div className="performancesTitleIcon"><Music2 /><span className="performanceTileSpark top"/><span className="performanceTileSpark bottom"/></div><div className="performancesTitle"><b>{t("songPerformances")}</b><h2>{song.title}</h2><p>{t("recordingsHint")}</p></div><PerformancesSignature/><button type="button" className="libraryReferenceClose" onClick={onClose}><X />{t("close")}</button></header>
      <main className="performancesWell">{recordings.length ? <ul className="performancesList" data-view={view}>{recordings.map((recording, index) => <RecordingItem key={recording.id} recording={recording} index={index} name={nameOf(recording)} onRename={value => onRename(recording, value)} onAnalyze={onAnalyze} onDelete={onDelete}/>)}</ul> : <p className="performancesEmpty">{t("noRecordings")}</p>}</main>
      <footer className="performancesFooter"><div className="performanceAdd"><button type="button" className="performanceAddMain"><Plus />Добавить запись</button><button type="button" className="performanceAddMore" aria-label="Другие способы добавления"><ChevronDown /></button></div><div className="performanceView"><button type="button" className={view === "grid" ? "active" : undefined} onClick={() => setView("grid")} aria-label="Сетка" aria-pressed={view === "grid"}><Grid2X2 /></button><button type="button" className={view === "list" ? "active" : undefined} onClick={() => setView("list")} aria-label="Список" aria-pressed={view === "list"}><List /></button></div><span>{recordings.length} записей</span><DatabaseLabel/><b>Общий размер: {formatBytes(totalSize)}</b></footer>
    </div>
  </Modal>;
};

const DatabaseLabel = () => <svg className="performanceDatabase" viewBox="0 0 24 24" aria-hidden="true"><ellipse cx="12" cy="5" rx="7" ry="3"/><path d="M5 5v6c0 1.7 3.1 3 7 3s7-1.3 7-3V5M5 11v6c0 1.7 3.1 3 7 3s7-1.3 7-3v-6"/></svg>;
