import { Card, Grid } from '@neo-ui-kit/react';
import { memo } from 'react';
import type { ModelCardProps } from '../../../../../utils/contracts';
import ModelDownload from './model-download';

const modelIcons = {
  ASR: 'mic',
  Alignment: 'timer',
  Separation: 'sliders',
  Pitch: 'wave',
} as const;

const ModelCard = memo((props: ModelCardProps) => (
  <Grid span={{ base: 'full', md: 4 }}>
    <Card
      border
      title={props.model.modelId}
      icon={modelIcons[props.model.purpose]}
      style={{
        height: '100%',
        background: 'transparent',
        display: 'flex',
        flexDirection: 'column',
      }}
    >
      <ModelDownload {...props} />
    </Card>
  </Grid>
));

export default ModelCard;
