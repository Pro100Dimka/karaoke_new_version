import { tr } from '@neo-ui-kit/react';
import { ask } from '../../../providers/dialog';
import { editorApi } from '../../editor/editorApi';

/** Bind confirmation to the revision the user was told will remain in history. */
export const confirmLyricsReset = async (songId: string): Promise<boolean> => {
  const document = await editorApi.load(songId);
  const choice = await ask({
    title: tr('resetLyricsTitle'),
    body: tr('resetLyricsBody', { revision: document.revision }),
    actions: [
      { id: 'cancel', label: tr('cancel') },
      {
        id: 'reset',
        label: tr('resetLyricsAndReprocess'),
        appearance: 'primary',
      },
    ],
  });
  if (choice !== 'reset') return false;
  await editorApi.reset(songId, document.revision);
  return true;
};
