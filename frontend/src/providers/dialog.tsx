import { useEffect, useRef, useState } from "react";
import { Button, Dialog, Stack } from "@neo-ui-kit/react";
import { createCommandQueue } from "../app/desktop/shellBus";

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

export interface PendingDialog {
  request: DialogRequest;
  resolve(id: string | null): void;
}

const requests = createCommandQueue<PendingDialog>();
export const ask = (request: DialogRequest): Promise<string | null> =>
  new Promise(resolve => requests.push({ request, resolve }));

export const DialogView = () => {
  const [request, setRequest] = useState<DialogRequest | null>(null);
  const pending = useRef<PendingDialog | null>(null);
  const settleDialog = (id: string | null) => {
    const current = pending.current;
    pending.current = null;
    setRequest(null);
    current?.resolve(id);
  };
  useEffect(() => {
    const unsubscribe = requests.subscribe(next => {
      pending.current?.resolve(null);
      pending.current = next;
      setRequest(next.request);
    });
    return () => {
      unsubscribe();
      pending.current?.resolve(null);
      pending.current = null;
    };
  }, []);
  return (
    <Dialog
      open={!!request}
      onOpenChange={open => { if (!open) settleDialog(null); }}
      className="confirmDialog"
      width="narrow"
      icon={request?.tone === "info" ? "info" : "warning"}
      title={request?.title}
      description={request?.body}
      cancelLabel={false}
      confirmLabel={false}
    >
      <Stack direction="row" gap={2} justify="end" wrap>
        {request?.actions.map(action => (
          <Button key={action.id}
            variant={action.appearance === "primary" ? "primary" : "secondary"}
            onClick={() => settleDialog(action.id)}>
            {action.label}
          </Button>
        ))}
      </Stack>
    </Dialog>
  );
};
