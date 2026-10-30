import { ThemeProvider } from '@neo-ui-kit/react';
import { observer } from 'mobx-react-lite';
import { type PropsWithChildren } from 'react';
import { fonts } from '../../utils/consts';
import { store } from '../store';
import './styles.css';

const ThemeConfig = observer(({ children }: PropsWithChildren) => {
  const { library, background } = store.currentTheme;
  const { headingFont, textFont } = store.interface;
  return (
    <ThemeProvider
      theme={library}
      style={{
        '--app-background': `url("${background}")`,
        '--app-font-heading': fonts[headingFont][1],
        '--app-font-text': fonts[textFont][1],
      }}
      className="main-theme"
    >
      {children}
    </ThemeProvider>
  );
});

export default ThemeConfig;
