import {
  AnimatedBorder,
  Button,
  Dialog,
  Loader,
  LocaleProvider,
  MessageBar,
  Select,
  Stack,
  Tabs,
  tr,
  setLocale,
} from '@neo-ui-kit/react';
import { useEffect, useState } from 'react';
import type { LegalDocumentState } from '../../electron/ipcChannels';
import '../providers/localization';
import ThemeConfig from '../providers/theme';
import SettingsAtmosphere from '../pages/library/modals/settings/atmosphere';
import { desktopClient } from '../services/desktopClient';
import { store } from '../providers/store';
import './legalDocuments.css';

const documentLabels = {
  'terms-of-use': 'legalTerms',
  'privacy-policy': 'legalPrivacy',
  'third-party-licenses': 'legalThirdParty',
} as const;
const documentNames = Object.keys(
  documentLabels,
) as (keyof typeof documentLabels)[];

export default function LegalDocuments({ onClose }: { onClose?: () => void }) {
  const [state, setState] = useState<LegalDocumentState>();
  const [language, setLanguage] = useState(store.interface.language);
  const [document, setDocument] =
    useState<keyof typeof documentLabels>('terms-of-use');
  const [failed, setFailed] = useState(false);
  const load = async () => {
    setFailed(false);
    try {
      if (!desktopClient.getLegalDocuments)
        throw new Error('Legal bridge unavailable');
      const next = await desktopClient.getLegalDocuments();
      setState(next);
      const locale = onClose ? store.interface.language : next.language;
      setLocale(locale);
      setLanguage(locale);
    } catch {
      setFailed(true);
    }
  };
  useEffect(() => {
    void load();
  }, []);
  useEffect(() => {
    window.document.documentElement.lang = language;
  }, [language]);
  const close = () => {
    if (onClose) {
      setLocale(store.interface.language);
      window.document.documentElement.lang = store.interface.language;
      onClose();
    } else void desktopClient.closeLegalDocuments?.();
  };
  const content = state?.documents.find(
    (item) => item.language === language && item.name === document,
  )?.text;
  const contentView = (
    <LocaleProvider locale={language}>
      {!onClose && <div className="legalWindowDrag" aria-hidden />}
      <Dialog
        open
        dismissible={false}
        width="full"
        className={`legalDialog${onClose ? '' : ' legalStartup'}`}
        icon="document"
        title={tr('legalTitle')}
        closeLabel={tr('closeDialog')}
        description={
          state?.requireAcknowledgement ? tr('legalIntro') : undefined
        }
        onOpenChange={(open) => {
          if (!open) close();
        }}
        cancelLabel={
          state?.requireAcknowledgement ? tr('legalExit') : tr('closeDialog')
        }
        confirmLabel={
          state?.requireAcknowledgement
            ? tr(state.draft ? 'legalDraftContinue' : 'legalAccept')
            : false
        }
        onConfirm={async () => {
          try {
            if (!desktopClient.acceptLegalDocuments)
              throw new Error('Legal bridge unavailable');
            await desktopClient.acceptLegalDocuments(language);
          } catch {
            setFailed(true);
          }
          return false;
        }}
        art={
          <>
            <SettingsAtmosphere />
            <AnimatedBorder shell style={{ position: 'absolute', inset: 0 }} />
          </>
        }
      >
        <Stack gap={3}>
          <Select
            label={tr('language')}
            value={language}
            options={[
              { value: 'ru', label: 'Русский' },
              { value: 'uk', label: 'Українська' },
              { value: 'en', label: 'English' },
            ]}
            onValueChange={(value) => {
              const selected = (['ru', 'uk', 'en'] as const).find(
                (item) => item === value,
              );
              if (selected) {
                setLocale(selected);
                setLanguage(selected);
              }
            }}
          />
          {state?.draft && <MessageBar>{tr('legalDraftNotice')}</MessageBar>}
          {failed && (
            <MessageBar
              tone="error"
              action={
                <Button label={tr('retry')} onClick={() => void load()} />
              }
            >
              {tr('legalError')}
            </MessageBar>
          )}
          {!state && !failed && <Loader label={tr('library.loading')} />}
          {state && (
            <>
              <Tabs
                value={document}
                onValueChange={setDocument}
                items={documentNames.map((value) => ({
                  value,
                  label: tr(documentLabels[value]),
                }))}
              />
              <article
                className="legalDocumentText"
                key={`${language}-${document}`}
                aria-label={tr(documentLabels[document])}
              >
                {content}
              </article>
            </>
          )}
        </Stack>
      </Dialog>
    </LocaleProvider>
  );
  return onClose ? contentView : <ThemeConfig>{contentView}</ThemeConfig>;
}
