import { observeAudioTelemetry } from './audioSession';
import { diagnosticNumber, parseKeyValues } from './audioProtocol';

export const observeMicrophoneLevel = (
  onValue: (level: number) => void, onError: (error: unknown) => void,
  intervalMs = 50,
): (() => void) => observeAudioTelemetry('GetInputLevel', intervalMs,
  text => onValue(diagnosticNumber(parseKeyValues(text).rms)), onError);
