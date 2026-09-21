import { UsersRound } from "lucide-react";
import { useState } from "react";
import { useApp } from "../../app/AppContext";
import type { MessageKey } from "../../i18n/messages";
import { useText } from "../../i18n/useText";
import { pythonClient } from "../../services/pythonClient";
import { errorMessageKey, toAppError } from "../../shared/errors";
import { FormStatus } from "../../shared/ui/FormStatus";
import { Modal } from "../../shared/ui/Modal";
import { Button, RenderFormikFields, Tabs, useGetForm, type FormRow } from "../../theme/ui";

type RoomMode = "create" | "join";

const roomTabs = [
  { value: "create", label: "create" },
  { value: "join", label: "join" }
] as const satisfies readonly { value: RoomMode; label: MessageKey }[];

interface RoomValues {
  name: string;
  code: string;
}

export const RoomModal = ({ open, onClose }: { open: boolean; onClose(): void }) => {
  const { setRoom, preferences, updatePreferences } = useApp();
  const t = useText();
  const [mode, setMode] = useState<RoomMode>("create");

  const formik = useGetForm<RoomValues>({
    initialValues: { name: preferences.displayName, code: "" },
    enableReinitialize: false,
    validate: values => ({
      ...(values.name.trim() ? {} : { name: t("fieldRequired") }),
      ...(mode === "join" && !values.code.trim() ? { code: t("fieldRequired") } : {})
    }),
    onSubmit: async (values, helpers) => {
      helpers.setStatus(undefined);
      try {
        const name = values.name.trim();
        const room = mode === "create" ? await pythonClient.createRoom(name) : await pythonClient.joinRoom(values.code.trim(), name);
        updatePreferences({ displayName: name });
        setRoom(room);
        onClose();
      } catch (failure) {
        helpers.setStatus(t(errorMessageKey(toAppError(failure)) ?? "roomNetworkUnavailable"));
      }
    }
  });

  const rows: FormRow[] = [
    { tag: "name", label: t("displayName"), required: true, autoComplete: "name" },
    {
      tag: "code",
      label: t("roomCode"),
      required: true,
      autoComplete: "off",
      parse: raw => String(raw).toUpperCase(),
      showFor: () => mode === "join"
    }
  ];

  return (
    <Modal open={open} title={t("onlineRoom")} closeLabel={t("closeDialog")} onClose={onClose}>
      <form className="modalStack" noValidate onSubmit={formik.handleSubmit}>
        <div className="modalHero">
          <UsersRound aria-hidden size={34} />
          <div>
            <strong>{t("roomTitle")}</strong>
            <span>{t("roomIntro")}</span>
          </div>
        </div>
        <Tabs<RoomMode> value={mode} onChange={setMode} items={roomTabs.map(tab => ({ value: tab.value, label: t(tab.label) }))} />
        <RenderFormikFields formik={formik} items={rows} />
        <FormStatus status={formik.status} />
        <div className="modalActions">
          <Button type="button" variant="outlined" tone="neutral" disabled={formik.isSubmitting} onClick={onClose}>
            {t("cancel")}
          </Button>
          <Button type="submit" disabled={formik.isSubmitting}>
            {t(mode === "create" ? "createRoom" : "joinRoom")}
          </Button>
        </div>
      </form>
    </Modal>
  );
};
