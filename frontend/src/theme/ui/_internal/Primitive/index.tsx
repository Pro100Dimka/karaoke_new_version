import { forwardRef, type ComponentPropsWithoutRef, type CSSProperties, type ElementType } from "react";
import type { StyleVars } from "../types";

type Spacing = number | string;

export interface PrimitiveOwnProps {
  as?: ElementType;
  sx?: StyleVars;
  style?: CSSProperties | StyleVars;
  /** Attributes of the element chosen through `as`; validated by the wrapping component. */
  type?: string;
  disabled?: boolean;
  href?: string;
  htmlFor?: string;
  p?: Spacing;
  px?: Spacing;
  py?: Spacing;
  pt?: Spacing;
  pr?: Spacing;
  pb?: Spacing;
  pl?: Spacing;
  m?: Spacing;
  mx?: Spacing;
  my?: Spacing;
  mt?: Spacing;
  mr?: Spacing;
  mb?: Spacing;
  ml?: Spacing;
}

export type PrimitiveProps = PrimitiveOwnProps &
  Omit<ComponentPropsWithoutRef<"div">, keyof PrimitiveOwnProps>;

const unit = (value: Spacing): string => (typeof value === "number" ? `${value}px` : value);

const Primitive = forwardRef<HTMLElement, PrimitiveProps>(function Primitive(
  { as: Component = "div", sx, style, p, px, py, pt, pr, pb, pl, m, mx, my, mt, mr, mb, ml, ...props },
  ref
) {
  const spacing: StyleVars = {
    ...(p != null && { padding: unit(p) }),
    ...(px != null && { paddingInline: unit(px) }),
    ...(py != null && { paddingBlock: unit(py) }),
    ...(pt != null && { paddingTop: unit(pt) }),
    ...(pr != null && { paddingRight: unit(pr) }),
    ...(pb != null && { paddingBottom: unit(pb) }),
    ...(pl != null && { paddingLeft: unit(pl) }),
    ...(m != null && { margin: unit(m) }),
    ...(mx != null && { marginInline: unit(mx) }),
    ...(my != null && { marginBlock: unit(my) }),
    ...(mt != null && { marginTop: unit(mt) }),
    ...(mr != null && { marginRight: unit(mr) }),
    ...(mb != null && { marginBottom: unit(mb) }),
    ...(ml != null && { marginLeft: unit(ml) })
  };

  return <Component ref={ref} style={{ ...spacing, ...sx, ...style }} {...props} />;
});

export default Primitive;
