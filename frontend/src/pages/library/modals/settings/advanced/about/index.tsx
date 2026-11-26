import {
  Card,
  Button,
  Equalizer,
  KeyValueList,
  Planet,
  Stack,
  Typography,
  tr,
  useLocale,
} from '@neo-ui-kit/react';
import { version } from '../../../../../../../package.json';
import ffmpeg from '../../../../../../../../docs/third-party/ffmpeg/distribution.json';
import type { SubsystemHealth } from '../useSubsystemHealth';
import { desktopClient } from '../../../../../../services/desktopClient';

export const frontendVersion: string = version;

/** Versions of every part of the app under the brand's planet. */
export const AboutPanel = ({ health }: { health: SubsystemHealth }) => {
  useLocale();
  const { backend, audioVersion } = health;
  const unavailable = tr('unavailable');
  const rows: [string, string][] = [
    [tr('frontendVersion'), frontendVersion],
    [
      tr('pythonBackendVersion'),
      backend
        ? `${backend.backendVersion} (API ${backend.apiVersion})`
        : unavailable,
    ],
    [tr('audioServiceVersion'), audioVersion || unavailable],
    ['FFmpeg', `${ffmpeg.version} (GPLv3)`],
    [
      tr('pipelineVersion'),
      backend
        ? `DB ${backend.dbSchema} · project format ${backend.projectFormat}`
        : unavailable,
    ],
  ];

  return (
    <Card
      border
      padding="none"
      className="advancedAboutCard"
      style={{
        background: 'unset',
        height: '100%',
        boxShadow: 'unset',
      }}
    >
      <Planet className="advancedAboutPlanet">
        <Stack gap={1}>
          <Typography variant="h3" as="h2">
            A&amp;D Voice
          </Typography>
          <Typography variant="caption" tone="muted">
            {tr('copyright')}
          </Typography>
        </Stack>
        <div className="advancedAboutPromise" aria-hidden="true">
          <span>{tr('brandPromiseSound')}</span>
          <span>{tr('brandPromiseSinging')}</span>
          <Equalizer bars={7} playing />
        </div>
      </Planet>
      <KeyValueList className="advancedAboutVersions" items={rows} />
      <Button onClick={() => void desktopClient.showLegalDocuments?.()}>
        {tr('legalDocuments')}
      </Button>
      <Button
        onClick={() =>
          void desktopClient.openExternal(
            `https://github.com/Pro100Dimka/karaoke_new_version/releases/download/v${version}/${ffmpeg.sourceArchive.name}`,
          )
        }
      >
        {tr('ffmpegSources')}
      </Button>
    </Card>
  );
};
