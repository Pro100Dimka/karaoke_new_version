import { command } from "./audioSession";
import { diagnosticNumber, parseKeyValues } from "./audioProtocol";

/**
 * The microphone's current RMS level (0..1) as AudioService measures it. Unlike the input test it
 * neither checks nor starts a session, so visuals can poll it; with no capture running it reads 0.
 */
export const microphoneLevel = async (): Promise<number> =>
  diagnosticNumber(parseKeyValues(await command("GetInputLevel")).rms);
