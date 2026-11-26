import { app, dialog } from 'electron';
import { createHash } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { transferConsents, type TransferPurpose } from './PrivacySettings';
import { roomServerRequest } from './RoomServerTransport';
import { withDevice } from './SocialIdentity';
import { shellLanguages, shellText } from './ShellText';

export const requestFileDeclaration = async (
  purpose: TransferPurpose,
  resource: string,
): Promise<string> => {
  const choices = transferConsents();
  if (
    ![choices.online, choices[purpose]].every(
      (choice) => choice.enabled && !choice.pending,
    )
  )
    throw new Error(
      'Enable the separate transfer consent in Privacy settings first',
    );
  const locale = (process.env.AD_VOICE_LANGUAGE ?? app.getLocale()).split(
    '-',
  )[0];
  const language = shellLanguages.find((value) => value === locale) ?? 'en';
  const text = (key: Parameters<typeof shellText>[1]) =>
    shellText(language, key);
  const { response } = await dialog.showMessageBox({
    type: 'question',
    title: text('uploadDataTitle'),
    message: text('uploadDataNotice'),
    detail: text('uploadDataOthers'),
    buttons: [
      text('uploadDataCancel'),
      text('uploadDataOwn'),
      text('uploadDataNone'),
      text('uploadDataThirdParty'),
    ],
    defaultId: 0,
    cancelId: 0,
    noLink: true,
  });
  const category = ['', 'own', 'nonpersonal', 'others'][response];
  if (!category) throw new Error('File upload was cancelled');
  let evidence = '';
  if (category === 'others') {
    const selected = await dialog.showOpenDialog({
      title: text('uploadDataEvidence'),
      properties: ['openFile'],
    });
    const file = selected.filePaths[0];
    if (selected.canceled || !file)
      throw new Error('File upload was cancelled');
    const hash = createHash('sha256');
    for await (const chunk of createReadStream(file)) hash.update(chunk);
    evidence = 'sha256:' + hash.digest('hex');
  }
  if (
    ![transferConsents().online, transferConsents()[purpose]].every(
      (choice) => choice.enabled && !choice.pending,
    )
  )
    throw new Error('Transfer consent was withdrawn');
  const result = await roomServerRequest(
    await withDevice({
      method: 'POST',
      path: '/social/privacy/files',
      body: { purpose, resource, category, evidence },
    }),
  );
  const body = result.body;
  if (
    !result.ok ||
    !body ||
    typeof body !== 'object' ||
    !('ticket' in body) ||
    typeof body.ticket !== 'string'
  )
    throw new Error('The data declaration could not be recorded');
  return body.ticket;
};
