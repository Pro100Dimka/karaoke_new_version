import {
  Button,
  Card,
  Grid,
  MessageBar,
  Stack,
  Switch,
  tr,
  Typography,
} from '@neo-ui-kit/react';
import { useEffect, useState } from 'react';
import { observer } from 'mobx-react-lite';
import type { PrivacyState } from '../../../../../../electron/ipcChannels';
import { desktopClient } from '../../../../../services/desktopClient';
import { store } from '../../../../../providers/store';
import { ask } from '../../../../../providers/dialog';
import { useNotify } from '../../../../../providers/notifications';
import { AboutPanel } from './about/index';
import { DiagnosticsPanel } from './diagnostics/index';
import { HistoryPanel } from './history/index';
import { StoragePanel } from './storage/index';
import { useSubsystemHealth } from './useSubsystemHealth';
import './advanced.css';

export const AdvancedSettings = () => {
  const health = useSubsystemHealth();

  return (
    <Grid columns={12} gap={3}>
      {health.failed && (
        <Grid span="full">
          <MessageBar tone="error">{tr('errors.diagnostics')}</MessageBar>
        </Grid>
      )}
      <Grid span={{ base: 'full', sm: 4 }}>
        <StoragePanel
          usage={health.backend?.storage ?? null}
          loading={health.loading}
          onChanged={health.refresh}
        />
      </Grid>
      <Grid span={{ base: 'full', sm: 4 }}>
        <DiagnosticsPanel health={health} />
      </Grid>
      <Grid span={{ base: 'full', sm: 4 }}>
        <AboutPanel health={health} />
      </Grid>
      <Grid span={{ base: 'full' }}>
        <PrivacyPanel />
      </Grid>
      <Grid span={{ base: 'full' }}>
        <HistoryPanel />
      </Grid>
    </Grid>
  );
};

const PrivacyPanel = observer(() => {
  const [privacy, setPrivacy] = useState<PrivacyState | null>(null);
  const [busy, setBusy] = useState(false);
  const [deleting, setDeleting] = useState(false);
  const notify = useNotify();
  useEffect(() => {
    let active = true;
    void desktopClient
      .getPrivacySettings?.()
      .then((value) => {
        if (active) setPrivacy(value);
      })
      .catch(() => notify(tr('settingsApplyFailed'), 'error'));
    return () => {
      active = false;
    };
  }, [notify]);

  const changeTransfer = async (
    purpose: 'online' | 'processing' | 'diagnostics',
    enabled: boolean,
  ) => {
    if (busy || !desktopClient.setTransferConsent) return;
    if (
      enabled &&
      (await ask({
        title: tr('privacyTransferTitle'),
        body: `${tr('privacyTransferNotice')}\n\n${tr(`privacyTransfer.${purpose}`)}\n\n${tr('privacyTransferRisks')}`,
        tone: 'warning',
        actions: [
          { id: 'cancel', label: tr('cancel') },
          {
            id: 'consent',
            label: tr('privacyTransferAgree'),
            appearance: 'primary',
          },
        ],
      })) !== 'consent'
    )
      return;
    setBusy(true);
    try {
      setPrivacy(await desktopClient.setTransferConsent(purpose, enabled));
    } catch {
      notify(tr('privacyTransferFailed'), 'error');
    } finally {
      const next = await desktopClient.getPrivacySettings?.().catch(() => null);
      if (next) setPrivacy(next);
      setBusy(false);
    }
  };
  const changeAccount = async () => {
    if (busy || !privacy) return;
    const deleting = privacy.accountEnabled;
    const confirmed = await ask({
      title: tr(deleting ? 'privacyDeleteAccount' : 'privacyCreateAccount'),
      body: deleting
        ? `${tr('privacyDeleteConfirm')}\n\n${tr('privacyDeletionScope')}`
        : tr('privacyCreateConfirm'),
      tone: 'warning',
      actions: [
        { id: 'cancel', label: tr('cancel') },
        {
          id: 'confirm',
          label: tr(deleting ? 'privacyDeleteAccount' : 'privacyCreateAccount'),
          appearance: 'primary',
        },
      ],
    });
    if (confirmed !== 'confirm') return;
    setBusy(true);
    setDeleting(deleting);
    try {
      if (deleting) {
        if (!desktopClient.deleteOnlineAccount) return;
        await desktopClient.deleteOnlineAccount(
          store.inbox.type === 'inbox' ? store.inbox.me.accountId : '',
        );
        store.updatePreferences({
          profilePhoto: '',
          displayName: '',
          discordPresence: false,
        });
        store.setInbox({ type: 'offline' });
      } else {
        await desktopClient.createOnlineAccount?.();
      }
      const next = await desktopClient.getPrivacySettings?.();
      if (next) setPrivacy(next);
      await desktopClient.relaunchApp();
    } catch {
      notify(tr('privacyAccountFailed'), 'error');
    } finally {
      setDeleting(false);
      setBusy(false);
    }
  };

  return (
    <Card border title={tr('privacySettings')} icon="shield">
      <Stack gap={3}>
        <Typography variant="caption">{tr('privacyTransferHint')}</Typography>
        {(['online', 'processing', 'diagnostics'] as const).map((purpose) => (
          <Stack key={purpose} gap={1}>
            <Switch
              label={tr(`privacyTransferLabel.${purpose}`)}
              checked={privacy?.transfers?.[purpose].enabled ?? false}
              disabled={
                busy ||
                !privacy?.transfers ||
                (purpose !== 'online' && !privacy.transfers.online.enabled)
              }
              onValueChange={(enabled) => void changeTransfer(purpose, enabled)}
            />
            <Typography variant="caption">
              {tr(`privacyTransfer.${purpose}`)}
            </Typography>
            {privacy?.transfers?.[purpose].recordedAt && (
              <Typography variant="caption">
                {tr('privacyTransferRecorded')}:{' '}
                {new Date(
                  privacy.transfers[purpose].recordedAt,
                ).toLocaleString()}
              </Typography>
            )}
            {privacy?.transfers?.[purpose].pending && (
              <MessageBar tone="warning">
                {tr('privacyTransferPending')}
                <Button
                  label={tr('privacyTransferRetry')}
                  disabled={busy}
                  onClick={() => void changeTransfer(purpose, false)}
                />
              </MessageBar>
            )}
          </Stack>
        ))}
        <Typography variant="caption">
          {tr('privacyDiagnosticsHint')}
        </Typography>
        <Typography variant="caption">{tr('privacyRetentionHint')}</Typography>
        <Typography variant="caption">{tr('privacyDeletionScope')}</Typography>
        {deleting && <MessageBar>{tr('privacyDeletionWaiting')}</MessageBar>}
        <Button
          label={tr(
            privacy?.accountEnabled === false
              ? 'privacyCreateAccount'
              : 'privacyDeleteAccount',
          )}
          disabled={busy || !privacy || !!store.online.room}
          onClick={() => void changeAccount()}
        />
        <Typography variant="caption">
          {tr(store.online.room ? 'privacyLeaveRoom' : 'privacyAccountHint')}
        </Typography>
      </Stack>
    </Card>
  );
});
