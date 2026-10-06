import {
  createContext,
  useCallback,
  useContext,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from "react";
import { Button, Dialog, Stack } from "@ad-voice/ui";

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

/** One question at a time over the whole app; the answer is the chosen action's id, or null when dismissed. */
export const DialogProvider = ({ children }: { children: ReactNode }) => {
  const [pending, setPending] = useState<PendingDialog | null>(null);
  const pendingRef = useRef<PendingDialog | null>(null);

  const ask = useCallback<Ask>(
    (request) =>
      new Promise((resolve) => {
        // A newer request supersedes an unanswered one so callers never hang.
        pendingRef.current?.resolve(null);
        const next = { request, resolve };
        pendingRef.current = next;
        setPending(next);
      }),
    [],
  );

  const settle = (id: string | null) => {
    pending?.resolve(id);
    pendingRef.current = null;
    setPending(null);
  };

  const value = useMemo(() => ask, [ask]);
  const request = pending?.request;

  return (
    <DialogContextValue.Provider value={value}>
      {children}
      <Dialog
        open={pending !== null}
        onOpenChange={(open) => {
          if (!open) settle(null);
        }}
        className="confirmDialog"
        width="narrow"
        icon={request?.tone === "info" ? "info" : "warning"}
        title={request?.title}
        description={request?.body}
        cancelLabel={false}
        confirmLabel={false}
      >
        <Stack direction="row" gap={2} justify="end" wrap>
          {request?.actions.map((action) => (
            <Button
              key={action.id}
              variant={
                action.appearance === "primary" ? "primary" : "secondary"
              }
              onClick={() => settle(action.id)}
            >
              {action.label}
            </Button>
          ))}
        </Stack>
      </Dialog>
    </DialogContextValue.Provider>
  );
};

export const useAsk = (): Ask => {
  const value = useContext(DialogContextValue);
  if (!value) throw new Error("useAsk must be used inside DialogProvider");
  return value;
};
