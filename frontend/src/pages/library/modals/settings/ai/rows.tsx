import { Button, FilePicker, IconButton, Stack, tr } from '@neo-ui-kit/react';
import type { FormBlock, SettingsForm } from '../../../../../utils/contracts';

export const blocks = (
  form: SettingsForm,
  chooseFolder: () => void,
  choosingFolder: boolean,
  exportLibrary: () => void,
  importLibrary: (file: File) => void,
  transferring: boolean,
) =>
  ({
    processing: {
      span: { base: 'full' },
      icon: 'chip',
      fields: [
        {
          name: 'ai.backend',
          kind: 'select',
          label: tr('aiProcessingBackend'),
          span: { base: 'full', sm: 6 },
          props: {
            disabled: form.values.ai.savingBackend,
            options: [
              { value: 'Local', label: tr('aiBackendLocal') },
              { value: 'Kaggle', label: tr('aiBackendKaggle') },
            ],
          },
        },
        {
          name: 'ai.transferToLibraryPath',
          label: tr('transferToLibraryPath'),
          span: { base: 'full', sm: 6 },
          props: {
            disabled: true,
            endAdornment: (
              <IconButton
                size="xs"
                icon="folder"
                label={tr('selectFolder')}
                disabled={choosingFolder}
                onClick={chooseFolder}
              />
            ),
          },
        },
      ],
    },
    importExport: {
      span: { base: 'full' },
      icon: 'chip',
      description: tr('libraryArchiveHint'),
      children: (
        <Stack direction="row" gap={2} wrap>
                    <Button
            icon="download"
            disabled={transferring}
            onClick={exportLibrary}
            style={{ flex: 1 }}
            label={tr('libraryExport')}
          />
                    <FilePicker
            className="library-import-picker"
            icon="upload"
            label={tr('libraryImport')}
            style={{ flex: 1, width: '100%' }}
            accept=".zip"
            disabled={transferring}
            onFiles={(files) => { if (files[0]) importLibrary(files[0]); }}
          />
        </Stack>
      ),
    },
  }) satisfies Record<string, FormBlock>;
