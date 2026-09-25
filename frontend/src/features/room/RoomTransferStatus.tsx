import { RefreshCw, X } from "lucide-react";
import type { RoomStateDto } from "../../contracts/models";
import { useText } from "../../i18n/useText";
import { Button, Progress, Typography } from "../../theme/ui";

const formatBytes = (bytes: number): string => {
  const units = ["B", "KB", "MB", "GB"] as const;
  let value = Math.max(0, bytes);
  let unit = 0;
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024;
    unit += 1;
  }
  return `${value < 10 && unit > 0 ? value.toFixed(1) : Math.round(value)} ${units[unit]}`;
};

export const RoomTransferStatus = ({
  room,
  onCancel,
  onRetry,
}: {
  room: RoomStateDto;
  onCancel(): void;
  onRetry(): void;
}) => {
  const t = useText();
  if (room.transferProgress === undefined && !room.transferError) return null;
  const actions = {
    retry: { icon: RefreshCw, label: "retryTransfer", run: onRetry },
    cancel: { icon: X, label: "cancelTransfer", run: onCancel },
  } as const;
  const key = room.transferError
    ? "retry"
    : room.transferId
      ? "cancel"
      : undefined;
  const action = key && actions[key];
  return (
    <div className="transfer">
      {room.transferProgress !== undefined && room.transferProgress !== 100 && (
        <>
          <Typography as="span" variant="caption" tone="muted">
            {t("projectTransfer", { progress: room.transferProgress })}
          </Typography>
          <Progress
            aria-label={t("projectTransfer", {
              progress: room.transferProgress,
            })}
            value={room.transferProgress}
          />
        </>
      )}
      {room.transferTotalBytes !== undefined && (
        <Typography as="span" variant="caption" tone="muted">
          {formatBytes(room.transferBytes ?? 0)} /{" "}
          {formatBytes(room.transferTotalBytes)}
        </Typography>
      )}
      {action && (
        <Button
          size="sm"
          variant="outlined"
          startIcon={<action.icon size={14} />}
          onClick={action.run}
        >
          {t(action.label)}
        </Button>
      )}
    </div>
  );
};
