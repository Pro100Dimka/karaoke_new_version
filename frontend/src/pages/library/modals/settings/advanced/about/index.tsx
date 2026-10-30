import { Card, Equalizer, KeyValueList, Planet, Stack, Typography, tr, useLocale } from "@neo-ui-kit/react";
import { version } from "../../../../../../../package.json";
import { ru } from "../../../../../../i18n/messages.ru";
import type { SubsystemHealth } from "../useSubsystemHealth";

export const frontendVersion: string = version;

/** Versions of every part of the app under the brand's planet. */
export const AboutPanel = ({ health }: { health: SubsystemHealth }) => {
  useLocale();
  const { backend, audioVersion } = health;
  const unavailable = tr(ru.unavailable);
  const rows: [string, string][] = [
    [tr(ru.frontendVersion), frontendVersion],
    [
      tr(ru.pythonBackendVersion),
      backend
        ? `${backend.backendVersion} (API ${backend.apiVersion})`
        : unavailable,
    ],
    [tr(ru.audioServiceVersion), audioVersion || unavailable],
    [
      tr(ru.pipelineVersion),
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
        background: "unset!important",
        height: "100%",
        boxShadow: "unset!important",
      }}
    >
      <Planet className="advancedAboutPlanet">
        <Stack gap={1}>
          <Typography variant="h3" as="h2">
            A&amp;D Voice
          </Typography>
          <Typography variant="caption" tone="muted">
            {tr(ru.copyright)}
          </Typography>
        </Stack>
        <div className="advancedAboutPromise" aria-hidden="true">
          <span>{tr(ru.brandPromiseSound)}</span>
          <span>{tr(ru.brandPromiseSinging)}</span>
          <Equalizer bars={7} playing />
        </div>
      </Planet>
      <KeyValueList className="advancedAboutVersions" items={rows} />
    </Card>
  );
};
