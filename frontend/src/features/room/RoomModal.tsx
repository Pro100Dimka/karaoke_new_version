import { useEffect, useId, useRef, useState } from "react";
import { useApp } from "../../app/AppContext";
import { useText } from "../../i18n/useText";
import { errorMessageKey, toAppError } from "../../shared/errors";
import { FormStatus } from "../../shared/ui/FormStatus";
import { Modal, useGetForm } from "../../theme/ui";
import { NeonFrame } from "../../shared/ui/NeonFrame";
import { enterRoom } from "./enterRoom";

type RoomMode = "create" | "join";

interface RoomValues {
  name: string;
  code: string;
}

const DoorIcon = () => (
  <svg viewBox="0 0 28 28" aria-hidden="true"><path d="M5 4h13v20H5M2 14h14m-5-5 5 5-5 5" /></svg>
);

const PeopleIcon = ({ large = false }: { large?: boolean }) => (
  <svg viewBox={large ? "0 0 64 64" : "0 0 28 28"} aria-hidden="true">
    {large ? <><circle cx="24" cy="25" r="9" /><circle cx="43" cy="28" r="7" /><path d="M8 52c1-12 8-18 16-18s15 6 16 18M35 51c1-9 5-14 11-14 7 0 11 5 12 14" /></>
      : <><circle cx="11" cy="9" r="5" /><path d="M2 25c1-8 5-11 9-11s8 3 9 11M22 6v8m-4-4h8" /></>}
  </svg>
);

const PersonIcon = () => (
  <svg viewBox="0 0 28 28" aria-hidden="true"><circle cx="14" cy="9" r="5" /><path d="M5 26c1-8 5-11 9-11s8 3 9 11" /></svg>
);

const CodeIcon = () => (
  <svg viewBox="0 0 28 28" aria-hidden="true"><path d="M9 2 6 26M22 2l-3 24M3 10h23M2 18h23" /></svg>
);

const RoomHeaderWaves = () => {
  const ref = useRef<SVGSVGElement | null>(null);
  useEffect(() => {
    const root = ref.current;
    if (!root) return;
    const paths = [...root.querySelectorAll<SVGPathElement>("path")];
    const reducedMotion = window.matchMedia?.("(prefers-reduced-motion: reduce)");
    let frame = 0;
    let time = 0;
    const draw = () => {
      time += .018;
      paths.forEach((path, row) => {
        let data = "";
        for (let column = 0; column <= 50; column += 1) {
          const x = column * 11;
          const y = 85 + row * 3 + Math.sin(column * .22 + time + row * .08) * 20 + Math.sin(column * .09 - time * .7) * 12;
          data += `${column ? "L" : "M"}${x} ${y}`;
        }
        path.setAttribute("d", data);
      });
      if (!reducedMotion?.matches && !document.hidden) frame = requestAnimationFrame(draw);
    };
    draw();
    return () => cancelAnimationFrame(frame);
  }, []);
  return (
    <svg ref={ref} className="roomModalWaves" viewBox="0 0 520 220" aria-hidden="true">
      {Array.from({ length: 24 }, (_, row) => <path key={row} fill="none" stroke="var(--ui-primary)" strokeWidth={row % 7 === 0 ? 1.1 : .65} opacity=".35" />)}
    </svg>
  );
};

export const RoomModal = ({ open, onClose }: { open: boolean; onClose(): void }) => {
  const { setRoom, preferences, updatePreferences } = useApp();
  const t = useText();
  const formId = useId();
  const nameId = useId();
  const codeId = useId();
  const [mode, setMode] = useState<RoomMode>("join");

  const formik = useGetForm<RoomValues>({
    initialValues: { name: preferences.displayName, code: "" },
    enableReinitialize: false,
    validate: values => ({
      ...(values.name.trim() ? {} : { name: t("fieldRequired") }),
      ...(mode === "join" && !values.code.trim() ? { code: t("fieldRequired") } : {}),
    }),
    onSubmit: async (values, helpers) => {
      helpers.setStatus(undefined);
      try {
        const name = values.name.trim();
        const room = await enterRoom(name, mode === "create" ? undefined : values.code.trim());
        updatePreferences({ displayName: name });
        setRoom(room);
        onClose();
      } catch (failure) {
        helpers.setStatus(t(errorMessageKey(toAppError(failure)) ?? "roomNetworkUnavailable"));
      }
    },
  });

  const selectMode = (next: RoomMode) => {
    setMode(next);
    formik.setStatus(undefined);
    formik.setErrors({});
  };

  return (
    <Modal
      isOpen={open}
      portal
      onClose={onClose}
      ariaLabel={t("onlineRoom")}
      closeAriaLabel={t("closeDialog")}
      closeIconSize={82}
      modalClassName="roomEntryModal"
      closeClassName="roomEntryModalClose"
      maxWidth="none"
      neonFrame={<NeonFrame className="roomEntryShellFrame" variant="shell" order={0} />}
    >
      <form id={formId} className="roomModalLayout" noValidate onSubmit={formik.handleSubmit}>
        <header className="roomModalHead">
          <RoomHeaderWaves />
          <span className="roomModalHero"><PeopleIcon large /></span>
          <span className="roomModalEyebrow">{t("onlineRoom")}</span>
          <h2>{t("roomTitle")}</h2>
          <p>{t("roomIntro")}</p>
        </header>

        <nav className="roomModalTabs" role="tablist" aria-label={t("onlineRoom")}>
          <NeonFrame order={1} />
          <button type="button" role="tab" aria-selected={mode === "join"} className={mode === "join" ? "active" : undefined} onClick={() => selectMode("join")}>
            <DoorIcon /><span>{t("joinByCode")}</span>
          </button>
          <button type="button" role="tab" aria-selected={mode === "create"} className={mode === "create" ? "active" : undefined} onClick={() => selectMode("create")}>
            <PeopleIcon /><span>{t("createRoom")}</span>
          </button>
        </nav>

        <section className="roomModalFields">
          <NeonFrame order={2} />
          <div className="roomModalField">
            <span className="roomModalFieldIcon"><PersonIcon /></span>
            <div className="roomModalFieldControl">
              <label htmlFor={nameId}>{t("displayName")} *</label>
              <span className="roomModalInputWrap">
                <input id={nameId} name="name" autoComplete="name" value={formik.values.name} className={formik.values.name ? "filled" : undefined} onChange={formik.handleChange} onBlur={formik.handleBlur} aria-invalid={Boolean(formik.touched.name && formik.errors.name)} />
                {formik.values.name && <button type="button" className="roomModalClear" aria-label={t("clearField")} onClick={() => { void formik.setFieldValue("name", ""); document.getElementById(nameId)?.focus(); }}><svg viewBox="0 0 20 20" aria-hidden><path d="M5 5l10 10M15 5 5 15" /></svg></button>}
              </span>
            </div>
          </div>
          {mode === "join" && (
            <div className="roomModalField">
              <span className="roomModalFieldIcon"><CodeIcon /></span>
              <div className="roomModalFieldControl">
                <label htmlFor={codeId}>{t("roomCode")} *</label>
                <span className="roomModalInputWrap">
                  <input id={codeId} name="code" autoComplete="off" value={formik.values.code} placeholder={t("roomCodePlaceholder")} className={formik.values.code ? "filled" : undefined} onChange={formik.handleChange} onBlur={formik.handleBlur} aria-invalid={Boolean(formik.touched.code && formik.errors.code)} />
                </span>
              </div>
            </div>
          )}
          <FormStatus status={formik.status} />
        </section>

        <div className="roomModalActions">
          <button type="button" className="roomModalButton" disabled={formik.isSubmitting} onClick={onClose}>{t("cancel")}</button>
          <button type="submit" className="roomModalButton roomModalSubmit" disabled={formik.isSubmitting}>
            {mode === "join" ? <DoorIcon /> : <PeopleIcon />}<span>{t(mode === "join" ? "joinRoom" : "createRoom")}</span>
          </button>
        </div>

        <button type="button" className="roomModalBottom" aria-label={`${t("noRoomCode")} ${t("createAndInvite")}`} onClick={() => selectMode("create")}>
          <PeopleIcon large /><strong>{t("noRoomCode")}</strong><span>{t("createAndInvite")}</span><b aria-hidden>›</b>
        </button>
      </form>
    </Modal>
  );
};
