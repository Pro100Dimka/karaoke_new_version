import { Activity, Check, Copy, LogOut, PanelLeftClose, PanelTopClose, PanelTopOpen, RefreshCw, Replace, WifiOff, X } from "lucide-react";
import type { RoomStateDto } from "../../contracts/models";
import { useText } from "../../i18n/useText";
import { ActionMenu, type ActionMenuItem } from "../../shared/ui/ActionMenu";
import { RoomHeaderSurface } from "./RoomHeaderSurface";
import { useTransferEta } from "./useTransferEta";

// The code is shown as the reference shows it: its first four groups; copying gives all of it.
const shownCode = (code: string): string => code.split("-").slice(0, 4).join("-");

export interface RoomHeadActions {
  copied: boolean;
  checkingSync: boolean;
  detached: boolean;
  onCopy(): void;
  onCollapse(): void;
  onCheckSync(): void;
  onDetach(): void;
  onAttach(): void;
  onCancelTransfer(): void;
  onRetryTransfer(): void;
  onReplaceProject(): void;
  onLeave(): void;
}

const TransferNote = ({ room, actions }: { room: RoomStateDto; actions: RoomHeadActions }) => {
  const t = useText();
  const minutes = useTransferEta(room.transferId ?? room.songId, room.transferProgress);
  if (room.connectionStatus === "reconnecting")
    return (
      <div className="roomHeadNote" role="status" aria-label={t("roomReconnecting")}>
        <WifiOff aria-hidden />{t("roomReconnecting")}
      </div>
    );
  if (room.transferError) {
    const conflict = room.transferConflict === true;
    const Icon = conflict ? Replace : RefreshCw;
    return (
      <div className="roomHeadNote">
        {conflict && <span>{t("roomProjectConflict")}</span>}
        <button type="button" className="roomHeadAction" onClick={conflict ? actions.onReplaceProject : actions.onRetryTransfer}>
          <Icon aria-hidden />{t(conflict ? "roomReplaceProject" : "retryTransfer")}
        </button>
      </div>
    );
  }
  if (room.transferProgress === undefined || room.transferProgress >= 100 || minutes === undefined) return null;
  return (
    <div className="roomHeadNote">
      {minutes <= 1 ? t("transferRemainingSoon") : t("transferRemaining", { minutes })}
    </div>
  );
};

/** The room: its picture, its code, what it is busy with, and its actions. */
export const RoomHeadCard = ({ room, artwork, actions }: {
  room: RoomStateDto;
  artwork?: { title: string; url: string };
  actions: RoomHeadActions;
}) => {
  const t = useText();
  const progress = room.transferError ? undefined : room.transferProgress;
  const transferring = progress !== undefined && progress < 100;
  const song = room.sharedSongs?.find(item => item.songId === room.songId)?.title;
  const menu: ActionMenuItem[] = [
    ...(actions.detached ? [] : [{ id: "collapse", label: t("collapseRoom"), icon: <PanelLeftClose size={16} />, run: actions.onCollapse }]),
    { id: "sync", label: t("roomCheckSync"), icon: <Activity size={16} />, disabled: actions.checkingSync, run: actions.onCheckSync },
    ...(room.transferId && !room.transferError
      ? [{ id: "cancel", label: t("cancelTransfer"), icon: <X size={16} />, run: actions.onCancelTransfer }]
      : []),
    actions.detached
      ? { id: "attach", label: t("panelAttach"), icon: <PanelTopClose size={16} />, run: actions.onAttach }
      : { id: "detach", label: t("roomDetach"), icon: <PanelTopOpen size={16} />, run: actions.onDetach },
  ];

  return (
    <section className={`roomCard roomHead${artwork ? "" : " roomHead--withoutArt"}`} aria-label={t("onlineRoom")}>
      <RoomHeaderSurface />
      {artwork && <img className="roomArt" src={artwork.url} alt={artwork.title} />}
      <div className="roomHeadBody">
        <span className="roomEyebrow">{t("roomEyebrow")}</span>
        <div className="roomCodeRow">
          <strong className="roomCode" title={room.code}>{shownCode(room.code)}</strong>
          <button type="button" className="roomSquareButton" aria-label={t(actions.copied ? "copied" : "copyCode")} onClick={actions.onCopy}>
            {actions.copied ? <Check aria-hidden /> : <Copy aria-hidden />}
          </button>
        </div>
        <ActionMenu
          trigger={props => (
            <button {...props} ref={props.ref as React.RefObject<HTMLButtonElement>} type="button" className="roomMenuButton" aria-label={t("roomActions")}>
              <i /><i /><i />
            </button>
          )}
          items={menu}
        />
        <button type="button" className="roomLeaveIconButton" aria-label={t("leaveRoom")} title={t("leaveRoom")} onClick={actions.onLeave}>
          <LogOut aria-hidden />
        </button>
        <span className="roomHeadLine">
          {transferring || room.transferError ? t("transferLabel") : song ?? t("roomNoSong")}
        </span>
        {transferring && (
          <div className="roomProgressRow">
            <div className="roomProgress" role="progressbar" aria-label={t("projectTransfer", { progress })}
              aria-valuemin={0} aria-valuemax={100} aria-valuenow={progress}>
              <span style={{ inlineSize: `calc(${progress}% + 3 * var(--u))` }} />
            </div>
            <span className="roomProgressValue">{progress}%</span>
          </div>
        )}
        <TransferNote room={room} actions={actions} />
      </div>
    </section>
  );
};
