import { command, observeAudioTelemetry } from './audioSession';
import { diagnosticNumber, parseKeyValues } from './audioProtocol';

/**
 * The microphone's current RMS level (0..1) as AudioService measures it. Unlike the input test it
 * neither checks nor starts a session, so visuals can poll it; with no capture running it reads 0.
 */
export const microphoneLevel = async (): Promise<number> =>
  diagnosticNumber(parseKeyValues(await command('GetInputLevel')).rms);

export const observeMicrophoneLevel = (
  onValue: (level: number) => void, onError: (error: unknown) => void,
  intervalMs = 50,
): (() => void) => observeAudioTelemetry('GetInputLevel', intervalMs,
  text => onValue(diagnosticNumber(parseKeyValues(text).rms)), onError);
