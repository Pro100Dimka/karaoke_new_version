import { useEffect } from "react";
import { runInAction } from "mobx";
import { observer } from "mobx-react-lite";
import { Button, Dialog, Stack } from "@neo-ui-kit/react";
import { store } from "./store";

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

export const settleDialog = (id: string | null) => {
  const pending = store.dialog;
  runInAction(() => { store.dialog = null; });
  pending?.resolve(id);
};

export const ask = (request: DialogRequest): Promise<string | null> =>
  new Promise(resolve => {
    settleDialog(null);
    runInAction(() => { store.dialog = { request, resolve }; });
  });

export const DialogView = observer(() => {
  useEffect(() => () => settleDialog(null), []);
  const request = store.dialog?.request;
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
});
