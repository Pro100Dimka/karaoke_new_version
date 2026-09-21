export interface SelectPlacement {
  top: number;
  left: number;
  width: number;
  maxHeight: number;
  above: boolean;
}

export function selectPosition(
  rect: DOMRect,
  { width, height, menuHeight }: { width: number; height: number; menuHeight: number }
): SelectPlacement {
  const margin = 8;
  const gap = 6;
  const below = Math.max(0, height - margin - rect.bottom - gap);
  const above = Math.max(0, rect.top - gap - margin);
  const openAbove = menuHeight > below && above > below;
  const menuWidth = Math.min(Math.max(rect.width, 192), Math.max(0, width - margin * 2));

  return {
    top: Math.min(height - margin, Math.max(margin, openAbove ? rect.top - gap : rect.bottom + gap)),
    left: Math.max(margin, Math.min(rect.left, width - margin - menuWidth)),
    width: menuWidth,
    maxHeight: openAbove ? above : below,
    above: openAbove
  };
}
