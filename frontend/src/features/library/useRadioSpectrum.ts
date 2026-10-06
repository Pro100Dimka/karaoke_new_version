import { useEffect, useState } from "react";
import { useRadio } from "../../app/RadioContext";
import { subscribeSpectrum } from "../../app/backdrop/spectrumEvents";

const spectrumGain = 1.6;

/** The radio's output spectrum while it plays, for song covers to dance to; nothing while it is off. */
export const useRadioSpectrum = () => {
  const radio = useRadio();
  const [bands, setBands] = useState<readonly number[]>();
  useEffect(() => {
    if (!radio.enabled) return setBands(undefined);
    return subscribeSpectrum((frame) =>
      setBands(frame.bands.map((band) => band * spectrumGain)),
    );
  }, [radio.enabled]);
  return bands;
};
