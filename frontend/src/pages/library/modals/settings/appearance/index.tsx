import { tr } from '@neo-ui-kit/react';
import { observer } from 'mobx-react-lite';
import { store } from '../../../../../providers/store';
import { useNotify } from '../../../../../providers/notifications';
import { usePersonPhoto } from '../../../../../features/social/usePersonPhoto';
import { avatarFromFile } from '../../../../../features/social/avatarImage';
import { socialClient } from '../../../../../services/socialClient';
import { useState } from 'react';
import { useKeyboardLighting } from './keyboardlighting/useKeyboardLighting';
import { AppearanceFields } from './rows';

const AppearancePanel = observer(() => {
  const inbox = store.inbox;
  const me = inbox.type === 'inbox' ? inbox.me : undefined;
  const photo = usePersonPhoto(me?.accountId, me?.avatarVersion ?? 0);
  const [changingPhoto, setChangingPhoto] = useState(false);
  const [photoResetKey, setPhotoResetKey] = useState(0);
  const notify = useNotify();
  const lighting = useKeyboardLighting();
  const changePhoto = async (file: File) => {
    if (!me || changingPhoto) return;
    setChangingPhoto(true);
    try {
      const photo = await avatarFromFile(file);
      await socialClient.setAvatar(photo.mime, photo.data);
      store.updatePreferences({
        profilePhoto: `data:${photo.mime};base64,${photo.data}`,
      });
    } catch (error) {
      // Drop the picker's unsaved preview without resetting the other fields.
      setPhotoResetKey((key) => key + 1);
      notify(
        error instanceof Error ? error.message : tr('social.photoUnreadable'),
        'error',
      );
    } finally {
      setChangingPhoto(false);
    }
  };
  return (
    <AppearanceFields
      photo={photo ?? store.profile.photo}
      photoResetKey={photoResetKey}
      canChangePhoto={!!me && !changingPhoto}
      changePhoto={changePhoto}
      lighting={lighting}
    />
  );
});

export default AppearancePanel;
