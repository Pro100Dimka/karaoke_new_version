import type { StyleVars } from "./types";

export default function mergeSx(sx?: StyleVars, style?: StyleVars): StyleVars | undefined {
  return sx ? { ...sx, ...style } : style;
}
