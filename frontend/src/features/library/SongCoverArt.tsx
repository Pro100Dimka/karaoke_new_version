import { useEffect, useState } from "react";
import { Equalizer } from "@ad-voice/ui";
import { useRadio } from "../../app/RadioContext";
import { subscribeSpectrum } from "../../app/backdrop/spectrumEvents";

const spectrumGain = 1.6;

/** The radio's output spectrum while it plays, for covers to dance to; nothing while it is off. */
const useRadioSpectrum = () => {
  const radio = useRadio();
  const [bands, setBands] = useState<readonly number[]>();
  useEffect(() => {
    if (!radio.enabled) return setBands(undefined);
    return subscribeSpectrum(frame => setBands(frame.bands.map(band => band * spectrumGain)));
  }, [radio.enabled]);
  return bands;
};

/**
 * Cover of a song without artwork: an equalizer behind the card. It bounces on its own, out of step
 * with its neighbours; while the radio plays, it follows the output spectrum instead.
 */
export const SongCoverArt = ({ cardIndex }: { cardIndex: number }) => {
  const levels = useRadioSpectrum();
  return (
    <span className="songCoverArt" aria-hidden="true">
      <Equalizer className="songCoverEqualizer" bars={16} levels={levels} phase={cardIndex * 0.085} />
    </span>
  );
};
