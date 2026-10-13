/**
 * The kit sizes a RotaryKnob as min(diameter, 100% of its parent). Inside a wrapper that takes its width
 * from its content (the microphone with its monitoring button, the master volume beside its icon, an auto grid column) that 100 %
 * collapses the knob, so such knobs keep their full diameter explicitly.
 */
export const fixedKnobWidth = (diameter: number) => ({
  width: `${diameter / 16}rem`,
});
