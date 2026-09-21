import { AlertTriangle, Info } from "lucide-react";
import { createContext, useCallback, useContext, useMemo, useRef, useState, type ReactNode } from "react";
import { Button, Modal, Stack, Typography } from "../theme/ui";

export interface DialogAction {
  id: string;
  label: string;
  appearance?: "primary" | "secondary" | "outline";
}

export interface DialogRequest {
  title: string;
  body: string;
  tone?: "info" | "warning";
  actions: readonly DialogAction[];
}

type Ask = (request: DialogRequest) => Promise<string | null>;

const DialogContextValue = createContext<Ask | null>(null);

interface PendingDialog {
  request: DialogRequest;
  resolve(id: string | null): void;
}

export const DialogProvider = ({ children }: { children: ReactNode }) => {
  const [pending, setPending] = useState<PendingDialog | null>(null);
  const pendingRef = useRef<PendingDialog | null>(null);

  const ask = useCallback<Ask>(
    request =>
      new Promise(resolve => {
        // A newer request supersedes an unanswered one so callers never hang.
        pendingRef.current?.resolve(null);
        const next = { request, resolve };
        pendingRef.current = next;
        setPending(next);
      }),
    []
  );

  const settle = (id: string | null) => {
    pending?.resolve(id);
    pendingRef.current = null;
    setPending(null);
  };

  const value = useMemo(() => ask, [ask]);

  return (
    <DialogContextValue.Provider value={value}>
      {children}
      <Modal
        isOpen={pending !== null}
        onClose={() => settle(null)}
        ariaLabel={pending?.request.title}
        portal
        size="sm"
        closeIconSize={40}
        titleProps={{ title: pending?.request.title ?? "", icon: pending?.request.tone === "info" ? Info : AlertTriangle }}
        backdropClassName="confirmBackdrop"
      >
        <Stack gap="1rem">
          <Typography variant="body1">{pending?.request.body}</Typography>
          <Stack direction="row" justify="flex-end" gap="0.5rem" wrap>
            {pending?.request.actions.map(action => (
              <Button
                key={action.id}
                variant={action.appearance === "primary" ? "contained" : "outlined"}
                tone={action.appearance === "primary" ? "primary" : "neutral"}
                onClick={() => settle(action.id)}
              >
                {action.label}
              </Button>
            ))}
          </Stack>
        </Stack>
      </Modal>
    </DialogContextValue.Provider>
  );
};

export const useAsk = (): Ask => {
  const value = useContext(DialogContextValue);
  if (!value) throw new Error("useAsk must be used inside DialogProvider");
  return value;
};
