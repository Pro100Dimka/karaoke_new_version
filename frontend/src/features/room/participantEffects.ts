import type { MessageKey } from "../../i18n/messages";

export type ParticipantEffect =
  "reverb" | "echo" | "delay" | "noiseSuppression" | "octave" | "autoTune";

/** What the host can shape of another participant's voice, as heard in this room. */
export const participantEffectKnobs = [
  {
    id: "reverb",
    label: "effectReverb",
    min: 0,
    max: 1,
    step: 0.01,
    displayFactor: 100,
    valueSuffix: "%",
  },
  {
    id: "echo",
    label: "effectEcho",
    min: 0,
    max: 1,
    step: 0.01,
    displayFactor: 100,
    valueSuffix: "%",
  },
  {
    id: "noiseSuppression",
    label: "noiseSuppression",
    min: 0,
    max: 1,
    step: 1,
    displayFactor: 100,
    valueSuffix: "%",
  },
  {
    id: "autoTune",
    label: "effectAutoTune",
    min: 0,
    max: 1,
    step: 0.01,
    displayFactor: 100,
    valueSuffix: "%",
  },
  {
    id: "octave",
    label: "participantOctave",
    min: -1,
    max: 1,
    step: 1,
    displayFactor: 1,
    valueSuffix: "",
  },
] as const satisfies ReadonlyArray<{
  id: ParticipantEffect;
  label: MessageKey;
  min: number;
  max: number;
  step: number;
  displayFactor: number;
  valueSuffix?: string;
}>;
