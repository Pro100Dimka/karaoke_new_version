import { useEffect, useState } from "react";
import { Keyboard } from "lucide-react";
import { useApp } from "../../app/AppContext";
import { useText } from "../../i18n/useText";
import { keyboardLightingClient } from "../../services/keyboardLightingClient";
import { Select, Slider, Switch } from "../../theme/ui";
import { SettingsCard } from "./SettingsCard";

export const KeyboardLightingSettings = () => {
  const { preferences, updatePreferences } = useApp();
  const t = useText();
  const [capabilities, setCapabilities] = useState<KeyboardLightingCapabilities>();
  const lighting = preferences.keyboardLighting;

  useEffect(() => {
    let active = true;
    const refresh = () => void keyboardLightingClient.capabilities().then(value => active && setCapabilities(value));
    refresh();
    const timer = window.setInterval(refresh, 5000);
    return () => { active = false; window.clearInterval(timer); };
  }, []);

  if (!capabilities?.available) return null;
  const update = (patch: Partial<typeof lighting>) => {
    const next = { ...lighting, ...patch };
    updatePreferences({ keyboardLighting: next });
    void keyboardLightingClient.apply(next, preferences.theme).catch(() => undefined);
  };

  return (
    <SettingsCard
      icon={Keyboard}
      title={t("keyboardLighting")}
      description={t("keyboardLightingStatus", {
        provider: capabilities.provider ?? "OpenRGB",
        count: capabilities.deviceCount,
      })}
    >
      <div className="keyboardLightingControls">
        <Switch
          variant="plain"
          checked={lighting.enabled}
          label={t("enabled")}
          onChange={enabled => update({ enabled })}
        />
        <Select
          label={t("lightingMode")}
          value={lighting.mode}
          options={[
            { value: "theme", label: t("lightingThemeMode") },
            { value: "music", label: t("lightingMusicMode") },
          ]}
          onChange={mode => update({ mode: mode as typeof lighting.mode })}
        />
        <label>
          <span>{t("lightingBrightness")}</span>
          <Slider min={0} max={100} value={lighting.brightness} onChange={brightness => update({ brightness })} />
        </label>
        <label>
          <span>{t("lightingSensitivity")}</span>
          <Slider min={0} max={100} value={lighting.sensitivity} onChange={sensitivity => update({ sensitivity })} />
        </label>
      </div>
    </SettingsCard>
  );
};
