import { AnimatedBorder, Dialog, Form, Stack, StatusIndicator, Tabs, tr, useLocale } from '@neo-ui-kit/react';
import { observer } from 'mobx-react-lite';
import { store } from '../../../../providers/store';
import '../../../../providers/localization';
import type { SettingsTab } from '../../../../contracts/models';
import { lazy, Suspense } from 'react';
import { SecretsSettings } from './environment/index';
import { AdvancedSettings } from './advanced/index';

const tabs = {
  appearance: { Component: lazy(() => import('./appearance')), icon: 'palette', label: 'appearance' },
  audio: { Component: lazy(() => import('./audio')), icon: 'headphones', label: 'audio' },
  ai: { Component: lazy(() => import('./ai')), icon: 'chip', label: 'ai' },
  environment: { Component: SecretsSettings, icon: 'key', label: 'environmentKeys' },
  advanced: { Component: AdvancedSettings, icon: 'wrench', label: 'advanced' },
};
import useSettingsForm from './form';
import SettingsAtmosphere from './atmosphere';

const SettingsContents = observer(() => {
  const tab = store.settingsTab;
  const form = useSettingsForm(tab);
  const Content = tabs[tab].Component;
  return (
    <Stack gap={4} style={{ paddingInline: 'var(--ad-space-4)' }}>
      <Tabs value={tab} onValueChange={store.openSettings}
        items={(Object.keys(tabs) as SettingsTab[]).map((value) => ({
          value, label: tr(tabs[value].label), icon: tabs[value].icon,
        }))} />
      <Form form={form} className="settingsBody">
        <Suspense fallback={<StatusIndicator status="processing" label={tr('loading')} />}>
          <Content form={form} language={store.interface.language} />
        </Suspense>
      </Form>
    </Stack>
  );
});

const SettingsModal = observer(() => {
  useLocale();
  return (
  <Dialog open={store.settingsOpen} onOpenChange={store.setSettingsOpen}
    width="full" icon="settings" title={tr('settings')} closeLabel={tr('closeDialog')}
    cancelLabel={false} confirmLabel={false}
    art={<><SettingsAtmosphere /><AnimatedBorder shell style={{ position: 'absolute', inset: 0 }} /></>}
  >
    {store.settingsOpen && <SettingsContents />}
  </Dialog>
  );
});
export default SettingsModal;
