import { useApp } from "../../app/AppContext";
import { themeIconMotionColors, themeIcons } from "./themeIcons";
import { BrandIconMotion } from "./BrandIconMotion";
import "./brand-loader.css";

/**
 * Startup loader: only the theme icon, glowing in the theme colour, with a light sweep that runs across the icon's
 * own shape. The label is for screen readers. All motion is CSS, so the global reduced-motion rule stills it.
 */
export const BrandLoader = ({ label }: { label: string }) => {
  const { theme } = useApp();
  const icon = themeIcons[theme];

  return (
    <div className="brandLoader" role="status" aria-live="polite" aria-label={label}>
      <BrandIconMotion src={icon} className="brandLoaderSvg" colors={themeIconMotionColors[theme]} />
    </div>
  );
};
