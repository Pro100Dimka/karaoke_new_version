import type { ComponentProps } from 'react';
import atmosphereUrl from '../../../../assets/backgrounds/modal.webp';

const SettingsAtmosphere = ({
  color = 'var(--ad-primary)',
  style,
  ...props
}: ComponentProps<'div'>) => (
  <div
    {...props}
    aria-hidden
    style={{
      width: '100%',
      height: '100%',
      background: 'var(--ad-neutral-950)',
      ...style,
    }}
  >
    <div
      style={{
        width: '100%',
        height: '100%',
        background: color,
        opacity: 0.24,
        mask: `url(${atmosphereUrl}) center / 100% 100% no-repeat`,
      }}
    />
  </div>
);
export default SettingsAtmosphere;
