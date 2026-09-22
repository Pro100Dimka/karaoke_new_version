import { ArrowLeft, UsersRound } from "lucide-react";
import { useId, useState } from "react";
import { useApp } from "../../app/AppContext";
import { useText } from "../../i18n/useText";
import { audioClient } from "../../services/audioClient";
import { roomClient } from "../../services/roomClient";
import { participantId } from "../../services/roomMappers";
import { errorMessageKey, toAppError } from "../../shared/errors";
import { FormStatus } from "../../shared/ui/FormStatus";
import { Button, Modal, RenderFormikFields, Stack, useGetForm, type FormRow } from "../../theme/ui";

type RoomMode = "create" | "join";

interface RoomValues {
  name: string;
  code: string;
}

export const RoomModal = ({ open, onClose }: { open: boolean; onClose(): void }) => {
  const { setRoom, preferences, updatePreferences } = useApp();
  const t = useText();
  const formId = useId();
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
        const room = mode === "create" ? await roomClient.createRoom(name) : await roomClient.joinRoom(values.code.trim(), name);
        updatePreferences({ displayName: name });
        try {
          await audioClient.joinVoiceSession(room.code, participantId);
        } catch (error) {
          await roomClient.leaveRoom(room.code).catch(() => undefined);
          throw error;
        }
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
    <Modal
      isOpen={open}
      portal
      size="sm"
      onClose={onClose}
      ariaLabel={t("onlineRoom")}
      closeAriaLabel={t("closeDialog")}
      titleProps={{
        icon: UsersRound,
        eyebrow: t("onlineRoom"),
        title: t("roomTitle"),
        description: t("roomIntro"),
        actions: (
          <>
            <Button
              fullWidth
              variant="outlined"
              disabled={formik.isSubmitting}
              startIcon={mode === "join" ? <ArrowLeft /> : undefined}
              onClick={() => setMode(current => current === "create" ? "join" : "create")}
            >
              {t(mode === "join" ? "back" : "joinRoom")}
            </Button>
            <Button fullWidth type="submit" form={formId} disabled={formik.isSubmitting}>
              {t(mode === "create" ? "createRoom" : "joinRoom")}
            </Button>
          </>
        )
      }}
    >
      <form id={formId} className="roomModalForm" noValidate onSubmit={formik.handleSubmit}>
        <Stack gap="var(--space-4)">
          <RenderFormikFields formik={formik} items={rows} />
          <FormStatus status={formik.status} />
        </Stack>
      </form>
    </Modal>
  );
};
