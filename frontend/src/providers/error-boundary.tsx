import {
  Card,
  CollapsibleSection,
  copyText,
  Dialog,
  IconButton,
  KeyValueList,
  MessageBar,
  Stack,
  tr,
  Typography,
  useLocale,
} from '@neo-ui-kit/react';
import { useState } from 'react';
import { getErrorMessage, type FallbackProps } from 'react-error-boundary';
import { version } from '../../package.json';
import { TitleBar } from '../app/TitleBar';
import { routes } from '../shared/routes';

const ErrorFallback = ({ error }: FallbackProps) => {
  const locale = useLocale();
  const [time] = useState(() => new Date());
  const [copyState, setCopyState] = useState<'idle' | 'pending' | 'failed'>(
    'idle',
  );
  const text =
    (error instanceof Error && error.stack) ||
    getErrorMessage(error) ||
    tr('errorBoundary.unknownError');
  const details = {
    [tr('errorBoundary.time')]: time.toLocaleString(locale),
    [tr('errorBoundary.page')]: location.href,
    [tr('errorBoundary.version')]: version,
    [tr('errorBoundary.userAgent')]: navigator.userAgent,
  };
  const report = `${text}\n${JSON.stringify(details, null, 2)}`;
  const copyReport = () => {
    setCopyState('pending');
    void copyText(report).then(
      (copied) => setCopyState(copied ? 'idle' : 'failed'),
      () => setCopyState('failed'),
    );
  };
  return (
    <>
      <TitleBar />
      <Dialog
        open
        width="wide"
        icon="warning"
        dismissible={false}
        title={tr('errorBoundary.title')}
        description={tr('errorBoundary.description')}
        confirmLabel={tr('errorBoundary.retry')}
        cancelLabel={tr('errorBoundary.home')}
        onOpenChange={() => {
          location.hash = routes.library;
          location.reload();
        }}
        onConfirm={() => {
          location.reload();
          return false;
        }}
      >
        <Stack gap={3}>
          <Card
            title={tr('errorBoundary.error')}
            actions={
              <IconButton
                icon="copy"
                label={tr('errorBoundary.copy')}
                loading={copyState === 'pending'}
                onClick={copyReport}
              />
            }
          >
            <Typography
              as="pre"
              variant="mono"
              text={text}
              style={{ whiteSpace: 'pre-wrap', overflowWrap: 'anywhere' }}
            />
            {copyState === 'failed' && (
              <MessageBar tone="error">{tr('actionFailed')}</MessageBar>
            )}
          </Card>
          <CollapsibleSection title={tr('errorBoundary.details')}>
            <KeyValueList items={Object.entries(details)} />
          </CollapsibleSection>
        </Stack>
      </Dialog>
    </>
  );
};

export default ErrorFallback;
