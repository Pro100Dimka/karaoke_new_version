const clamp = (value: number, min: number, max: number): number => Math.min(max, Math.max(min, value));

export function getRotaryDragValue({ value, lastY, clientY, min, max, fine = false }: {
  value: number; lastY: number; clientY: number; min: number; max: number; fine?: boolean;
}): number {
  const sensitivity = fine ? 900 : 180;
  return clamp(value + ((lastY - clientY) / sensitivity) * (max - min), min, max);
}

export function getRotaryWheelValue({ value, deltaY, step, min, max, fine = false }: {
  value: number; deltaY: number; step: number; min: number; max: number; fine?: boolean;
}): number {
  const direction = deltaY < 0 ? 1 : -1;
  return clamp(value + direction * step * (fine ? 0.2 : 1), min, max);
}

export function getRotaryPointerValue({ clientX, clientY, rect, min, max }: {
  clientX: number; clientY: number; rect: DOMRect; min: number; max: number;
}): number {
  const centerX = rect.left + rect.width / 2;
  const centerY = rect.top + rect.height / 2;
  const cssAngle = (Math.atan2(clientX - centerX, centerY - clientY) * 180) / Math.PI;
  const clockwise = (cssAngle - 225 + 360) % 360;
  const ratio = clockwise <= 270 ? clockwise / 270 : clientX < centerX ? 0 : 1;
  return clamp(min + ratio * (max - min), min, max);
}

export { clamp };
