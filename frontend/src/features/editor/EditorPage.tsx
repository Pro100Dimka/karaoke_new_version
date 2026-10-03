import "./editor.css";
import { useEffect, useState, type CSSProperties } from "react";
import { useNavigate, useParams } from "react-router-dom";
import { AlertTriangle, ArrowLeft } from "lucide-react";
import { routes } from "../../app/routes";
import { useText } from "../../i18n/useText";
import { Spinner } from "../../shared/ui/Spinner";
import { Button } from "../../theme/ui";
import { NeonFrame } from "../../shared/ui/NeonFrame";
import { EditorHeader, MeIcon } from "./EditorHeader";
import { EditorSurface } from "./EditorSurface";
import { EditorTransport } from "./EditorTransport";
import { documentEnd } from "./editorModel";
import { useEditorSession } from "./useEditorSession";

const isEditingText = (target: EventTarget | null): boolean =>
  target instanceof HTMLElement && ["INPUT", "TEXTAREA", "SELECT"].includes(target.tagName);

const modes = [
  ["notes", "music", "Ноты"], ["text", "document", "Текст"], ["rhythm", "wave", "Ритм"], ["grid", "grid", "Сетки"]
] as const;
const tools = [["select", "cursor"], ["draw", "pencil"], ["erase", "eraser"], ["split", "scissors"], ["pan", "mouse"]] as const;

export const EditorPage = () => {
  const navigate = useNavigate();
  const { songId = "" } = useParams<{ songId: string }>();
  const t = useText();
  const session = useEditorSession(songId);
  const [zoom, setZoom] = useState(1);
  const [follow] = useState(true);
  const [snap, setSnap] = useState(true);
  const [mode, setMode] = useState("notes");
  const [tool, setTool] = useState("select");
  const [audition, setAudition] = useState(false);
  const [scale, setScale] = useState(1);
  const { document, selection } = session;

  const leave = async () => {
    if (await session.resolveUnsaved()) navigate(routes.library);
  };

  useEffect(() => {
    const fit = () => setScale(Math.min(1, window.innerWidth / 1280, window.innerHeight / 698));
    fit();
    window.addEventListener("resize", fit);
    return () => window.removeEventListener("resize", fit);
  }, []);

  useEffect(() => {
    const handler = (event: KeyboardEvent) => {
      if (isEditingText(event.target)) return;
      const command = event.ctrlKey || event.metaKey;
      if (command && event.key.toLowerCase() === "s") { event.preventDefault(); void session.save(); }
      else if (command && event.key.toLowerCase() === "z") { event.preventDefault(); session.undo(); }
      else if (command && ["y", "z"].includes(event.key.toLowerCase()) && event.shiftKey) { event.preventDefault(); session.redo(); }
      else if (event.key === "Delete" && selection.size > 0) { event.preventDefault(); session.remove(selection); }
      else if (event.code === "Space" && !(event.target instanceof HTMLButtonElement)) { event.preventDefault(); void session.togglePlay(); }
    };
    window.addEventListener("keydown", handler);
    return () => window.removeEventListener("keydown", handler);
  }, [session, selection]);

  const back = <Button startIcon={<ArrowLeft size={16} />} onClick={() => navigate(routes.library)}>{t("library")}</Button>;
  if (session.load.kind === "loading" || (session.load.kind === "ready" && !document)) {
    return <main className="editorPage editorState" aria-live="polite"><Spinner label={t("loadingEditor")} /></main>;
  }
  if (session.load.kind === "failed" || session.load.kind === "invalid") {
    const message = session.load.kind === "invalid" && session.load.compatibility === "TooNew" ? t("errorProjectTooNew")
      : session.load.kind === "invalid" && session.load.compatibility !== "NotReady" ? t("errorProjectUpgrade") : t("editorLoadFailed");
    return <main className="editorPage editorState" role="alert"><AlertTriangle aria-hidden size={36} /><p>{message}</p>{back}</main>;
  }
  if (!document || session.load.kind !== "ready") return null;

  const song = session.load.song;
  const duration = documentEnd(document, song.durationSeconds);
  const sceneStyle = { "--me-scale": scale } as CSSProperties;

  return (
    <main className="editorPage">
      <div className="me-viewport" style={{ width: 1280 * scale, height: 698 * scale }}>
        <div className="me-scene" style={sceneStyle} data-motion="on" data-mode={mode} data-grid={mode === "grid" ? "off" : "on"}>
          <EditorHeader title={`${song.title} — ${song.artist}`} revision={document.revision} dirty={session.dirty} onBack={() => void leave()} />
          <EditorTransport playing={session.playing} position={session.position} duration={duration} audioReady={session.audioReady} onTogglePlay={() => void session.togglePlay()} onPositionChange={value => void session.seek(value)} />

          <section className="me-panel me-toolbar" aria-label="Инструменты редактора">
            <NeonFrame order={1} />
            <div className="me-modes">
              {modes.map(([id, icon, label]) => <button key={id} className={`me-glass me-mode${mode === id ? " me-ruby" : ""}`} type="button" onClick={() => setMode(id)}><MeIcon name={icon} /><span>{label}</span></button>)}
            </div>
            <div className="me-tools">
              {tools.map(([id, icon]) => <button key={id} className={`me-glass me-tool${tool === id ? " me-ruby" : ""}`} type="button" aria-label={id} onClick={() => setTool(id)}><MeIcon name={icon} /></button>)}
            </div>
            <div className="me-select me-root"><select aria-label="Тональность" defaultValue="C#4"><option>C#4</option><option>D4</option><option>E4</option></select><MeIcon name="chevron" className="me-chevron" /></div>
            <div className="me-select me-scale-mode"><select aria-label="Лад" defaultValue="none"><option value="none">Лад</option><option>Мажор</option><option>Минор</option></select><MeIcon name="chevron" className="me-chevron" /></div>
            <button className="me-glass me-more" type="button" onClick={() => setSnap(value => !value)}><MeIcon name="sliders" /><span>Ещё</span></button>
          </section>

          <EditorSurface document={document} selection={selection} zoom={zoom} durationSeconds={duration} position={session.position} follow={follow} snap={snap} playing={session.playing} tool={tool} onSelect={session.select} onSeek={value => void session.seek(value)} onPreview={session.replacePresent} onCommit={session.commit} onNudge={(id, pitch, seconds) => session.move(new Set([id]), pitch, seconds)} />

          <footer className="me-panel me-footer">
            <NeonFrame order={3} />
            <div className="me-zoom-step">
              <button className="me-glass" type="button" aria-label="Уменьшить масштаб" onClick={() => setZoom(value => Math.max(.5, value - .25))}><MeIcon name="minus" /></button>
              <button className="me-glass" type="button" aria-label="Увеличить масштаб" onClick={() => setZoom(value => Math.min(2, value + .25))}><MeIcon name="plus" /></button>
            </div>
            <div className="me-select me-zoom"><select aria-label="Масштаб нот" value={String(zoom * 100)} onChange={event => setZoom(Number(event.target.value) / 100)}>{[50, 75, 100, 125, 150, 200].map(value => <option key={value} value={value}>{value}%</option>)}</select><MeIcon name="chevron" className="me-chevron" /></div>
            <button className="me-glass me-fit" type="button" aria-label="Показать исходный фрагмент" onClick={() => setZoom(1)}><MeIcon name="fit" /></button>
            <button className="me-glass me-audition" type="button" aria-label="Прослушивание нот" aria-pressed={audition} onClick={() => setAudition(value => !value)}><MeIcon name="wave" /></button>
            <p className="me-hint"><MeIcon name="bulb" /><span>Перетаскивайте ноты, чтобы изменить высоту и длительность</span></p>
            <div className="me-history">
              <button className="me-glass" type="button" aria-label="Отменить" disabled={!session.canUndo} onClick={session.undo}><MeIcon name="undo" /></button>
              <button className="me-glass" type="button" aria-label="Повторить" disabled={!session.canRedo} onClick={session.redo}><MeIcon name="redo" /></button>
            </div>
            <div className="me-save-group me-ruby">
              <button className="me-glass" id="me-save" type="button" aria-label="Сохранить проект" disabled={session.saving} onClick={() => void session.save()}><MeIcon name="save" /><span>Сохранить</span></button>
              <button className="me-glass" id="me-save-menu" type="button" aria-label="Экспорт и импорт проекта"><MeIcon name="chevron" /></button>
            </div>
          </footer>
        </div>
      </div>
    </main>
  );
};
