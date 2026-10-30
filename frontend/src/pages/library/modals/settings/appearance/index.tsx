import { Form, Grid, tr } from '@neo-ui-kit/react';
import { observer } from 'mobx-react-lite';
import { store } from '../../../../../providers/store';
import { parsePreferences, type Preferences } from '../../../../../shared/preferences/preferences';
import { toggleRadio, setRadioStation, setRadioVolume } from '../../../../../providers/radio';
import { useNotify } from '../../../../../providers/notifications';
import { usePersonPhoto } from '../../../../../features/social/usePersonPhoto';
import { avatarFromFile } from '../../../../../features/social/avatarImage';
import { socialClient } from '../../../../../services/socialClient';
import { useState } from 'react';
import { useKeyboardLighting } from './keyboardlighting/useKeyboardLighting';
import useSettingsForm from '../form';
import FormCards from '../form-cards';
import FormCard from '../form-cards/card';
import { blocks } from './rows';

const preferences = {
  "profile.displayName": "displayName",
  "interface.theme": "theme", "interface.language": "language",
  "interface.headingFont": "headingFont", "interface.textFont": "textFont",
  "interface.reducedMotion": "reducedMotion", "application.autoUpdate": "autoUpdate",
  "integrations.discordPresence": "discordPresence",
} as const satisfies Record<string, keyof Preferences>;

const AppearancePanel = observer(() => {
  const radio = store.radio;
  const inbox = store.inbox;
  const me = inbox.type === "inbox" ? inbox.me : undefined;
  const photo = usePersonPhoto(me?.accountId, me?.avatarVersion ?? 0);
  const [changingPhoto, setChangingPhoto] = useState(false);
  const notify = useNotify();
  const lighting = useKeyboardLighting();
  const changePhoto = async (file: File) => {
    if (!me || changingPhoto) return;
    setChangingPhoto(true);
    try {
      const photo = await avatarFromFile(file);
      await socialClient.setAvatar(photo.mime, photo.data);
      store.updatePreferences({ profilePhoto: `data:${photo.mime};base64,${photo.data}` });
    } catch (error) {
      notify(error instanceof Error ? error.message : tr("photoUnreadable"), "error");
    } finally {
      setChangingPhoto(false);
    }
  };
  const form = useSettingsForm({
    profile: { ...store.profile, photo: photo ?? store.profile.photo, canChangePhoto: !!me && !changingPhoto },
    interface: store.interface, application: store.application, integrations: store.integrations,
    radio, keyboardLighting: { show: lighting.capabilities?.available ?? false },
  }, (path, value) => {
    if (Object.hasOwn(preferences, path)) {
      const key = preferences[path as keyof typeof preferences];
      if (key === "displayName" && typeof value === "string") value = value.slice(0, 48);
      const parsed = parsePreferences({ ...store.preferences, [key]: value });
      store.updatePreferences({ [key]: parsed[key] });
    } else if (path === "profile.photo") {
      if (Array.isArray(value) && value[0] instanceof File) void changePhoto(value[0]);
    } else if (path.startsWith("integrations.keyboardLighting.")) {
      const key = path.slice("integrations.keyboardLighting.".length);
      const parsed = parsePreferences({ ...store.preferences,
        keyboardLighting: { ...store.preferences.keyboardLighting, [key]: value } });
      lighting.update(parsed.keyboardLighting);
    } else if (path === "radio.volume" && typeof value === "number" && radio.canControl) {
      setRadioVolume(value);
    } else if (path === "radio.stationId" && typeof value === "string" && radio.canControl) {
      setRadioStation(value);
    } else if (path === "radio.enabled" && typeof value === "boolean" && radio.canControl) {
      if (value !== radio.enabled) toggleRadio();
    }
  });
  const {
    theme: { span, ...theme },
    ...settings
  } = blocks(form.values);
  return (
    <Form form={form}><Grid columns={12} gap={3}>
      <Grid span={span}>
        <FormCard title={tr('theme')} {...theme} />
      </Grid>
      <Grid span={{ base: 'full', md: 9, lg: 8 }}>
        <FormCards blocks={settings} />
      </Grid>
    </Grid></Form>
  );
});

export default AppearancePanel;
