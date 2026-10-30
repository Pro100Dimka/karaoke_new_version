import { Grid, tr } from '@neo-ui-kit/react';
import { observer } from 'mobx-react-lite';
import type { SettingsPanelProps } from '../../../../../utils/contracts';
import FormCards from '../form-cards';
import FormCard from '../form-cards/card';
import { blocks } from './rows';

const AppearancePanel = observer(({ form }: SettingsPanelProps) => {
  const {
    theme: { span, ...theme },
    ...settings
  } = blocks(form);
  return (
    <Grid columns={12} gap={3}>
      <Grid span={span}>
        <FormCard title={tr('theme')} {...theme} />
      </Grid>
      <Grid span={{ base: 'full', md: 9, lg: 8 }}>
        <FormCards blocks={settings} />
      </Grid>
    </Grid>
  );
});

export default AppearancePanel;
