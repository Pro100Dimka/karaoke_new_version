import { createPublicKey, verify } from 'node:crypto';
import { mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import * as path from 'node:path';

const publicKey = createPublicKey(`-----BEGIN PUBLIC KEY-----
MCowBQYDK2VwAyEA2fzRenv1D4sYvQFP/HuECWECa69fVVToQlh1Xkgetc4=
-----END PUBLIC KEY-----`);
const registryUrl = 'https://130.61.169.61/source-registry.json';
const refreshMs = 6 * 60 * 60 * 1000;
const maximumBytes = 8 * 1024 * 1024;

export const startSourceRegistry = (dataRoot: string): void => {
  const directory = path.join(dataRoot, 'cache');
  const file = path.join(directory, 'source-registry.json');
  let busy = false;
  const refresh = async (): Promise<void> => {
    if (busy) return;
    busy = true;
    const temporary = `${file}.${process.pid}.tmp`;
    try {
      const response = await fetch(registryUrl, {
        signal: AbortSignal.timeout(15_000),
        redirect: 'error',
        credentials: 'omit',
      });
      if (!response.ok || !response.body) return;
      const chunks: Uint8Array[] = [];
      let length = 0;
      for await (const chunk of response.body) {
        length += chunk.length;
        if (length > maximumBytes)
          throw new Error('Source registry is too large');
        chunks.push(chunk);
      }
      const envelope = JSON.parse(Buffer.concat(chunks).toString('utf8'));
      if (
        typeof envelope.payload !== 'string' ||
        typeof envelope.signature !== 'string'
      )
        return;
      const payload = Buffer.from(envelope.payload, 'base64');
      if (
        !verify(
          null,
          payload,
          publicKey,
          Buffer.from(envelope.signature, 'base64'),
        )
      )
        return;
      const registry = JSON.parse(payload.toString('utf8'));
      if (
        registry.version !== 1 ||
        !Number.isSafeInteger(registry.generatedAt) ||
        registry.generatedAt > Date.now() / 1000 + 300 ||
        registry.generatedAt < Date.now() / 1000 - 7 * 86400 ||
        !Array.isArray(registry.channels)
      )
        return;
      try {
        const previous = JSON.parse(await readFile(file, 'utf8'));
        if (previous.generatedAt > registry.generatedAt) return;
      } catch {
        // A missing or damaged cache is replaced only after signature verification.
      }
      await mkdir(directory, { recursive: true });
      await writeFile(temporary, JSON.stringify(registry), { mode: 0o600 });
      await rename(temporary, file);
    } catch {
      // Registry availability never controls media playback or replaces the last good copy.
    } finally {
      await rm(temporary, { force: true }).catch(() => {});
      busy = false;
    }
  };
  void refresh();
  setInterval(() => void refresh(), refreshMs).unref();
};
