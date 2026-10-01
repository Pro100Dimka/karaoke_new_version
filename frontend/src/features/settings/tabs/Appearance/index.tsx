import { ChevronDown, RadioTower, Volume2 } from "lucide-react";
import { type CSSProperties, useId } from "react";
import { useApp } from "../../../../app/AppContext";
import { useRadio } from "../../../../app/RadioContext";
import type { Language } from "../../../../contracts/models";
import { useText } from "../../../../i18n/useText";
import ThemePicker from "../../../../theme/ui/ThemePicker";
import { ProfileSettings } from "../../../social/ProfileSettings";
import { SettingsNeonFrame } from "../../SettingsNeonFrame";
import "./appearance.css";
import { KeyboardLightingSettings } from "./KeyboardLighting";
import { langs, radioStationOptions } from "./consts";

const themeDescriptions: Record<Language, string> = {
  ru: "Выберите стиль, который подходит вам",
  uk: "Оберіть стиль, який вам пасує",
  en: "Choose the style that suits you",
};

export const AppearanceSettings = () => {
  const { preferences, updatePreferences } = useApp();
  const radio = useRadio();
  const t = useText();
  const themeTitleId = useId();
  return (
    <div className="appearanceStack">
      <ProfileSettings />

      <div className="appearanceCard appearancePreferences" role="group" aria-label={t("appearance")}>
        <SettingsNeonFrame order={1} />
        <label className="appearanceField appearanceNameField">
          <span>{t("onlineDisplayName")}</span>
          <input className="appearanceInput" maxLength={48} value={preferences.displayName}
            onChange={event => updatePreferences({ displayName: event.target.value })} />
        </label>
        <label className="appearanceField appearanceLanguageField">
          <span>{t("language")}</span>
          <span className="appearanceSelect">
            <select value={preferences.language}
              onChange={event => updatePreferences({ language: event.target.value as Language })}>
              {langs.map(option => <option key={option.value} value={option.value}>{option.label}</option>)}
            </select>
            <ChevronDown aria-hidden="true" />
          </span>
        </label>
        <label className="appearanceToggleField appearanceMotionField">
          <input type="checkbox" role="switch" checked={preferences.reducedMotion}
            onChange={event => updatePreferences({ reducedMotion: event.target.checked })} />
          <span className="appearanceToggle" aria-hidden="true"><span /></span>
          <span>{t("reduceAnimations")}</span>
        </label>
        <label className="appearanceField appearanceRadioField">
          <span>{t("radioStation")}</span>
          <span className="appearanceSelect appearanceSelectWithIcon">
            <RadioTower aria-hidden="true" />
            <select disabled={!radio.canControl} value={radio.stationId} onChange={event => radio.setStation(event.target.value)}>
              {radioStationOptions.map(option => <option key={option.value} value={option.value}>{option.label}</option>)}
            </select>
            <ChevronDown aria-hidden="true" />
          </span>
        </label>
        <label className="appearanceField appearanceVolumeField">
          <span>{t("radioVolume")}</span>
          <span className="appearanceVolume">
            <Volume2 aria-hidden="true" />
            <input aria-label={t("radioVolume")} type="range" min={0} max={100} value={radio.volume}
              style={{ "--appearance-volume": `${radio.volume}%` } as CSSProperties}
              onChange={event => radio.setVolume(Number(event.target.value))} />
            <output>{radio.volume}</output>
          </span>
        </label>
        <label className="appearanceToggleField appearanceRadioToggleField">
          <input type="checkbox" role="switch" disabled={!radio.canControl} checked={radio.enabled} onChange={radio.toggle} />
          <span className="appearanceToggle" aria-hidden="true"><span /></span>
          <span>{t("radioEnabled")}</span>
        </label>
      </div>

      <section className="appearanceCard appearanceThemes" aria-labelledby={themeTitleId}>
        <SettingsNeonFrame order={2} />
        <div className="appearanceThemeHeading">
          <h2 id={themeTitleId}>{t("theme")}</h2>
          <p>{themeDescriptions[preferences.language]}</p>
        </div>
        <ThemePicker value={preferences.theme} onChange={theme => updatePreferences({ theme })} />
      </section>

      <KeyboardLightingSettings />
    </div>
  );
};
