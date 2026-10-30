import {
  Card,
  CollapsibleSection,
  copyText,
  Dialog,
  IconButton,
  KeyValueList,
  Stack,
  tr,
  Typography,
  useLocale,
} from '@neo-ui-kit/react';
import { useState } from 'react';
import { getErrorMessage, type FallbackProps } from 'react-error-boundary';
import { version } from '../../package.json';

const ErrorFallback = ({ error }: FallbackProps) => {
  const locale = useLocale();
  const [time] = useState(() => new Date());
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
  return (
    <Dialog
      open
      width="wide"
      icon="warning"
      dismissible={false}
      title={tr('errorBoundary.title')}
      description={tr('errorBoundary.description')}
      confirmLabel={tr('errorBoundary.retry')}
      cancelLabel={tr('errorBoundary.home')}
      onOpenChange={() => location.assign(import.meta.env.BASE_URL)}
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
              onClick={() => copyText(report)}
            />
          }
        >
          <Typography
            as="pre"
            variant="mono"
            text={text}
            style={{ whiteSpace: 'pre-wrap', overflowWrap: 'anywhere' }}
          />
        </Card>
        <CollapsibleSection title={tr('errorBoundary.details')}>
          <KeyValueList items={Object.entries(details)} />
        </CollapsibleSection>
      </Stack>
    </Dialog>
  );
};

export default ErrorFallback;
