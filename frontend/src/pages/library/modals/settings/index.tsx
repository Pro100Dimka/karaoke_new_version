import {
  AnimatedBorder,
  Dialog,
  Loader,
  Stack,
  Tabs,
  tr,
  useLocale,
} from '@neo-ui-kit/react';
import { createCommandQueue } from '../../../../app/desktop/shellBus';
import '../../../../providers/localization';
import type { SettingsTab } from '../../../../contracts/models';
import { lazy, startTransition, Suspense, useLayoutEffect, useState } from 'react';

const tabs = {
  appearance: {
    Component: lazy(() => import('./appearance')),
    icon: 'palette',
    label: 'appearance',
  },
  audio: {
    Component: lazy(() => import('./audio')),
    icon: 'headphones',
    label: 'audio',
  },
  ai: { Component: lazy(() => import('./ai')), icon: 'chip', label: 'ai' },
  environment: {
    Component: lazy(() =>
      import('./environment').then((module) => ({
        default: module.SecretsSettings,
      })),
    ),
    icon: 'key',
    label: 'environmentKeys',
  },
  advanced: {
    Component: lazy(() =>
      import('./advanced').then((module) => ({
        default: module.AdvancedSettings,
      })),
    ),
    icon: 'wrench',
    label: 'advanced',
  },
};
import SettingsAtmosphere from './atmosphere';

const requests = createCommandQueue<SettingsTab>();
export const openSettings = (tab: SettingsTab = 'appearance') =>
  requests.push(tab);

const SettingsModal = ({
  onOpenChange,
}: {
  onOpenChange(open: boolean): void;
}) => {
  useLocale();
  const [tab, setTab] = useState<SettingsTab | null>(null);
  useLayoutEffect(() => {
    const unsubscribe = requests.subscribe((tab) => {
      // Opening the dialog is urgent user input; only tab content is deferred.
      setTab(tab);
      onOpenChange(true);
    });
    return () => {
      unsubscribe();
      onOpenChange(false);
    };
  }, [onOpenChange]);
  const close = () => {
    setTab(null);
    onOpenChange(false);
  };
  const Content = tab ? tabs[tab].Component : null;
  return (
    <Dialog
        open={tab !== null}
        onOpenChange={(open) => {
          if (!open) close();
        }}
        width="full"
        icon="settings"
        title={tr('settings')}
        closeLabel={tr('closeDialog')}
        cancelLabel={false}
        confirmLabel={false}
        art={
          <>
            <SettingsAtmosphere />
            <AnimatedBorder shell style={{ position: 'absolute', inset: 0 }} />
          </>
        }
    >
      {tab && Content && (
          <Stack gap={4} style={{ paddingInline: 'var(--ad-space-4)' }}>
            <Tabs
              className="settingsTabs"
              value={tab}
              onValueChange={(value) => startTransition(() => setTab(value))}
              items={(Object.keys(tabs) as SettingsTab[]).map((value) => ({
                value,
                label: tr(tabs[value].label),
                icon: tabs[value].icon,
              }))}
            />
            <div className="settingsBody">
              <Suspense
                fallback={<Loader size="md" label={tr('library.loading')} />}
              >
                <Content />
              </Suspense>
            </div>
          </Stack>
      )}
    </Dialog>
  );
};
export default SettingsModal;
