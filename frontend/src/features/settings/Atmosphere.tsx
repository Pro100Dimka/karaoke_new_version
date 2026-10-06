import type { SVGProps } from "react";
import atmosphereUrl from "../../assets/karaoke-backgrounds/modal-atmosphere.svg";

export type SettingsAtmosphereProps = Omit<SVGProps<SVGSVGElement>, "color"> & {
  color?: string;
};

export const SettingsAtmosphere = ({
  color = "var(--color-primary)",
  style,
  ...props
}: SettingsAtmosphereProps) => {
  return (
    <svg
      {...props}
      viewBox="0 0 1342 1063"
      preserveAspectRatio="xMidYMid slice"
      aria-hidden
      focusable="false"
      style={{ ...style, color }}
    >
      <use href={`${atmosphereUrl}#settings-atmosphere`} />
    </svg>
  );
};
