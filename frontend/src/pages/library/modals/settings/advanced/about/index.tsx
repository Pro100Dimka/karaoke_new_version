import {
  Card,
  Equalizer,
  KeyValueList,
  Planet,
  Stack,
  Typography,
  tr,
  useLocale,
} from '@neo-ui-kit/react';
import { version } from '../../../../../../../package.json';
import type { SubsystemHealth } from '../useSubsystemHealth';

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
        background: 'unset!important',
        height: '100%',
        boxShadow: 'unset!important',
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
    </Card>
  );
};
