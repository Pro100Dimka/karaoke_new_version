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
    style={{ width: '100%', height: '100%', background: '#020104', ...style }}
  >
    <div
      style={{
        // aspectRatio: '1342 / 1063',
        width: '100%',
        height: '100%',
        background: color,
        mask: `url(${atmosphereUrl}) center / 100% 100% no-repeat`,
      }}
    />
  </div>
);
export default SettingsAtmosphere;
