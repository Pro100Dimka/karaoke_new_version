import {
  Avatar,
  Beacon,
  Button,
  Card,
  Dialog,
  Icon,
  MessageBar,
  NeonWaves,
  Stack,
  TextField,
  Typography,
  tr,
  useLocale,
} from '@neo-ui-kit/react';
import { observer } from 'mobx-react-lite';
import { useEffect, useState } from 'react';
import { roomSession } from '../../providers/application';
import { store } from '../../providers/store';
import { errorstring, toAppError } from '../../shared/errors';
import './room-entry.css';

type Busy = 'create' | 'join' | null;

/**
 * Singing together in one step: your name on top, then two choices side by side. Creating opens a
 * room at once; a pasted code (or Enter) joins it at once.
 */
export const RoomModal = observer(
  ({
    open,
    onClose,
    invitationCode,
  }: {
    open: boolean;
    onClose(): void;
    /** A code from an invitation link: shown ready to join, the singer only confirms their name. */
    invitationCode?: string;
  }) => {
    const { preferences, updatePreferences } = store;
    useLocale();
    const [name, setName] = useState(preferences.displayName);
    const [code, setCode] = useState(invitationCode ?? '');
    useEffect(() => {
      if (open && invitationCode) setCode(invitationCode);
    }, [open, invitationCode]);
    const [nameError, setNameError] = useState<string>();
    const [codeError, setCodeError] = useState<string>();
    const [failure, setFailure] = useState<string>();
    const [busy, setBusy] = useState<Busy>(null);

    const enter = async (roomCode?: string) => {
      const trimmed = name.trim();
      setFailure(undefined);
      setNameError(trimmed ? undefined : tr('fieldRequired'));
      if (roomCode !== undefined)
        setCodeError(roomCode.trim() ? undefined : tr('fieldRequired'));
      if (!trimmed || (roomCode !== undefined && !roomCode.trim())) return;
      setBusy(roomCode === undefined ? 'create' : 'join');
      try {
        await roomSession.join(trimmed, roomCode?.trim());
        updatePreferences({ displayName: trimmed });
        onClose();
      } catch (error) {
        setFailure(
          tr(errorstring(toAppError(error)) ?? 'roomNetworkUnavailable'),
        );
      } finally {
        setBusy(null);
      }
    };

    return (
      <Dialog
        open={open}
        onOpenChange={(next) => {
          if (!next && !busy) onClose();
        }}
        className="roomEntryDialog"
        width="wide"
        icon="users"
        title={tr('roomTitle')}
        description={tr('roomIntro')}
        closeLabel={tr('closeDialog')}
        cancelLabel={false}
        confirmLabel={false}
        art={
          <NeonWaves
            className="roomEntryWaves"
            shape="ridge"
            comets={3}
            strands={24}
          />
        }
      >
        <div className="roomEntry">
          <Stack direction="row" gap={4} align="center">
            <Avatar size="lg" name={name.trim() || '?'} />
            <TextField
              className="roomEntryName"
              name="name"
              label={tr('displayName')}
              required
              clearable
              autoComplete="name"
              value={name}
              error={nameError}
              onValueChange={(value) => {
                setName(value);
                setNameError(undefined);
              }}
            />
          </Stack>

          <div className="roomEntryChoices">
            <div className="roomEntryChoice">
              <Card
                border
                padding="md"
                className="roomEntryCard"
                data-choice="create"
              >
                <Beacon active={busy === null}>
                  <Icon name="users" surface="tile" size={28} />
                </Beacon>
                <Typography as="h3" variant="title">
                  {tr('createRoom')}
                </Typography>
                <Typography variant="body-sm" tone="muted">
                  {tr('createAndInvite')}
                </Typography>
                <Button
                  variant="primary"
                  icon="plus"
                  loading={busy === 'create'}
                  disabled={busy === 'join'}
                  onClick={() => void enter()}
                >
                  {tr('createRoom')}
                </Button>
              </Card>
            </div>

            <div className="roomEntryChoice">
              <Card
                border
                padding="md"
                className="roomEntryCard"
                data-choice="join"
              >
                <Icon name="key" surface="tile" size={28} />
                <Typography as="h3" variant="title">
                  {tr('joinByCode')}
                </Typography>
                <form
                  className="roomEntryJoin"
                  noValidate
                  onSubmit={(event) => {
                    event.preventDefault();
                    void enter(code);
                  }}
                >
                  <TextField
                    className="roomEntryCode"
                    name="code"
                    label={tr('roomCode')}
                    required
                    autoComplete="off"
                    placeholder={tr('roomCodePlaceholder')}
                    value={code}
                    error={codeError}
                    description={tr('roomCodePasteHint')}
                    onValueChange={(value) => {
                      setCode(value);
                      setCodeError(undefined);
                    }}
                    // A pasted code is a complete one: join right away.
                    onPaste={(event) => {
                      const pasted = event.clipboardData.getData('text').trim();
                      if (!pasted) return;
                      event.preventDefault();
                      setCode(pasted);
                      void enter(pasted);
                    }}
                  />
                  <Button
                    type="submit"
                    variant="primary"
                    icon="login"
                    loading={busy === 'join'}
                    disabled={busy === 'create'}
                  >
                    {tr('joinRoom')}
                  </Button>
                </form>
              </Card>
            </div>
          </div>

          {failure && <MessageBar tone="error">{failure}</MessageBar>}
        </div>
      </Dialog>
    );
  },
);
