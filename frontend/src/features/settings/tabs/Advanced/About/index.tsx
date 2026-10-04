import { Card, Equalizer, KeyValueList, Planet, Stack, Typography } from "@ad-voice/ui";
import { version } from "../../../../../../package.json";
import { useText } from "../../../../../i18n/useText";
import type { SubsystemHealth } from "../useSubsystemHealth";

export const frontendVersion: string = version;

/** Versions of every part of the app under the brand's planet. */
export const AboutPanel = ({ health }: { health: SubsystemHealth }) => {
  const t = useText();
  const { backend, audioVersion } = health;
  const unavailable = t("unavailable");
  const rows: [string, string][] = [
    [t("frontendVersion"), frontendVersion],
    [t("pythonBackendVersion"), backend ? `${backend.backendVersion} (API ${backend.apiVersion})` : unavailable],
    [t("audioServiceVersion"), audioVersion || unavailable],
    [t("pipelineVersion"), backend ? `DB ${backend.dbSchema} · project format ${backend.projectFormat}` : unavailable],
  ];

  return (
    <Card border padding="none" className="advancedAboutCard">
      <Planet className="advancedAboutPlanet">
        <Stack gap={1}>
          <Typography variant="h3" as="h2">A&amp;D Voice</Typography>
          <Typography variant="caption" tone="muted">{t("copyright")}</Typography>
        </Stack>
        <div className="advancedAboutPromise" aria-hidden="true">
          <span>BETTER SOUND</span>
          <span>BETTER SINGING</span>
          <Equalizer bars={7} playing />
        </div>
      </Planet>
      <KeyValueList className="advancedAboutVersions" items={rows} />
    </Card>
  );
};
