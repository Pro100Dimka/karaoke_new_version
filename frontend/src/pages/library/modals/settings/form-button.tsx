import { IconButton, Stack, Typography } from '@neo-ui-kit/react';
import type { FormButtonProps } from '../../../../utils/contracts';

const FormButton = ({ caption, ...props }: FormButtonProps) => (
  <Stack gap={1} align="center" justify="center" style={{ height: '100%' }}>
    <IconButton round {...props} />
    <Typography variant="caption" tone="muted" align="center">
      {caption ?? props.label}
    </Typography>
  </Stack>
);

export default FormButton;
