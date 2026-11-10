import { tr } from '@neo-ui-kit/react';
import type { DialogRequest } from '../../providers/dialog';
import { formatBytes } from '../../shared/utils/format';
import { minimumRecordingBytes } from '../../application/karaoke/KaraokeRecordingCoordinator';

type Ask = (request: DialogRequest) => Promise<string | null>;
/** One shared "not enough disk" prompt; resolves to the chosen action id. */
export const askInsufficientDisk = (
  ask: Ask,
  availableBytes: number,
): Promise<string | null> =>
  ask({
    title: tr('insufficientDiskTitle'),
    body: tr('insufficientDisk', {
      required: formatBytes(minimumRecordingBytes),
      available: formatBytes(availableBytes),
    }),
    actions: [
      { id: 'close', label: tr('close') },
      {
        id: 'storage',
        label: tr('openStorageSettings'),
        appearance: 'primary',
      },
    ],
  });
