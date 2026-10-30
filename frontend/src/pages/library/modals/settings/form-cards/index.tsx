import { Grid, tr } from '@neo-ui-kit/react';
import type { FormCardsProps } from '../../../../../utils/contracts';
import FormCard from './card';
const FormCards = ({ blocks, level, children }: FormCardsProps) => (
  <Grid columns={12} gap={3} style={{ height: '100%' }}>
    {Object.entries(blocks).map(
      ([name, { span, show, ...props }]) =>
        show !== false && (
          <Grid key={name} span={span}>
            <FormCard title={tr(name)} level={level} {...props} />
          </Grid>
        ),
    )}
    {children}
  </Grid>
);

export default FormCards;
