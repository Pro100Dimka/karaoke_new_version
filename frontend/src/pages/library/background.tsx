import {
  QuantumBackground,
  NeonWaves,
  Stack,
  useMotion,
} from '@neo-ui-kit/react';
import { useEffect, useRef, useState } from 'react';
import { observeMicrophoneLevel } from '../../services/inputLevel';
import {
  backdropSpectrum,
  backdropSpectrumRange,
  voiceLevel,
} from '../../app/backdrop/backdropSpectrum';
import { subscribeSpectrum } from '../../app/backdrop/spectrumEvents';

// The build ships three.js beside the app (scripts/vite-three-vendor.mjs): the scene works offline and
// loads no code from a CDN. Relative, so the scene's import map and CSP hash are the same everywhere.
const voicePollMilliseconds = 50;
const quietVoicePollMilliseconds = 200;

/**
 * The radio and everything else AudioService plays (from the shared spectrum feed) plus the singer's
 * microphone, as one spectrum. The microphone has its own subscription: when the speakers are
 * silent the spectrum feed slows down, but a voice must still move the field at once.
 */
const useBackdropSpectrum = (listening: boolean): number[] | undefined => {
  const [bands, setBands] = useState<number[]>();
  const output = useRef<readonly number[]>([]);
  const voice = useRef(0);
  const [quietVoice, setQuietVoice] = useState(true);

  useEffect(() => {
    if (!listening) {
      setBands(undefined);
      return;
    }
    const publish = () =>
      setBands(backdropSpectrum(output.current, voice.current));
    const stopVoice = observeMicrophoneLevel(level => {
      const next = voiceLevel(level);
      setQuietVoice(next === 0);
      if (next > 0 || voice.current > 0) {
        voice.current = next;
        publish();
      }
    }, () => {
      // Without AudioService there is no voice; the service banner reports the outage.
      voice.current = 0;
    }, quietVoice ? quietVoicePollMilliseconds : voicePollMilliseconds);
    const unsubscribe = subscribeSpectrum((frame) => {
      output.current = frame.bands;
      publish();
    });
    return () => {
      stopVoice();
      unsubscribe();
    };
  }, [listening, quietVoice]);
  return bands;
};

const SpectrumBackground = ({ listening }: { listening: boolean }) => {
  const spectrum = useBackdropSpectrum(listening);
  const initial = {
    field: 'Higgs (Mass)',
    fieldSize: 1.05,
    particleDepth: 1,
    particleScale: 2,
    paused: !listening,
    particleSharpness: 1,
    timeScale: 0.38,
    density: 0.14,
    particleCount: 5280,
    adaptiveQualityEnabled: true,
    targetFPS: 45,
    interactive: false,
    nebulaEnabled: false,
    connectionsEnabled: false,
    crawlersEnabled: false,
    particleTrailsEnabled: false,
    lensFlareEnabled: false,
    dofEnabled: false,
    cameraShake: 0,
    audioCameraEnabled: false,
    bloom: 0,
    trails: 0,
    chromaticAberration: 0,
    anamorphicStretch: 0,
    godRaysEnabled: false,
    filmGrain: 0,
  } as const;
  const threeUrl = './vendor/three/';

  return (
    <QuantumBackground
      {...initial}
      spectrum={spectrum}
      spectrumRange={backdropSpectrumRange}
      threeUrl={threeUrl}
      style={{
        height: '100%',
        display: !listening ? 'none' : undefined,
        borderRadius: 0,
        mixBlendMode: 'screen',
        maskImage: 'linear-gradient(180deg, #0004, #0009 30%, #000 55%)',
      }}
    />
  );
};

/** Spectrum updates belong to the scene; decorative waves do not consume audio bands. */
export const LibraryBackdrop = ({ paused = false }: { paused?: boolean }) => {
  const motion = useMotion();
  return (
    <Stack
      inert
      data-ad-offscreen={paused ? '' : undefined}
      style={{
        // No z-index here: particles blend with the theme's background.
        position: 'absolute',
        inset: 0,
        overflow: 'hidden',
        background: 'rgba(0 0 0 / 0.3)',
        pointerEvents: 'none',
      }}
    >
      {motion && <SpectrumBackground listening={!paused} />}
      <NeonWaves
        shape="twist"
        strands={18}
        comets={2}
        stars={false}
        phase={2.6}
        style={{
          position: 'absolute',
          bottom: '10%',
          left: '-10%',
          width: '120%',
          height: '34%',
          opacity: 0.9,
          transform: 'rotate(-4deg)',
        }}
      />
    </Stack>
  );
};
